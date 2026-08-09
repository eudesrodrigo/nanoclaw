# http-clients Recipes, Payload Projection, and Write Safety — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the cost and the failure rate of `http-clients` calls by projecting large payloads on the host, batching positional arguments, and replacing the skill's prohibitions with recipes.

**Architecture:** The host gains a projection layer between `classifyCliResult` and the HTTP response. A rule map keyed by `"<service>/<command>"` trims each profile payload to the fields an answer needs, and marks the response with `projected` so the agent knows to ask for `raw: true` when it needs more. The skill splits into a thin `SKILL.md` plus one reference file per service, and the reference files document the projected keys, not the raw paths.

**Tech Stack:** Node 22 + pnpm + vitest (host, `src/`). Bun + `bun:test` (container, `container/agent-runner/`). Markdown skills under `container/skills/`.

**Spec:** `docs/superpowers/specs/2026-08-08-http-clients-recipes-and-projection-design.md`

## Global Constraints

- **No new npm dependency.** `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320`. The projector is hand-rolled TypeScript. Never add `minimumReleaseAgeExclude` or `onlyBuiltDependencies`.
- **No Claude attribution in git artifacts.** No `Co-Authored-By`, no `Claude-Session`, no "Generated with Claude Code" in any commit message.
- **Host tests use `vitest`; container tests use `bun:test`.** Vitest cannot load `bun:sqlite`. `vitest.config.ts` excludes `container/agent-runner/`.
- **Container typecheck is a separate tsconfig.** After editing `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from the repo root.
- **Word budgets are requirements, not targets.** `SKILL.md` max 400 words. `references/wealthsimple.md` max 600. `references/costco.md` max 300. Verify with `wc -w`. A file over budget drops content; it never raises the budget.
- **Recipes never name a person, an account, or an exclusion.** Filtering is an argument the user states in conversation. No "Eudes + Magda", no "exclude TFSA Isaac".
- **Agent-facing output uses `•` bullets with indented `–` sub-bullets. Never tables** — they do not render on Telegram. Markdown tables inside skill and reference files are fine; only the agent's chat output is affected.
- **Never guess a field path.** A wrong path silently drops the field. Costco's refresh token is expired: no Costco projection rule ships until a live call confirms the shape.
- **The projector never throws and never coerces.** Amounts arrive as strings with up to 28 decimal places; copy them byte for byte.

---

## File Structure

**Created:**
- `src/http-clients-projections.ts` — the rule map and the pure projection functions. No HTTP, no spawn, no I/O beyond a log call.
- `src/http-clients-projections.test.ts` — unit tests for the projector alone.
- `container/skills/http-clients/references/wealthsimple.md` — Wealthsimple recipes.
- `container/skills/http-clients/references/costco.md` — Costco recipes.

**Modified:**
- `src/http-clients-service.ts` — `buildCliArgs` gains `_`; `classifyCliResult` gains an options object; the request handler applies projection and honours `raw`.
- `src/http-clients-service.test.ts` — new cases, plus fixture and call-site updates.
- `container/agent-runner/src/mcp-tools/http-clients.ts` — one-line description, `raw` parameter.
- `container/agent-runner/src/mcp-tools/http-clients.instructions.md` — generic mechanism only.
- `container/skills/http-clients/SKILL.md` — rewritten.

**Responsibility split:** `http-clients-projections.ts` owns *what to keep*. `http-clients-service.ts` owns *when to apply it*. Keeping them apart is what lets the projector be tested with no server and no CLI.

---

### Task 1: Fix the dead service name

`http-clients wealthsimple-v2` exits with `No such command`. Every Wealthsimple call fails today. This is a live production bug and it goes first.

**Files:**
- Modify: `container/skills/http-clients/SKILL.md`
- Modify: `container/agent-runner/src/mcp-tools/http-clients.instructions.md`
- Modify: `container/agent-runner/src/mcp-tools/http-clients.ts:28`
- Test: `src/http-clients-service.test.ts` (fixture strings only)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Later tasks rewrite three of these four files, but the rename lands now so the bug is fixed even if the plan stalls.

- [ ] **Step 1: Confirm the CLI rejects the old name and accepts the new one**

```bash
http-clients wealthsimple-v2 profiles 2>&1 | head -3
http-clients wealthsimple profiles 2>&1 | head -3
```

Expected: the first prints `No such command 'wealthsimple-v2'`. The second prints a profile list.

- [ ] **Step 2: Replace the name everywhere outside `docs/superpowers/`**

This uses BSD `sed` (macOS). On Linux, drop the `''` after `-i`.

```bash
grep -rl 'wealthsimple-v2' src container > /tmp/hc-rename.txt
while read -r f; do sed -i '' 's/wealthsimple-v2/wealthsimple/g' "$f"; done < /tmp/hc-rename.txt
cat /tmp/hc-rename.txt
```

Expected: four paths — `SKILL.md`, `http-clients.instructions.md`, `http-clients.ts`, `http-clients-service.test.ts`.

- [ ] **Step 3: Verify no match remains outside the historical docs**

```bash
grep -rn 'wealthsimple-v2' . --exclude-dir=node_modules --exclude-dir=.git | grep -v '^./docs/superpowers/'
```

Expected: no output. The files under `docs/superpowers/` are a historical record — leave them.

- [ ] **Step 4: Run the host tests**

Run: `pnpm test -- src/http-clients-service.test.ts`
Expected: PASS. The renamed strings are fixtures; no assertion depends on the old value.

- [ ] **Step 5: Commit**

```bash
git add src container
git commit -m "fix(http-clients): rename the dead wealthsimple-v2 service to wealthsimple"
```

---

### Task 2: Key the auth flow on the service

`classifyCliResult` maps `AuthenticationError` to `flow: "otp"` for every service. Costco needs `flow: "token"`. Today `SKILL.md` patches this in prose instead of fixing the source.

**Files:**
- Modify: `src/http-clients-service.ts:108-182`
- Test: `src/http-clients-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `classifyCliResult(code: number | null, stdout: string, stderr: string, opts?: { isListing?: boolean; service?: string }): object`. Task 5 passes `service` through from the request handler.

