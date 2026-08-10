/**
 * Host-side arithmetic over a projected http-clients payload.
 *
 * Why this exists: measured in production on 2026-08-09, the answer turn of a
 * consolidated-allocation question cost 135s of a 231s reply — 59% of the
 * whole thing. It was spent summing 28-decimal-place strings per symbol and
 * per account inside thinking tokens. The endpoint generates at ~34 tokens/s,
 * so arithmetic done by the model is the single most expensive way to add two
 * numbers in this system.
 *
 * The host does the arithmetic. The agent chooses the scope. Nothing here
 * knows a person, an account nickname or a default set of accounts — every
 * filter arrives as a caller argument, because scope is a conversation
 * argument and never host policy.
 *
 * All maths is exact. Amounts are decimal strings, one observed book value
 * carried 28 decimal places, and IEEE 754 cannot hold them: 0.1 + 0.2 is
 * 0.30000000000000004. Everything below scales to BigInt instead.
 */

export type AggregateSpec = {
  /** Field on each projected row whose value names the group, e.g. `sym`. */
  group_by: string;
  /** Numeric-string fields to total. Defaults to `['value']`. */
  sum?: string[];
  /** Keep only rows touching one of these account ids. Omit to keep all. */
  accounts?: string[];
  /** Keep only these profile keys. Omit to keep all. */
  profiles?: string[];
};

type Decimal = { unscaled: bigint; scale: number };

const DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;

function parse(text: string): Decimal | null {
  const trimmed = text.trim();
  if (!DECIMAL_RE.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const body = trimmed.replace(/^[+-]/, '');
  const dot = body.indexOf('.');
  const digits = dot === -1 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const scale = dot === -1 ? 0 : body.length - dot - 1;
  const unscaled = BigInt(digits) * (negative ? -1n : 1n);
  return { unscaled, scale };
}

const TEN = 10n;

function rescale(value: Decimal, scale: number): bigint {
  return value.unscaled * TEN ** BigInt(scale - value.scale);
}

function align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return { a: rescale(a, scale), b: rescale(b, scale), scale };
}

/**
 * Render an exact value, with trailing fractional zeros removed. A 28-place
 * payload value that is really 85371.22 must read as `85371.22`, or the agent
 * copies the noise into the answer.
 */
function format(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  let digits = (negative ? -unscaled : unscaled).toString();
  if (scale === 0) return (negative ? '-' : '') + digits;
  digits = digits.padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fraction ? `.${fraction}` : '');
}

/** Exact sum of two decimal strings. Throws on anything that is not one. */
export function addDecimal(left: string, right: string): string {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error(`not a decimal: ${!a ? left : right}`);
  const aligned = align(a, b);
  return format(aligned.a + aligned.b, aligned.scale);
}

/**
 * `part / total` as a percentage with two decimal places, rounded half away
 * from zero. Returns null when the total is zero — a share of nothing has no
 * value, and 0 would read as a real answer.
 */
export function divideToPercent(part: string, total: string): string | null {
  const p = parse(part);
  const t = parse(total);
  if (!p || !t) throw new Error(`not a decimal: ${!p ? part : total}`);
  const aligned = align(p, t);
  if (aligned.b === 0n) return null;
  // Two decimal places of a percentage = part * 100 * 100 / total.
  const numerator = aligned.a * 10000n;
  const negative = numerator < 0n !== aligned.b < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = aligned.b < 0n ? -aligned.b : aligned.b;
  const rounded = (absNum * 2n + absDen) / (absDen * 2n);
  return format(negative ? -rounded : rounded, 2);
}

type Row = Record<string, unknown>;

function profileRows(data: Record<string, unknown>, profiles?: string[]): Row[] | string {
  // `results` is the partial multi-profile shape; the projection preserves it.
  const source =
    data.results && typeof data.results === 'object' && !Array.isArray(data.results)
      ? (data.results as Record<string, unknown>)
      : data;

  const rows: Row[] = [];
  for (const [profile, value] of Object.entries(source)) {
    if (profiles && !profiles.includes(profile)) continue;
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) rows.push(entry as Row);
    }
  }
  if (rows.length === 0) return 'no rows to aggregate';
  return rows;
}

