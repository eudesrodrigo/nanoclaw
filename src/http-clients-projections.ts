import { log } from './log.js';

/**
 * A rule trims one command's payload to the fields an answer needs.
 * Re-measured on 2026-08-09 against live `--profile eudes` calls, after
 * adding a `currency` key wherever an amount is kept (raw CLI stdout bytes ->
 * JSON.stringify bytes of the projected `data`; position values fluctuate
 * day to day, so raw byte counts differ from the 2026-08-08 measurement):
 *   fetch-identity-positions           62,822 -> 2,294 bytes (15 positions)
 *   fetch-all-accounts                 37,904 -> 1,647 bytes (15 accounts)
 *   fetch-account-combined-financials   2,215 ->   401 bytes (3 accounts)
 *   fetch-credit-card-latest-statement    786 ->   136 bytes (no currency in payload)
 *   fetch-credit-card-account           1,531 ->   176 bytes (no currency in payload)
 * The dropped fields are logo_url, security_groups, features, a 20-field
 * quote, account owner/upgrade/restriction graphs, and card numbers.
 *
 * No costco/* rule ships in this release: `http-clients costco receipts
 * --profile eudes` failed with `AuthenticationError: HTTP Error 400` (expired
 * refresh token), so there is no live payload to read paths from. Do not add
 * a Costco rule from the CLI's --help text or the skill docs — neither is a
 * real response.
 */
export type ProjectionRule = {
  /** Path to unwrap on each array element, e.g. 'node' for GraphQL edges. */
  each?: string;
  /** Output key -> source path. Path syntax is dots and [n]. */
  fields: Record<string, string>;
};

export const PROJECTIONS: Record<string, ProjectionRule> = {
  'wealthsimple/fetch-identity-positions': {
    each: 'node',
    fields: {
      sym: 'security.stock.symbol',
      // The whole array, not accounts[0].id. All 15 observed positions had
      // exactly one account, but that is a sample and not a contract — a
      // dropped second account would corrupt the per-account cash maths.
      accounts: 'accounts',
      qty: 'quantity',
      value: 'total_value.amount',
      book: 'book_value.amount',
      ret: 'unrealized_returns.amount',
      // total_value.currency, book_value.currency and unrealized_returns.currency
      // were identical (CAD) on all 15 observed positions, so one shared key
      // covers value/book/ret. This is deliberately NOT security.currency: a
      // USD-traded security (e.g. AAPL) can be valued in CAD, and an agent
      // that assumes value/book/ret are in the security's trading currency
      // states a wrong figure about money.
      currency: 'total_value.currency',
    },
  },

  // Observed via `http-clients wealthsimple fetch-all-accounts --profile
  // eudes` (15 accounts, cursor/node pagination edges). No amount field is
  // kept here — `currency` below is the account's own currency, already
  // present as a direct field, not derived from an amount's sibling.
  'wealthsimple/fetch-all-accounts': {
    each: 'node',
    fields: {
      id: 'id',
      nickname: 'nickname',
      type: 'unified_account_type',
      currency: 'currency',
      status: 'status',
    },
  },

  // Observed via `http-clients wealthsimple fetch-account-combined-financials
  // --profile eudes --ids <id> ...`. Payload is a bare array of
  // { id, financials: { current_combined: {...} } } — no node/cursor wrapper.
  'wealthsimple/fetch-account-combined-financials': {
    fields: {
      id: 'id',
      deposits: 'financials.current_combined.net_deposits_v2.amount',
      value: 'financials.current_combined.net_liquidation_value_v2.amount',
      ret: 'financials.current_combined.simple_returns.amount.amount',
      rate: 'financials.current_combined.simple_returns.rate',
      // net_deposits_v2.currency, net_liquidation_value_v2.currency and
      // simple_returns.amount.currency were identical (CAD) on all 3
      // observed accounts, so one shared key covers deposits/value/ret.
      // `rate` is a ratio, not an amount, so it has no currency of its own.
      currency: 'financials.current_combined.net_liquidation_value_v2.currency',
    },
  },

  // Observed via `http-clients wealthsimple fetch-credit-card-latest-statement
  // --profile eudes --id <credit-card-account-id>`. Payload is a single
  // object, not an array — no `each` unwrap. No field in this payload has a
  // sibling `currency` key (checked on 2026-08-09) — every amount is a bare
  // decimal string with no adjoining currency anywhere in the response, so
  // none is added here.
  'wealthsimple/fetch-credit-card-latest-statement': {
    fields: {
      id: 'id',
      balance: 'latest_statement.statement_balance',
      outstanding: 'latest_statement.statement_balance_outstanding',
      min: 'latest_statement.minimum_payment_due',
      due: 'latest_statement.payment_due_date',
      status: 'latest_statement.payment_status',
    },
  },

  // Observed via `http-clients wealthsimple fetch-credit-card-account
  // --profile eudes --id <credit-card-account-id>`. Payload is a single
  // object. current_cards/cards (card numbers) and preferences are dropped
  // deliberately — they are not just verbose, they're sensitive. No field in
  // this payload has a sibling `currency` key (checked on 2026-08-09) — the
  // response has no currency anywhere, so none is added here.
  'wealthsimple/fetch-credit-card-account': {
    fields: {
      id: 'id',
      status: 'status',
      limit: 'credit_limit',
      current: 'balance.current',
      outstanding: 'balance.outstanding',
      available: 'balance.available_credit_limit',
      pending: 'balance.pending',
      statement_day: 'statement_day_of_month',
    },
  },
};