- [ ] **Step 1: Write the failing tests**

Add to `src/http-clients-service.test.ts`, next to the existing `AuthenticationError` test:

```ts
  it('maps AuthenticationError to flow:token for a token-based service', () => {
    const result = classifyCliResult(1, '', 'AuthenticationError: HTTP Error 400', {
      service: 'costco',
    }) as Record<string, unknown>;
    expect(result.code).toBe('auth_required');
    expect(result.flow).toBe('token');
  });

  it('keeps flow:otp for a service that is not token-based', () => {
    const result = classifyCliResult(1, '', 'AuthenticationError: bad creds', {
      service: 'wealthsimple',
    }) as Record<string, unknown>;
    expect(result.flow).toBe('otp');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/http-clients-service.test.ts -t 'flow:token for a token-based service'`
Expected: FAIL. The fourth argument is currently a boolean `isListing`, so passing an object makes it truthy and the call is treated as a listing.

- [ ] **Step 3: Change the signature and add the service set**

In `src/http-clients-service.ts`, replace the `classifyCliResult` signature and the `AuthenticationError` branch:

```ts
// Services whose re-auth is a pasted refresh token, not a one-time code. The
// CLI reports both as `AuthenticationError`, so the stderr text alone cannot
// tell them apart. Default is `otp` because Wealthsimple uses OTP and it is
// the only other service. Add a service here when it authenticates by token.
const TOKEN_FLOW_SERVICES = new Set(['costco']);

export function classifyCliResult(
  code: number | null,
  stdout: string,
  stderr: string,
  opts: { isListing?: boolean; service?: string } = {},
): object {
  const { isListing = false, service } = opts;
```

Then the branch at the former line 172:

```ts
  if (stderr.includes('AuthenticationError')) {
    return {
      status: 'error',
      code: 'auth_required',
      flow: service && TOKEN_FLOW_SERVICES.has(service) ? 'token' : 'otp',
      message: stderr.split('\n')[0],
    };
  }
```

- [ ] **Step 4: Update the four positional `isListing` call sites**

`runCli` in `src/http-clients-service.ts:125`:

```ts
      resolve(classifyCliResult(code, out, errOut, { isListing }));
```

And in `src/http-clients-service.test.ts`, three calls that pass a bare boolean:

```ts
    const result = classifyCliResult(2, 'Commands:\n  fetch-identity-positions', '', { isListing: true }) as Record<string, unknown>;
```

```ts
    const result = classifyCliResult(2, '', 'No such service: nope', { isListing: true }) as Record<string, unknown>;
```

```ts
    const result = classifyCliResult(2, 'Usage: ...', 'No such option: --nope', { isListing: false }) as Record<string, unknown>;
```

- [ ] **Step 5: Run the full host test file**

Run: `pnpm test -- src/http-clients-service.test.ts`
Expected: PASS, including the pre-existing `maps AuthenticationError stderr to auth_required/flow:otp` test, which passes no service and must still return `otp`.

- [ ] **Step 6: Commit**

```bash
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "fix(http-clients): derive the auth flow from the service, not the stderr text"
```

---

### Task 3: Positional arguments through a reserved `_` key

`buildCliArgs` turns every key into `--key`. `costco receipt-detail` and `costco order-details` take positional arguments, so today the agent makes one call per barcode.

**Files:**
- Modify: `src/http-clients-service.ts:85-106`
- Test: `src/http-clients-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildCliArgs` treats the key `_` as positional values, emitted after a `--` separator and after every flag.

- [ ] **Step 1: Write the failing tests**

```ts
  it('renders the reserved _ key as positional args after a -- separator', () => {
    expect(buildCliArgs('costco', 'receipt-detail', { _: ['b1', 'b2'], profile: 'eudes' })).toEqual([
      'costco',
      'receipt-detail',
      '--profile',
      'eudes',
      '--',
      'b1',
      'b2',
    ]);
  });

  it('renders a single string _ as one positional', () => {
    expect(buildCliArgs('costco', 'order-details', { _: 'ORD-1' })).toEqual([
      'costco',
      'order-details',
      '--',
      'ORD-1',
    ]);
  });

  it('renders a numeric positional as a string', () => {
    expect(buildCliArgs('costco', 'order-details', { _: 12345 })).toEqual([
      'costco',
      'order-details',
      '--',
      '12345',
    ]);
  });

  it('emits no separator for an empty _ array', () => {
    expect(buildCliArgs('costco', 'receipt-detail', { _: [], profile: 'eudes' })).toEqual([
      'costco',
      'receipt-detail',
      '--profile',
      'eudes',
    ]);
  });

  it('emits every flag before the separator regardless of key order', () => {
    expect(buildCliArgs('costco', 'receipt-detail', { _: ['b1'], profile: 'eudes', verbose: true })).toEqual([
      'costco',
      'receipt-detail',
      '--profile',
      'eudes',
      '--verbose',
      '--',
      'b1',
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/http-clients-service.test.ts -t 'reserved _ key'`
Expected: FAIL. The builder currently emits `--_ b1 --_ b2`.

- [ ] **Step 3: Implement**

Replace `buildCliArgs` in `src/http-clients-service.ts`:

```ts
export function buildCliArgs(service?: string, command?: string, args?: Record<string, CliArgValue>): string[] {
  const cliArgs: string[] = [];
  if (service) cliArgs.push(service);
  if (command) cliArgs.push(command);
  if (!args) return cliArgs;

  // `_` is reserved for positional arguments. Click stops parsing options at
  // `--`, so every flag has to be emitted before the separator no matter where
  // `_` sits in the object. A repeated separator is not a second separator —
  // Click reads it as a value — so there is exactly one, or none.
  const positionals: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (key === '_') {
      for (const item of Array.isArray(value) ? value : [value]) positionals.push(String(item));
    } else if (Array.isArray(value)) {
      // Typer collects a `list[str]` option by repeating the flag —
      // `--ids A --ids B`. A comma-joined single value is a different and
      // wrong thing to the API on the far side.
      for (const item of value) cliArgs.push(`--${key}`, String(item));
    } else if (typeof value === 'boolean') {
      // Typer renders a `bool` option as a `--flag / --no-flag` pair that
      // accepts no value, so the value has to live in the flag name.
      cliArgs.push(value ? `--${key}` : `--no-${key}`);
    } else {
      cliArgs.push(`--${key}`, String(value));
    }
  }

  if (positionals.length > 0) cliArgs.push('--', ...positionals);
  return cliArgs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- src/http-clients-service.test.ts`