function touchesAccount(row: Row, wanted: Set<string>): boolean {
  const field = row.accounts;
  if (Array.isArray(field)) return field.some((id) => wanted.has(String(id)));
  if (field === null || field === undefined) return false;
  return wanted.has(String(field));
}

/**
 * Group, filter and total a projected payload in place of its rows. The
 * envelope keeps `status` and `projected`, and gains `aggregated` so the agent
 * can see the payload is derived rather than fetched.
 *
 * Any problem returns the original payload plus `aggregate_error`. A silent
 * fallback would hand back plausible numbers computed from the wrong rows,
 * which is the one failure this whole file exists to prevent.
 */
export function applyAggregate(result: object, spec: AggregateSpec): object {
  const envelope = result as Record<string, unknown>;
  if (envelope.status !== 'ok') return result;

  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;

  const fail = (message: string): object => ({ ...envelope, aggregate_error: message });

  const groupBy = spec.group_by;
  if (!groupBy) return fail('aggregate needs group_by');
  const sumFields = spec.sum && spec.sum.length > 0 ? spec.sum : ['value'];

  const collected = profileRows(data as Record<string, unknown>, spec.profiles);
  if (typeof collected === 'string') return fail(collected);

  const wanted = spec.accounts ? new Set(spec.accounts.map(String)) : null;
  const matched = wanted ? collected.filter((row) => touchesAccount(row, wanted)) : collected;

  if (!matched.some((row) => row[groupBy] !== undefined)) {
    return fail(`no row has the field "${groupBy}"`);
  }

  const groups = new Map<string, Record<string, string>>();
  const currencies = new Set<string>();

  for (const row of matched) {
    const key = row[groupBy] === undefined || row[groupBy] === null ? '(none)' : String(row[groupBy]);
    const totals = groups.get(key) ?? Object.fromEntries(sumFields.map((f) => [f, '0']));
    for (const field of sumFields) {
      const raw = row[field];
      if (raw === undefined || raw === null) continue;
      if (typeof raw !== 'string' && typeof raw !== 'number') return fail(`field "${field}" is not a number`);
      try {
        totals[field] = addDecimal(totals[field], String(raw));
      } catch {
        return fail(`field "${field}" is not a number: ${String(raw).slice(0, 40)}`);
      }
    }
    groups.set(key, totals);
    if (typeof row.currency === 'string') currencies.add(row.currency);
  }

  const primary = sumFields[0];
  let total = '0';
  for (const totals of groups.values()) total = addDecimal(total, totals[primary]);

  // Sort the groups first, then render. Sorting the rendered rows would mean
  // indexing them by a runtime field name, which no static type can describe.
  const rows = [...groups.entries()]
    .sort(([keyA, a], [keyB, b]) => {
      const left = parse(a[primary]);
      const right = parse(b[primary]);
      if (!left || !right) return 0;
      const aligned = align(left, right);
      return aligned.b > aligned.a ? 1 : aligned.b < aligned.a ? -1 : keyA.localeCompare(keyB);
    })
    .map(([key, totals]) => ({ key, ...totals, pct: divideToPercent(totals[primary], total) }));

  return {
    ...envelope,
    aggregated: {
      group_by: groupBy,
      sum: sumFields,
      ...(spec.accounts ? { accounts: spec.accounts.length } : {}),
      ...(spec.profiles ? { profiles: spec.profiles } : {}),
      matched: matched.length,
      rows: rows.length,
    },
    data: {
      total,
      // One currency only when every matched row agrees. Two currencies summed
      // into one number is a wrong statement about money, so say nothing.
      currency: currencies.size === 1 ? [...currencies][0] : null,
      rows,
    },
  };
}