const SEGMENT = /[^.[\]]+/g;

export function resolvePath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.match(SEGMENT) ?? []) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function pickFields(source: unknown, rule: ProjectionRule): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(rule.fields)) {
    // Values are copied, never coerced. Amounts are decimal strings and one
    // observed book value carried 28 decimal places.
    const value = resolvePath(source, path);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function projectPayload(payload: unknown, rule: ProjectionRule): unknown {
  if (Array.isArray(payload)) {
    return payload.map((element) => pickFields(rule.each ? resolvePath(element, rule.each) : element, rule));
  }
  return pickFields(payload, rule);
}

/**
 * A rule that matches nothing returns `{}`, which the agent reads as "this
 * profile holds nothing" — indistinguishable from a true empty result. That is
 * how an upstream schema change would present: quietly, as missing money. Warn
 * so the break shows up in the log instead of only in a wrong answer.
 */
function warnIfEmptied(key: string, profile: string, source: unknown, projected: unknown): void {
  const sourceIsEmpty =
    source === null || source === undefined || (Array.isArray(source) ? source.length === 0 : source === '');
  if (sourceIsEmpty) return;

  const entries = Array.isArray(projected) ? projected : [projected];
  if (entries.length === 0) return;
  const allEmpty = entries.every((e) => e !== null && typeof e === 'object' && Object.keys(e).length === 0);
  if (allEmpty) log.warn('http-clients projection kept no fields — upstream shape may have changed', { key, profile });
}

function projectProfiles(payload: Record<string, unknown>, rule: ProjectionRule, key: string): Record<string, unknown> {
  // Partial multi-profile shape: project inside `results`, never inside
  // `errors` — an error entry is already small and the agent needs it intact.
  const results = payload.results;
  if (results && typeof results === 'object' && !Array.isArray(results)) {
    // Use Object.create(null) to avoid __proto__ setter hijacking data-derived keys.
    const projected: Record<string, unknown> = Object.create(null);
    for (const [profile, data] of Object.entries(results as Record<string, unknown>)) {
      projected[profile] = projectPayload(data, rule);
      warnIfEmptied(key, profile, data, projected[profile]);
    }
    return { ...payload, results: projected };
  }

  // Use Object.create(null) to avoid __proto__ setter hijacking data-derived keys.
  const out: Record<string, unknown> = Object.create(null);
  for (const [profile, data] of Object.entries(payload)) {
    out[profile] = projectPayload(data, rule);
    warnIfEmptied(key, profile, data, out[profile]);
  }
  return out;
}

/**
 * Trim a successful response in place of its raw payload, and mark it so the
 * agent knows the payload is trimmed. A silent trim is a trap: without the
 * marker the agent cannot know a field was removed, so it cannot know to
 * re-run with `raw: true`.
 */
export function applyProjection(service: string | undefined, command: string | undefined, result: object): object {
  if (!service || !command) return result;

  const envelope = result as Record<string, unknown>;
  if (envelope.status !== 'ok') return result;

  const data = envelope.data;
  // A listing is a plain string, and a bare array is not the profile-keyed
  // shape every command returns. Neither is projectable.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;

  const key = `${service}/${command}`;
  const rule = PROJECTIONS[key];
  if (!rule) return result;

  try {
    return { ...envelope, projected: key, data: projectProfiles(data as Record<string, unknown>, rule, key) };
  } catch (err) {
    // A projection bug must never turn a working call into a failure.
    log.error('http-clients projection failed, returning raw payload', { err, key });
    return result;
  }
}