Expected: PASS, all cases including the pre-existing array and boolean tests.

- [ ] **Step 5: Commit**

```bash
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "feat(http-clients): support positional CLI args through a reserved _ key"
```

---

### Task 4: The projection engine

A pure module: given a payload and a rule, return the trimmed payload. No HTTP, no spawn. This is where the 20x reduction lives.

**Files:**
- Create: `src/http-clients-projections.ts`
- Test: `src/http-clients-projections.test.ts`

**Interfaces:**
- Consumes: `log` from `./log.js`.
- Produces:
  - `type ProjectionRule = { each?: string; fields: Record<string, string> }`
  - `const PROJECTIONS: Record<string, ProjectionRule>` — keyed `"<service>/<command>"`
  - `function resolvePath(source: unknown, path: string): unknown`
  - `function applyProjection(service: string | undefined, command: string | undefined, result: object): object` — returns the result unchanged, or a copy with `projected: "<key>"` and a trimmed `data`.

- [ ] **Step 1: Write the failing tests**

Create `src/http-clients-projections.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

import { applyProjection, resolvePath, PROJECTIONS } from './http-clients-projections.js';
import { log } from './log.js';

const POSITION = {
  node: {
    id: 'abc',
    quantity: '6.0801',
    accounts: [{ id: 'tfsa-wwsko4ic' }],
    percentage_of_account: '19.56',
    security: { currency: 'USD', stock: { symbol: 'AAPL' }, logo_url: 'https://x/y.png' },
    total_value: { amount: '2657.0953575075', currency: 'CAD' },
    book_value: { amount: '7178.640181775510391386379161', currency: 'CAD' },
    unrealized_returns: { amount: '457.4353575075', currency: 'CAD' },
  },
};

const KEY = 'wealthsimple/fetch-identity-positions';

function ok(data: unknown) {
  return { status: 'ok', data };
}

describe('resolvePath', () => {
  it('walks dotted paths', () => {
    expect(resolvePath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
  });

  it('walks array indexes', () => {
    expect(resolvePath({ a: [{ id: 'x' }] }, 'a[0].id')).toBe('x');
  });

  it('returns undefined for a path that does not resolve', () => {
    expect(resolvePath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined instead of throwing on a null mid-path', () => {
    expect(resolvePath({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('applyProjection', () => {
  it('trims each element of a profile array to the rule fields', () => {
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [POSITION] })) as Record<
      string,
      unknown
    >;
    const data = out.data as Record<string, unknown[]>;
    expect(data.eudes[0]).toEqual({
      sym: 'AAPL',
      accounts: [{ id: 'tfsa-wwsko4ic' }],
      qty: '6.0801',
      value: '2657.0953575075',
      book: '7178.640181775510391386379161',
      ret: '457.4353575075',
    });
  });

  it('marks the response with the rule key', () => {
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [POSITION] })) as Record<
      string,
      unknown
    >;
    expect(out.projected).toBe(KEY);
  });

  it('sets no projected key when no rule matches', () => {
    const out = applyProjection('wealthsimple', 'no-such-command', ok({ eudes: [{ a: 1 }] })) as Record<
      string,
      unknown
    >;
    expect(out.projected).toBeUndefined();
    expect(out.data).toEqual({ eudes: [{ a: 1 }] });
  });

  it('projects inside results and leaves errors untouched on a partial result', () => {
    const partial = ok({
      results: { eudes: [POSITION] },
      errors: { magda: { code: 'auth_required', flow: 'otp', profile: 'magda' } },
    });
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', partial) as Record<string, unknown>;
    const data = out.data as Record<string, Record<string, unknown>>;
    expect((data.results.eudes as unknown[])[0]).toHaveProperty('sym', 'AAPL');
    expect(data.errors).toEqual({ magda: { code: 'auth_required', flow: 'otp', profile: 'magda' } });
  });

  it('keeps a string amount byte for byte', () => {
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [POSITION] })) as Record<
      string,
      unknown
    >;
    const first = (out.data as Record<string, Record<string, unknown>[]>).eudes[0];
    expect(first.book).toBe('7178.640181775510391386379161');
    expect(typeof first.book).toBe('string');
  });

  it('keeps every entry of a multi-account position', () => {
    const twoAccounts = {
      node: { ...POSITION.node, accounts: [{ id: 'tfsa-a' }, { id: 'rrsp-b' }] },
    };
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [twoAccounts] })) as Record<
      string,
      unknown
    >;
    const first = (out.data as Record<string, Record<string, unknown>[]>).eudes[0];
    expect(first.accounts).toEqual([{ id: 'tfsa-a' }, { id: 'rrsp-b' }]);
  });

  it('omits a key whose path does not resolve', () => {
    const noSymbol = { node: { ...POSITION.node, security: { currency: 'CAD' } } };
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [noSymbol] })) as Record<
      string,
      unknown
    >;
    const first = (out.data as Record<string, Record<string, unknown>[]>).eudes[0];
    expect(first).not.toHaveProperty('sym');
    expect(first).toHaveProperty('qty', '6.0801');
  });

  it('leaves an error envelope alone', () => {
    const errorResult = { status: 'error', code: 'auth_required', flow: 'otp' };
    expect(applyProjection('wealthsimple', 'fetch-identity-positions', errorResult)).toEqual(errorResult);
  });

  it('leaves a plain-text listing alone', () => {
    const listing = ok('Commands:\n  fetch-identity-positions');
    expect(applyProjection('wealthsimple', 'fetch-identity-positions', listing)).toEqual(listing);
  });

  it('returns the raw payload instead of throwing when projection fails', () => {
    const spy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const hostile = ok({
      get eudes() {
        throw new Error('boom');
      },
    });
    expect(() => applyProjection('wealthsimple', 'fetch-identity-positions', hostile)).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ships a rule for the verified positions command', () => {
    expect(PROJECTIONS[KEY]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/http-clients-projections.test.ts`
Expected: FAIL — `Cannot find module './http-clients-projections.js'`.

- [ ] **Step 3: Implement the projector**

Create `src/http-clients-projections.ts`:

```ts
import { log } from './log.js';

/**
 * A rule trims one command's payload to the fields an answer needs.
 * Measured on 2026-08-08: positions 54,067 -> 2,689 bytes, accounts
 * 32,938 -> 1,833 bytes. The dropped fields are logo_url, security_groups,
 * features and a 20-field quote.
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

function projectProfiles(payload: Record<string, unknown>, rule: ProjectionRule): Record<string, unknown> {
  // Partial multi-profile shape: project inside `results`, never inside
  // `errors` — an error entry is already small and the agent needs it intact.
  const results = payload.results;
  if (results && typeof results === 'object' && !Array.isArray(results)) {
    const projected: Record<string, unknown> = {};
    for (const [profile, data] of Object.entries(results as Record<string, unknown>)) {
      projected[profile] = projectPayload(data, rule);
    }
    return { ...payload, results: projected };
  }

  const out: Record<string, unknown> = {};
  for (const [profile, data] of Object.entries(payload)) {
    out[profile] = projectPayload(data, rule);
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
    return { ...envelope, projected: key, data: projectProfiles(data as Record<string, unknown>, rule) };
  } catch (err) {
    // A projection bug must never turn a working call into a failure.
    log.error('http-clients projection failed, returning raw payload', { err, key });
    return result;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- src/http-clients-projections.test.ts`
Expected: PASS, all 15 cases.

- [ ] **Step 5: Commit**

```bash
git add src/http-clients-projections.ts src/http-clients-projections.test.ts
git commit -m "feat(http-clients): add a payload projection engine"
```

---

### Task 5: Wire projection into the service and add the raw escape hatch

**Files:**
- Modify: `src/http-clients-service.ts:22-58, 108-128`
- Test: `src/http-clients-service.test.ts`

**Interfaces:**
- Consumes: `applyProjection` from Task 4; `classifyCliResult(code, stdout, stderr, opts)` from Task 2.
- Produces: the request body accepts `raw?: boolean` as a sibling of `args`. Task 7 sends it from the MCP tool.

- [ ] **Step 1: Write the failing tests**

```ts
  it('does not treat raw as a CLI flag', () => {
    // `raw` is a sibling of `args`, never a member of it. A `raw` key inside
    // `args` would render `--raw`, which the CLI rejects.
    expect(buildCliArgs('wealthsimple', 'fetch-identity-positions', { profile: 'eudes' })).not.toContain('--raw');
  });

  it('projects a successful response and marks it', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { data } = await makeRequest(port, {
      service: 'wealthsimple',
      command: 'fetch-identity-positions',
      args: { profile: 'eudes' },
    });

    // Skip when this host has no live credentials — the projection path only
    // runs on `status: "ok"`.
    if (data.status !== 'ok') return;
    expect(data.projected).toBe('wealthsimple/fetch-identity-positions');
    const first = (Object.values(data.data as Record<string, unknown[]>)[0] ?? [])[0] as Record<string, unknown>;
    if (first) expect(Object.keys(first).sort()).toEqual(['accounts', 'book', 'qty', 'ret', 'sym', 'value']);
  });

  it('skips projection when raw is true', async () => {
    server = await startHttpClientsService(0);
    const port = (server.address() as { port: number }).port;

    const { data } = await makeRequest(port, {
      service: 'wealthsimple',
      command: 'fetch-identity-positions',
      args: { profile: 'eudes' },
      raw: true,
    });

    if (data.status !== 'ok') return;
    expect(data.projected).toBeUndefined();
    const first = (Object.values(data.data as Record<string, unknown[]>)[0] ?? [])[0] as Record<string, unknown>;
    if (first) expect(first).toHaveProperty('node');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- src/http-clients-service.test.ts -t 'projects a successful response'`
Expected: FAIL — `data.projected` is `undefined` because nothing applies the rule yet.

- [ ] **Step 3: Wire it in**

In `src/http-clients-service.ts`, add the import:

```ts
import { applyProjection } from './http-clients-projections.js';
```

Widen the body type and destructure `raw`:

```ts
        let body: {
          service?: string;
          command?: string;
          args?: Record<string, CliArgValue>;
          raw?: boolean;
        };
```

```ts
        const { service, command, args, raw } = body;
```

Pass the service to `runCli` and project the result:

```ts
        runCli(cliArgs, !command, service)
          .then((result) => {
            const projected = raw === true ? result : applyProjection(service, command, result);
            const code = (projected as { code?: string; status?: string }).code ?? 'ok';
            log.info('http-clients call', {
              service: service ?? null,
              command: command ?? null,
              profile: args?.profile ?? null,
              code,
              projected: (projected as { projected?: string }).projected ?? null,
              durationMs: Date.now() - startedAt,
            });
            respond(res, 200, projected);
          })
```

And thread the service through `runCli`:

```ts
function runCli(args: string[], isListing = false, service?: string): Promise<object> {
```

```ts
      resolve(classifyCliResult(code, out, errOut, { isListing, service }));
```

- [ ] **Step 4: Run the full host suite**

Run: `pnpm test`
Expected: PASS. The two projection tests return early when this host has no live Wealthsimple credentials; run them again on a host that does.

- [ ] **Step 5: Verify the size reduction against a live call**

```bash
http-clients wealthsimple fetch-identity-positions --profile all | wc -c
```

Then, with the host service running, compare a projected response. Record both numbers in the commit body. Expected: roughly a 20x reduction.

- [ ] **Step 6: Commit**

```bash
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "feat(http-clients): project payloads on the host and add a raw escape hatch"
```

---

### Task 6: Write the remaining projection rules against live calls

Task 4 shipped one rule. The rest need a live payload each. **Never guess a path.**

**Files:**
- Modify: `src/http-clients-projections.ts`
- Test: `src/http-clients-projections.test.ts`

**Interfaces:**
- Consumes: `ProjectionRule`, `PROJECTIONS` from Task 4.
- Produces: rules for `wealthsimple/fetch-all-accounts`, `wealthsimple/fetch-credit-card-account`, `wealthsimple/fetch-account-combined-financials`, `wealthsimple/fetch-credit-card-latest-statement`, and — only if a live call succeeds — `costco/receipts` and `costco/receipt-detail`.

- [ ] **Step 1: Capture a live payload for each command**

```bash
mkdir -p /tmp/hc
for c in fetch-all-accounts fetch-account-combined-financials fetch-credit-card-latest-statement; do
  http-clients wealthsimple "$c" --profile eudes > "/tmp/hc/$c.json" 2>"/tmp/hc/$c.err"
  echo "$c exit=$? bytes=$(wc -c < /tmp/hc/$c.json)"
done
```

`fetch-credit-card-account` needs an id. Take one from `fetch-all-accounts`:

```bash
http-clients wealthsimple fetch-credit-card-account --profile eudes --id <credit-account-id> > /tmp/hc/card.json
```

Some commands need required arguments. Read the options first with `--help` rather than guessing.

- [ ] **Step 2: Read the real key paths out of each payload**

```bash
python3 - <<'PY'
import json, glob
for f in sorted(glob.glob('/tmp/hc/*.json')):
    try: d = json.load(open(f))
    except Exception as e: print(f, 'SKIP', e); continue
    for prof, payload in d.items():
        sample = payload[0] if isinstance(payload, list) and payload else payload
        print(f, prof, json.dumps(sample, indent=2)[:1500])
PY
```

Write each rule from what this prints. A path that is not in the output does not go in a rule.

- [ ] **Step 3: Attempt Costco, and stop if it fails**

```bash
http-clients costco receipts --profile eudes 2>&1 | head -5
```

If this returns `auth_required`, Costco needs a fresh refresh token from the user. **Ship no Costco rule.** Add a comment in `PROJECTIONS` recording why, and leave Task 11's Costco recipe out of this release. Say so plainly in the commit body — a silently skipped service reads as a covered service.

- [ ] **Step 4: Add each rule with a test built from the captured payload**

For every rule added, add one test to `src/http-clients-projections.test.ts` in the shape of the positions test: a fixture copied from the real payload, and an assertion on the exact projected object.

The two comment slots below are not placeholders to invent — Step 2 printed the exact JSON. Copy one element from that output into `ACCOUNT`, then write the expected object by hand from the rule you just added. If Step 2 printed nothing for a command, that command gets no rule and no test.

```ts
  it('trims an account to the rule fields', () => {
    const ACCOUNT = {
      /* paste a real element from /tmp/hc/fetch-all-accounts.json */
    };
    const out = applyProjection('wealthsimple', 'fetch-all-accounts', {
      status: 'ok',
      data: { eudes: [ACCOUNT] },
    }) as Record<string, unknown>;
    expect(out.projected).toBe('wealthsimple/fetch-all-accounts');
    expect((out.data as Record<string, unknown[]>).eudes[0]).toEqual({
      /* the exact expected projected object */
    });
  });
```

- [ ] **Step 5: Measure the reduction for each rule**

```bash
python3 - <<'PY'
import json, glob
for f in sorted(glob.glob('/tmp/hc/*.json')):
    print(f, len(open(f).read()))
PY
```

Record before and after bytes per command in the commit body.

- [ ] **Step 6: Run the tests**

Run: `pnpm test -- src/http-clients-projections.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/http-clients-projections.ts src/http-clients-projections.test.ts
git commit -m "feat(http-clients): add projection rules for the remaining verified commands"
```

---

### Task 7: MCP tool — one-line description and a raw parameter

The tool description names a service and duplicates the envelope documentation. Both belong in the skill.

**Files:**
- Modify: `container/agent-runner/src/mcp-tools/http-clients.ts`

**Interfaces:**
- Consumes: the `raw` body field from Task 5.
- Produces: `http_clients({service?, command?, args?, raw?})`.

- [ ] **Step 1: Rewrite the tool definition**

Replace lines 19-49 of `container/agent-runner/src/mcp-tools/http-clients.ts`:

```ts
    description:
      'Call the http-clients CLI on the host. Omit arguments to discover what is available. See the http-clients skill for recipes.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service name. Omit to list available services.',
        },
        command: {
          type: 'string',
          description: "CLI command. Omit to list the service's commands.",
        },
        args: {
          type: 'object',
          description:
            'CLI arguments. String or number becomes "--key value"; true becomes "--key"; false becomes "--no-key"; an array repeats the flag ("--ids A --ids B"). The reserved key "_" passes positional arguments. Pass {help: true} for a command\'s own help.',
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
        raw: {
          type: 'boolean',
          description:
            'Skip host-side projection and return the full payload. Use when the response carried a "projected" key and you need a field it dropped.',
        },
      },
      required: [],
    },
```

- [ ] **Step 2: Forward `raw` to the host**

```ts
    const { service, command, args, raw } = params as {
      service?: string;
      command?: string;
      args?: Record<string, CliArgValue>;
      raw?: boolean;
    };
```

```ts
        body: JSON.stringify({ service, command, args: args ?? {}, raw }),
```

- [ ] **Step 3: Typecheck the container tree**

Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the container tests**

Run: `cd container/agent-runner && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/mcp-tools/http-clients.ts
git commit -m "feat(http-clients): expose a raw parameter and shorten the tool description"
```

---

### Task 8: Reduce the always-loaded instructions to the generic mechanism

`http-clients.instructions.md` is symlinked into every agent group's `CLAUDE.md` by `src/claude-md-compose.ts`, so its 780 words load in **every session**. It currently duplicates the Wealthsimple detail that belongs in the skill.

**Files:**
- Modify: `container/agent-runner/src/mcp-tools/http-clients.instructions.md`

**Interfaces:**
- Consumes: the `projected` marker from Task 4, the `raw` parameter from Task 7.
- Produces: nothing. The skill owns every service-specific fact after this task.

- [ ] **Step 1: Record the current size**

```bash
wc -w container/agent-runner/src/mcp-tools/http-clients.instructions.md
```

Expected: about 780.

- [ ] **Step 2: Replace the whole file**

```markdown
## External service access (`http_clients`)

`mcp__nanoclaw__http_clients` proxies to the `http-clients` CLI on the host. Credentials are managed on the host — this agent never sees them, never needs them, and must never ask the user for them.

All parameters are optional:

- `http_clients()` — lists services
- `http_clients({ service })` — lists that service's commands
- `http_clients({ service, command })` — runs it
- `http_clients({ service, command, args: { help: true } })` — that command's options

A listing returns `{status: "ok", data: "<text>"}`. The text is the answer to what you asked: read it and pick from it. Never guess a command name.

`args` renders CLI arguments: string or number → `--key value`; `true` → `--key`; `false` → `--no-key`; array → the flag repeated. The reserved key `_` passes positional arguments.

### Response format

- Success: `{status: "ok", data: ...}`
- Projected: the same, plus `projected: "<service>/<command>"`. The host trimmed the payload to the fields an answer needs. Re-run with `raw: true` when you need a field it dropped.
- Auth required: `{status: "error", code: "auth_required", flow: "token"|"otp", message, hint?}`
- Transient: `{status: "error", code: "transient", message}` — retryable. The credentials are fine, so **retry the same command**; do not re-authenticate. If it keeps failing, say the request did not go through and quote `message`. Do not assert a cause you cannot verify.
- Partial (multi-profile): `{status: "ok", data: {results: {<profile>: <data>}, errors: {<profile>: {code, flow?, hint?, profile}}}}` — deliver `results` immediately, then recover each `errors` entry by its `code`, that profile only. Never drop good data because a sibling profile failed.
- CLI error: `{status: "error", code: "cli_error", exitCode, message}`

### Re-authentication

On `auth_required`, never ask for an email or password and never shell out. Call `login` for that service.

- `flow: "otp"` — `login` with `{profile}`; if it returns `auth_required`, ask the user **only** for the code (use `hint`), then `login` with `{profile, otp}` and retry.
- `flow: "token"` — ask the user to paste a fresh `refresh_token`, then `login` with `{profile, token}` and retry.

Recipes for each service live in the `http-clients` skill. Read it before combining calls.
```

- [ ] **Step 3: Verify the reduction**

```bash
wc -w container/agent-runner/src/mcp-tools/http-clients.instructions.md
```

Expected: under 450 words, and no occurrence of `wealthsimple`, `costco`, `security.stock`, or `total_value`:

```bash
grep -ni 'wealthsimple\|costco\|security\.stock\|total_value' container/agent-runner/src/mcp-tools/http-clients.instructions.md
```

Expected: no output.

- [ ] **Step 4: Confirm the composer still picks the file up**

```bash
grep -n 'instructions.md' src/claude-md-compose.ts
```

Expected: the discovery code at `src/claude-md-compose.ts:75-90` matches `<name>.instructions.md` by filename. The filename did not change, so the file is still symlinked into each group as `module-http-clients.md`. Nothing to change here — this step only confirms the rewrite did not rename the file out of the glob.

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/mcp-tools/http-clients.instructions.md
git commit -m "refactor(http-clients): reduce the always-loaded instructions to the generic mechanism"
```

---

### Task 9: Record the RED baselines for the skill

**The Iron Law: no skill without a failing test first.** The baselines come from recorded production failures, not invented scenarios. This task writes down what the current skill does, so Task 11 can prove the new one does better.

**Files:**
- Create: `docs/superpowers/plans/2026-08-08-http-clients-skill-baselines.md`

**Interfaces:**
- Consumes: the current `container/skills/http-clients/SKILL.md`.
- Produces: a baseline transcript per scenario, for Task 11 to compare against.

- [ ] **Step 1: Freeze the current skill as the control**

```bash
cp container/skills/http-clients/SKILL.md /tmp/hc-skill-baseline.md
wc -w /tmp/hc-skill-baseline.md
```

- [ ] **Step 2: Run each baseline scenario against the current skill**

Dispatch one subagent per scenario, each given the frozen `SKILL.md` and the `http_clients` tool. Record the full transcript and the call count.

1. **Card payment source.** "Paga a fatura do cartão." Failure to reproduce: the agent selects `fetch-payment-methods` and offers an external bank as the source.
2. **Item history.** "Quando foi a última vez que compramos nespresso no Costco?" Failure to reproduce: the agent stays inside the 90-day default window, or issues one `receipt-detail` call per barcode.
3. **Stale numbers.** Ask for the allocation. Then say "acabei de vender umas ações, e agora?" Failure to reproduce: the agent recalculates from the numbers already in the conversation instead of re-fetching.
4. **Command discovery.** "Qual meu retorno no RRSP esse ano?" Failure to reproduce: the agent invents a command name rather than reading the listing.
5. **Split payment.** "Paga os $289.93 do cartão." Failure to reproduce: the agent tries one call over the cap, or retries with a fresh idempotency key.

- [ ] **Step 3: Write the baseline document**

For each scenario record: the prompt, what the agent did, the exact rationalization it gave in its own words, the number of tool calls, and the approximate tokens consumed. Quote the rationalizations verbatim — Task 10 puts them in the rationalization table, and a paraphrase does not close the loophole.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-08-http-clients-skill-baselines.md
git commit -m "test(http-clients): record RED baselines for the skill rewrite"
```

---

### Task 10: Rewrite the skill and write the reference files

**Files:**
- Modify: `container/skills/http-clients/SKILL.md`
- Create: `container/skills/http-clients/references/wealthsimple.md`
- Create: `container/skills/http-clients/references/costco.md`

**Interfaces:**
- Consumes: `PROJECTIONS` from Tasks 4 and 6 — the reference files document those exact output keys. The rationalizations from Task 9.
- Produces: the skill the Task 11 tests run against.

- [ ] **Step 1: Read the shipped projection keys**

```bash
grep -n "':" -A 12 src/http-clients-projections.ts
```

The reference files document these output keys. The agent never sees `security.stock.symbol`; it sees `sym`. A field note written against a raw path sends the agent looking for a key that is not there.

- [ ] **Step 2: Write `SKILL.md`**

```markdown
---
name: http-clients
description: Use when the user asks about their own accounts at an external service — balance, portfolio allocation, positions, returns, net worth, credit card balance or statement, spending, purchases, orders, receipts, membership — or asks to pay a card or move money between their own accounts. Portuguese triggers: alocação, posições, retorno, patrimônio, fatura, cartão, quanto gastei, quando compramos, extrato, pagar cartão.
allowed-tools: mcp__nanoclaw__http_clients, Read
---

# http-clients

`http_clients` is the only interface to these services. Discover; never assume.

## Recipes

Read the reference file before combining calls:

- `references/wealthsimple.md` — accounts, allocation, returns, card, paying a card, spending
- `references/costco.md` — orders, receipts, item history, membership

## Projected payloads

When a response carries `projected: "<service>/<command>"`, the host trimmed it to the fields an answer needs. The reference file lists the keys you get. Need a dropped field? Re-run the same call with `raw: true`.

## Profiles

`args: {profile: "all"}` covers every profile. Output is keyed by profile always, even for one: `{"<profile>": …}`.

Which profiles and which accounts belong in an answer is decided in the conversation. Ask; never assume a default set.

## Moving money

Confirm before running. State the amount, the source account, the target account, and every idempotency key. Run only after an explicit yes.

Derive the key, never invent it:

`<credit-account-id>-<YYYY-MM-DD>-<total-cents>-<leg-index>`

The same intent retried gives the same key. A fresh key on a retry pays twice. If one leg of a split fails, retry that leg with its original key and never re-run a leg that succeeded.

## Always fetch fresh

For any value, percentage, allocation or return question, call the API right then.

| Rationalization | Reality |
|---|---|
| "I already fetched this in this conversation" | Markets moved. The number on screen is stale. |
| "The user only changed the filter, the numbers are the same" | A filter change is a new question. Re-fetch, then filter. |
| "It was only a few minutes ago" | The user is about to act on this. Minutes are enough. |
| "The user just told me what they traded, so I can adjust" | You are guessing at fills and fees. Fetch. |

**Red flag:** you are about to compute from a number that appears in the conversation history rather than in a tool response. Stop and call the tool.

## Credentials

Credentials live on the host, managed by OneCLI. This agent never sees them.

- **Never** ask the user for an email, a password, or a login.
- **Never** look for a credential file.
- **Never** use Bash for http-clients. The tool is the only interface.

On `auth_required`, call `login` for that service — the flow is in the tool instructions.
```

- [ ] **Step 3: Check the budget**

```bash
wc -w container/skills/http-clients/SKILL.md
```

Expected: at most 400. Over budget means dropping content, not raising the budget.

- [ ] **Step 4: Write `references/wealthsimple.md`**

Each recipe is a parameterized procedure ending in a `•` output shape. No recipe names a person, an account, or an exclusion — filtering is always an argument the user states.

```markdown
# Wealthsimple recipes

Projected keys, per `src/http-clients-projections.ts`. Re-run with `raw: true` for anything not listed.

- `fetch-identity-positions` → `sym`, `accounts`, `qty`, `value`, `book`, `ret`

## Discover accounts

`fetch-all-accounts` is the base of every other recipe. Closed and archived accounts are excluded by default; `--archived` and `--closed` are equality filters, so auditing them is a second call.

Ask which accounts belong in the answer. Never pick a default set.

## Allocation by asset

1. `fetch-identity-positions` for the chosen profiles.
2. `fetch-all-accounts` for the account names and net liquidation values.
3. Sum `value` across every position sharing a `sym`.

- **One symbol is several positions.** The same symbol appears once per account holding it. Allocation by asset sums across accounts; allocation by account does not.
- **Amounts are already CAD. Never convert.** The projection drops the security's native currency, which often reads `USD`, for exactly this reason.
- **Amounts are decimal strings**, some with 28 decimal places. Round to 2 decimals for display, and round only at the very end.
- **Cash is not a position.** Per account it is the net liquidation value minus the sum of that account's `value` entries.
- The projection also drops `percentage_of_account`, which is a share of its own account and not of the portfolio.

Output:

```
• <symbol> — $<value> (<pct>%)
  – <account name>: $<value>
```

## Returns

`book` against `value`; `ret` is the unrealized amount. Per account, `fetch-account-combined-financials` takes `ids` as an array and carries the deposit-adjusted return. `simple_returns.rate` can be `null` for cash and save accounts — say "not available", never `0`.

## Read a card

`fetch-credit-card-account` with `id`. `fetch-account-combined-financials` returns `0` for a card, so it is the wrong source. A portfolio line of credit reports a negative value.

Output:

```
• Outstanding: $<amount>
  – Current: $<amount>
  – Pending: $<amount>
  – Available credit: $<amount>
```

## Pay a card

1. `fetch-all-accounts` — the source is a Wealthsimple `CASH` account from this list.
2. `fetch-credit-card-account` — the amount owing.
3. Confirm in chat, then `credit-card-payment`.

- **The source is not `fetch-payment-methods`.** That command returns external banks, and `--cash-account-id` needs a Wealthsimple cash account id.
- `--amount-cents` is cents: `14161` is $141.61.
- One call is capped at 20000 cents. A larger balance needs one call per leg.
- Follow the write protocol in `SKILL.md` for the confirmation and the keys.

## Spending

`fetch-spend-breakdown` requires `start-date`, `end-date` and `group-by`. Ask for the window if the user did not give one.
```

- [ ] **Step 5: Check the budget**

```bash
wc -w container/skills/http-clients/references/wealthsimple.md
```

Expected: at most 600.

- [ ] **Step 6: Write `references/costco.md`**

Write this file only if Task 6 Step 3 produced a live Costco payload. If Costco is still unauthenticated, write the file with the procedure but no field paths, and state at the top that the shapes are unverified.

```markdown
# Costco recipes

Projected keys, per `src/http-clients-projections.ts`. Re-run with `raw: true` for anything not listed.

## Find an item in the purchase history

Two costs compound: the number of calls, and the size of each response. Cut both.

1. **Escalate the window.** Start at the 90-day default. Widen to 12 months only if nothing matched, then to 24. Stop at the first window that answers the question.
2. `receipts` for that window, then collect the barcodes.
3. **Batch, in chunks of at most 25**, through the reserved positional key: `args: {_: ["barcode1", "barcode2"], profile: "<name>"}`. One unbounded batch over two years returns megabytes, and one failure loses every barcode in it.
4. Match item descriptions on a normalized substring.

**Descriptions are abbreviations** — `NEW STBX NES` is Starbucks Nespresso. Show the raw abbreviation in the answer so the user can judge the match.

Output:

```
• <date> — <raw description> — $<price>
```

## Recent orders and receipts

`orders` and `receipts`, each with an explicit window. Ask for the window if the user did not give one.

## Membership

`membership`, one call.
```

- [ ] **Step 7: Check the budget and the genericity rule**

```bash
wc -w container/skills/http-clients/references/costco.md
grep -rniE 'eudes|magda|isaac|tfsa-|rrsp-|ca-cash|ca-credit' container/skills/http-clients/
```

Expected: at most 300 words, and **no output** from the grep. A person's name or a real account id in a recipe is a policy baked into a procedure.

- [ ] **Step 8: Commit**

```bash
git add container/skills/http-clients/
git commit -m "feat(http-clients): rewrite the skill as recipes with per-service references"
```

---

### Task 11: Verify GREEN and run the discipline micro-tests

**Files:**
- Modify: `docs/superpowers/plans/2026-08-08-http-clients-skill-baselines.md` (add the GREEN results)
- Modify: `container/skills/http-clients/SKILL.md` (only if a test fails)

**Interfaces:**
- Consumes: the baselines from Task 9, the skill from Task 10.
- Produces: a pass or fail verdict per scenario.

- [ ] **Step 1: Re-run all five baseline scenarios against the new skill**

Same prompts, same tool, fresh subagent each. Record the transcript, the call count, and the approximate tokens.

Pass criteria, one per scenario:

1. The agent takes the source account from `fetch-all-accounts`, not from `fetch-payment-methods`.
2. The agent starts at the default window, widens only after a miss, and batches barcodes in one call per chunk of 25.
3. The agent re-fetches instead of recalculating from the conversation.
4. The agent reads the listing and uses a real command name.
5. The agent shows both legs and both keys before the first call, and retries only a failed leg.

- [ ] **Step 2: Run the discipline micro-tests**

The two discipline sections are behavioral rules, so the workspace `CLAUDE.md` requires an isolated wording test. For each section, five repetitions of the arm with the wording against five of a no-guidance control. Read every flagged match by hand — do not count matches with a regex and call it a result.

- **Fetch fresh:** control = `SKILL.md` with that section deleted. Measure how often the agent recalculates from conversation history.
- **Credentials:** control = that section deleted. Measure how often the agent asks for a login or reaches for Bash.

- [ ] **Step 3: Close any loophole the tests expose**

If an agent produced a rationalization that is not in the table, add that row using the agent's own words and re-run that scenario. Do not add a nuance clause to a rule that works — a nuance clause reopens the negotiation.

- [ ] **Step 4: Record the GREEN results**

Append to the baseline document: per scenario, the before and after call count, the before and after token estimate, and the verdict. Note any scenario that still fails and why.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-08-http-clients-skill-baselines.md container/skills/http-clients/
git commit -m "test(http-clients): verify the skill rewrite against the recorded baselines"
```

---

### Task 12: Roll out and check the acceptance criteria

**Files:** none. This task runs the system.

**Interfaces:**
- Consumes: every prior task.
- Produces: a working install.

- [ ] **Step 1: Build and run the whole host suite**

```bash
pnpm run build && pnpm test
```

Expected: PASS.

- [ ] **Step 2: Typecheck and test the container tree**

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test
```

Expected: no errors, tests pass.

- [ ] **Step 3: Restart in mount order**

No step in this change rebuilds the container image. `container/skills` and `container/agent-runner/src` are read-only bind mounts, so a file edit reaches the container without a rebuild.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # host: src/ changes
```

Then restart the running agent containers so the agent-runner reloads `/app/src`, and start a fresh session so the recomposed `CLAUDE.md` is read.

```bash
tail -f logs/nanoclaw.log
```

Expected: `http-clients service started`, no projection errors.

- [ ] **Step 4: Check every acceptance criterion in a real conversation**

1. "qual minha alocação?" is answered from two calls returning under 5 KB together, down from 133 KB.
2. The answer groups a repeated symbol across accounts into one line.
3. Asking again re-fetches; the numbers change after a trade.
4. A card payment over $200 shows every leg and every key before the first call, and runs only after an explicit yes.
5. A Costco item search answers from the narrowest window containing the item, and never sends more than 25 barcodes in one call.
6. `wc -w` on each of the three skill files is inside its budget.
7. `grep -rn wealthsimple-v2` matches nothing outside `docs/superpowers/`.

```bash
wc -w container/skills/http-clients/SKILL.md container/skills/http-clients/references/*.md
grep -rn 'wealthsimple-v2' . --exclude-dir=node_modules --exclude-dir=.git | grep -v '^./docs/superpowers/'
```

- [ ] **Step 5: Report what did not ship**

If Costco stayed unauthenticated, criterion 5 is untested and the Costco projection rules are absent. Say so explicitly. A silently skipped service reads as a covered service.

- [ ] **Step 6: Squash the branch to a single commit**

The workspace preference is one commit per MR. Interactive rebase is unavailable in this environment, so squash with a soft reset:

```bash
git log --oneline main..HEAD          # review what is being squashed
git reset --soft $(git merge-base main HEAD)
git commit -m "feat(http-clients): recipes, payload projection, and write safety"
```

No Claude attribution in the message.
