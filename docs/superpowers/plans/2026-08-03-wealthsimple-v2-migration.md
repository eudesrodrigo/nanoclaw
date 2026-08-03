# Wealthsimple v2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point nanoclaw's Wealthsimple documentation and host bridge at the `wealthsimple-v2` client, and teach the bridge the argument shapes v2 needs.

**Architecture:** Two independent halves. The host bridge (`src/http-clients-service.ts`) gains typed argument rendering and stops discarding stdout on CLI failure; the container-side MCP schema is widened to match. The agent-facing docs (one skill, one always-loaded instruction fragment) are rewritten to describe routes to data — which command, which field, which trap — without prescribing what to conclude from it.

**Tech Stack:** TypeScript, Node (host, pnpm + vitest), Bun (container agent-runner), Typer/Click CLI on the far side.

## Global Constraints

- **No Claude attribution in git artifacts.** Never add `Co-Authored-By`, `Claude-Session`, or "Generated with Claude Code" to commit messages.
- **Never edit the `http-clients` repository.** v1 (`wealthsimple`) stays installed and callable; nanoclaw simply stops mentioning it.
- **The bridge stays a dumb proxy.** No service-specific filtering, reshaping, or interpretation in `src/http-clients-service.ts`. Service-specific logic in the transport layer is what produced the v1 failure this migration exists to fix.
- **Docs state facts about the API, not conclusions to draw from it.** Which command returns what, where a field lives, which behaviours mislead. Never which accounts to include, whether to net out debt, or which number is "the total".
- **Host tests:** `pnpm test` (vitest). Container typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from repo root.
- Spec: `docs/superpowers/specs/2026-08-03-wealthsimple-v2-migration-design.md`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/http-clients-service.ts` | Host HTTP endpoint that spawns the CLI and classifies its result | Extract + widen argument rendering; preserve stdout on failure; widen spawn env and timeout |
| `src/http-clients-service.test.ts` | Host unit tests | New cases for both behaviour changes |
| `container/agent-runner/src/mcp-tools/http-clients.ts` | MCP tool the agent calls | Widen `args` schema to the four value types; refresh description |
| `container/agent-runner/src/mcp-tools/http-clients.instructions.md` | Fragment composed into every agent's CLAUDE.md | Rewrite the Wealthsimple section |
| `container/skills/http-clients/SKILL.md` | Skill loaded on demand inside the container | Rewrite the Wealthsimple section and the re-auth heading |

Tasks 1–3 are host-side and independently shippable. Task 4 is container-side and depends on Task 1's semantics being real (an agent could otherwise send an array the host would mangle). Tasks 5–6 are documentation and depend on Task 4's schema allowing the argument shapes they describe.

---

### Task 1: Typed CLI argument rendering

**Files:**
- Modify: `src/http-clients-service.ts:24-41` (request handler's inline flag loop), `src/http-clients-service.ts:82-101` (`runCli`)
- Test: `src/http-clients-service.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type CliArgValue = string | number | boolean | string[]` and `export function buildCliArgs(service?: string, command?: string, args?: Record<string, CliArgValue>): string[]`. Task 4 mirrors this value union in the container's MCP schema.

Wealthsimple v2 needs three argument shapes the current `Record<string, string>` → `--${key} ${String(value)}` loop cannot produce: repeated flags (`fetch-account-combined-financials --ids A --ids B`, 16 ids for one profile), valueless boolean flags (Typer renders `bool` options as a `--flag / --no-flag` pair), and numbers (`--tax-year`, `--first`, `--page-size`).

- [ ] **Step 1: Write the failing tests**

Add to `src/http-clients-service.test.ts`, inside the existing `describe('http-clients-service', …)` block. Add `buildCliArgs` to the existing import on line 4:

```ts
import { startHttpClientsService, classifyCliResult, buildCliArgs } from './http-clients-service.js';
```

```ts
  it('renders service and command as positional args', () => {
    expect(buildCliArgs('wealthsimple-v2', 'profiles')).toEqual(['wealthsimple-v2', 'profiles']);
  });

  it('omits missing service and command', () => {
    expect(buildCliArgs(undefined, undefined, {})).toEqual([]);
  });

  it('renders string and number values as --key value', () => {
    expect(buildCliArgs('wealthsimple-v2', 'fetch-contribution-ytd', { profile: 'eudes', 'tax-year': 2026 })).toEqual([
      'wealthsimple-v2',
      'fetch-contribution-ytd',
      '--profile',
      'eudes',
      '--tax-year',
      '2026',
    ]);
  });

  it('repeats the flag once per array item (Typer list options)', () => {
    expect(buildCliArgs('wealthsimple-v2', 'fetch-account-combined-financials', { ids: ['tfsa-a', 'rrsp-b'] })).toEqual([
      'wealthsimple-v2',
      'fetch-account-combined-financials',
      '--ids',
      'tfsa-a',
      '--ids',
      'rrsp-b',
    ]);
  });

  it('renders an empty array as no flag at all', () => {
    expect(buildCliArgs('wealthsimple-v2', 'fetch-accounts', { ids: [] })).toEqual([
      'wealthsimple-v2',
      'fetch-accounts',
    ]);
  });

  it('renders boolean true as a bare flag and false as --no-flag', () => {
    expect(buildCliArgs('wealthsimple-v2', 'fetch-identity-positions', { aggregated: true })).toEqual([
      'wealthsimple-v2',
      'fetch-identity-positions',
      '--aggregated',
    ]);
    expect(buildCliArgs('wealthsimple-v2', 'fetch-identity-positions', { 'include-security': false })).toEqual([
      'wealthsimple-v2',
      'fetch-identity-positions',
      '--no-include-security',
    ]);
  });

  it('mixes every value type in one call', () => {
    expect(
      buildCliArgs('wealthsimple-v2', 'fetch-identity-positions', {
        profile: 'eudes',
        first: 100,
        'account-ids': ['tfsa-a'],
        aggregated: true,
      }),
    ).toEqual([
      'wealthsimple-v2',
      'fetch-identity-positions',
      '--profile',
      'eudes',
      '--first',
      '100',
      '--account-ids',
      'tfsa-a',
      '--aggregated',
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/http-clients-service.test.ts`
Expected: FAIL — `buildCliArgs is not a function` / no matching export.

- [ ] **Step 3: Implement `buildCliArgs`**

In `src/http-clients-service.ts`, add above the existing `runCli` function:

```ts
export type CliArgValue = string | number | boolean | string[];

export function buildCliArgs(service?: string, command?: string, args?: Record<string, CliArgValue>): string[] {
  const cliArgs: string[] = [];
  if (service) cliArgs.push(service);
  if (command) cliArgs.push(command);
  if (!args) return cliArgs;

  for (const [key, value] of Object.entries(args)) {
    if (Array.isArray(value)) {
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
  return cliArgs;
}
```

- [ ] **Step 4: Replace the inline loop in the request handler**

In `src/http-clients-service.ts`, replace the body's type annotation and the flag-building block (currently lines 24–41):

```ts
        let body: { service?: string; command?: string; args?: Record<string, CliArgValue> };
```

and

```ts
        const { service, command, args } = body;

        const cliArgs = buildCliArgs(service, command, args);
```

Everything after (`const startedAt = Date.now();` onward) is unchanged. The `profile` field read by the logging call on line 51 still works: `args?.profile` is now `CliArgValue | undefined`, which the log accepts.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/http-clients-service.test.ts`
Expected: PASS — all new cases plus the 11 pre-existing ones.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm run build
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "feat(http-clients): render array, boolean and number CLI args

Wealthsimple v2 takes repeated flags (--ids A --ids B), valueless boolean
flag pairs (--flag / --no-flag) and numeric options. The bridge rendered
every value as --key <string>, leaving those commands unreachable."
```

---

### Task 2: Stop discarding stdout on CLI failure

**Files:**
- Modify: `src/http-clients-service.ts:140-146` (the `cli_error` return in `classifyCliResult`)
- Test: `src/http-clients-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports. `classifyCliResult`'s `cli_error` branch changes the content of `message` only.

Typer prints a subcommand's full command list to **stdout** (161 lines for `wealthsimple-v2`, grouped Accounts / Authentication / Holdings) and its `Missing command` box to **stderr**, exiting 2. `message: stderr || stdout` picks stderr, so the agent receives the error box and none of the list. Discovery is the only way the agent learns v2's commands — the docs deliberately do not enumerate them — so both streams must survive.

- [ ] **Step 1: Write the failing tests**

Add to `src/http-clients-service.test.ts`, inside the existing describe block:

```ts
  it('keeps stdout when a failing CLI wrote to both streams (Typer discovery)', () => {
    const result = classifyCliResult(2, 'Commands:\n  fetch-identity-positions', 'Missing command.') as Record<
      string,
      unknown
    >;
    expect(result.code).toBe('cli_error');
    expect(result.message).toContain('fetch-identity-positions');
    expect(result.message).toContain('Missing command.');
  });

  it('puts stdout before stderr so the command list leads', () => {
    const result = classifyCliResult(2, 'THE-LIST', 'THE-ERROR') as Record<string, unknown>;
    expect(result.message).toBe('THE-LIST\n\nTHE-ERROR');
  });

  it('still returns stderr alone when the CLI wrote no stdout', () => {
    const result = classifyCliResult(1, '', 'Error: missing required input: account id') as Record<string, unknown>;
    expect(result.message).toBe('Error: missing required input: account id');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/http-clients-service.test.ts`
Expected: FAIL — the first two cases; `message` is `'Missing command.'` and `'THE-ERROR'`.

- [ ] **Step 3: Implement the merge**

In `src/http-clients-service.ts`, add below `classifyCliResult`:

```ts
function mergeStreams(stdout: string, stderr: string): string {
  // Typer prints a subcommand's command list to stdout and its
  // `Missing command` box to stderr, then exits 2. Preferring stderr — as
  // `stderr || stdout` did — threw away the entire discovery surface, which
  // is how the agent is meant to find v2's commands. stdout leads because
  // it is the useful half.
  if (stdout && stderr) return `${stdout}\n\n${stderr}`;
  return stderr || stdout;
}
```

and change the final return of `classifyCliResult` to:

```ts
  return {
    status: 'error',
    code: 'cli_error',
    exitCode: code,
    message: mergeStreams(stdout, stderr) || `CLI exited with code ${code}`,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/http-clients-service.test.ts`
Expected: PASS. The pre-existing `returns cli_error for non-auth failures` case (stdout empty) is unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "fix(http-clients): keep stdout when the CLI fails with output on both streams

Typer writes a subcommand's command list to stdout and its Missing
command box to stderr, exiting 2. Preferring stderr discarded the list,
which is the agent's only route to discovering commands."
```

---

### Task 3: Widen spawn environment and timeout

**Files:**
- Modify: `src/http-clients-service.ts:82-101` (`runCli`)
- Test: `src/http-clients-service.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const CLI_TIMEOUT_MS: number` and `export function cliEnv(): NodeJS.ProcessEnv`.

Two spawn-level problems. Rich wraps help output to 80 columns when `COLUMNS` is unset, breaking each command description across six or more lines inside box-drawing borders — hard to read and wasteful of context, on the output the agent depends on most. And the 30s timeout predates a client that follows pagination inside a single command and iterates profiles sequentially under `--profile all`.

Keep the spawn options as an inline object literal at the call site: passing a variable typed as `SpawnOptions` widens `proc.stdout` to nullable and breaks the existing `proc.stdout.on(...)` calls.

- [ ] **Step 1: Write the failing tests**

Add `cliEnv` and `CLI_TIMEOUT_MS` to the import on line 4 of `src/http-clients-service.test.ts`, then add:

```ts
  it('pins COLUMNS so Rich does not wrap help to 80 characters', () => {
    expect(cliEnv().COLUMNS).toBe('200');
  });

  it('passes the parent environment through to the CLI', () => {
    process.env.NANOCLAW_TEST_PASSTHROUGH = 'yes';
    expect(cliEnv().NANOCLAW_TEST_PASSTHROUGH).toBe('yes');
    delete process.env.NANOCLAW_TEST_PASSTHROUGH;
  });

  it('allows a paginated multi-profile read to run past 30 seconds', () => {
    expect(CLI_TIMEOUT_MS).toBe(60_000);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/http-clients-service.test.ts`
Expected: FAIL — `cliEnv is not a function`.

- [ ] **Step 3: Implement**

In `src/http-clients-service.ts`, add above `runCli`:

```ts
export const CLI_TIMEOUT_MS = 60_000;

export function cliEnv(): NodeJS.ProcessEnv {
  // Rich wraps to 80 columns when COLUMNS is unset, shredding the help
  // output the agent uses to discover commands. Widen it.
  return { ...process.env, COLUMNS: '200' };
}
```

and change the `spawn` call inside `runCli` to:

```ts
    const proc = spawn(HTTP_CLIENTS_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
      env: cliEnv(),
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/http-clients-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the widening against the real CLI**

Run: `COLUMNS=200 http-clients wealthsimple-v2 2>/dev/null | awk '{ print length }' | sort -rn | head -1`
Expected: a number well above 80 (roughly 200), confirming Rich honours the variable. If `http-clients` is not installed on this machine, skip this step — it is a manual confirmation, not a gate.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm run build
git add src/http-clients-service.ts src/http-clients-service.test.ts
git commit -m "feat(http-clients): widen CLI output columns and raise the timeout

Rich wraps help to 80 columns without COLUMNS set, shredding the output
the agent discovers commands from. 30s also predates a client that
paginates inside one command and walks profiles sequentially."
```

---

### Task 4: Widen the MCP tool's args schema

**Files:**
- Modify: `container/agent-runner/src/mcp-tools/http-clients.ts:14-55`

**Interfaces:**
- Consumes: the value union from Task 1 (`string | number | boolean | string[]`), redeclared locally — the container and host share no modules.
- Produces: no exports; the tool's `inputSchema` now admits the four value types.

The schema currently declares `args` as `additionalProperties: { type: 'string' }`. Even with Task 1 shipped, a well-behaved agent will not send an array or boolean while the schema forbids it.

- [ ] **Step 1: Widen the schema and description**

In `container/agent-runner/src/mcp-tools/http-clients.ts`, add above `const httpClientsTool`:

```ts
type CliArgValue = string | number | boolean | string[];
```

Replace the three `properties` entries (currently lines 24–30) with:

```ts
        service: {
          type: 'string',
          description: 'Service name (e.g. costco, wealthsimple-v2). Omit to list available services.',
        },
        command: {
          type: 'string',
          description: 'CLI command (e.g. receipts, fetch-identity-positions, login). Omit to list the service\'s commands.',
        },
        args: {
          type: 'object',
          description:
            'Key-value pairs passed as CLI flags. String or number becomes "--key value"; true becomes "--key"; false becomes "--no-key"; an array repeats the flag once per item ("--ids A --ids B"). Pass {help: true} for a command\'s own help.',
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
```

Replace the handler's destructuring cast (currently line 40) with:

```ts
    const { service, command, args } = params as {
      service?: string;
      command?: string;
      args?: Record<string, CliArgValue>;
    };
```

- [ ] **Step 2: Typecheck the container tree**

Run: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the container test suite**

Run: `cd container/agent-runner && bun test`
Expected: PASS, unchanged from before this task — there are no tests over this file; this confirms nothing regressed.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/mcp-tools/http-clients.ts
git commit -m "feat(http-clients): accept array, boolean and number args in the MCP tool

The host renders these correctly as of the preceding change; the schema
still forbade anything but strings, so the agent could not send them."
```

---

### Task 5: Rewrite the always-loaded instruction fragment

**Files:**
- Modify: `container/agent-runner/src/mcp-tools/http-clients.instructions.md:17-18` and `:29-52` and `:58`

**Interfaces:**
- Consumes: the argument shapes enabled by Tasks 1 and 4.
- Produces: nothing consumed by later tasks. Task 6 covers the same subject at greater length in the on-demand skill; the two must not contradict each other.

This file is concatenated into every agent's `CLAUDE.md` by `src/claude-md-compose.ts:76-95`, so it is always in context. Keep it dense.

- [ ] **Step 1: Update the parameter examples**

Replace lines 17–19:

```markdown
- `service` (string, optional) — service name (e.g. `costco`, `wealthsimple-v2`)
- `command` (string, optional) — CLI command (e.g. `receipts`, `fetch-identity-positions`, `login`, `profiles`)
- `args` (object, optional) — key-value pairs passed as CLI flags. String/number → `--key value`; `true` → `--key`; `false` → `--no-key`; array → the flag repeated (`{ids: ["a","b"]}` → `--ids a --ids b`)
```

- [ ] **Step 2: Replace the Wealthsimple section**

Replace the whole `### Wealthsimple data (use `portfolio`)` section (lines 29–52) with:

```markdown
### Wealthsimple (`wealthsimple-v2`)

26 commands, one per Wealthsimple GraphQL query, returned with no reshaping. There is no
aggregated "portfolio" command — a question about value, allocation or return is answered
by combining calls, and what belongs in the answer is decided in the conversation.

**Always fetch fresh** for any value / % / return question — never reuse numbers from
earlier in the conversation or from memory; the data moves and the user needs certainty.

Don't guess command names. Omit `command` for the full list grouped by domain; pass
`args: { help: true }` for one command's options and their types.

**Positions** — `fetch-identity-positions`
- Symbol is at `security.stock.symbol`, **not** `security.symbol`.
- `security.currency` is the security's native currency (often `USD`); the amount in
  `total_value` is already CAD. **Never convert.**
- Value is `total_value.amount`, a decimal **string**.
- `percentage_of_account` is a percentage of its own account, not of the portfolio.
- `accounts[].id` links a position to its account. Closed accounts return no positions.

**Accounts** — `fetch-all-accounts`
- Large (~60 KB for 37 accounts) and has no server-side filter.
- Closed accounts are included and report a net liquidation value of `0`. Open accounts
  can also sit at `0`, so the value never identifies a closed account — only `status` /
  `is_open` does.

**Balance, deposits, return per account** — `fetch-account-combined-financials`, `ids` as an array
- `net_liquidation_value_v2.amount`, `net_deposits_v2.amount`, `simple_returns.rate`.
- `simple_returns.rate` can be `null` (cash/save accounts).
- **Returns `0` for credit-card accounts.** A portfolio line of credit reports a negative
  value.

**Credit card** — `fetch-credit-card-account` with `id`
- The only correct source for a card: `balance.current`, `balance.outstanding`,
  `balance.available_credit_limit`, `balance.pending`.

**Cash** is not a position: per account it is `net_liquidation_value_v2` minus the sum of
that account's position `total_value`.

Output is always keyed by profile, even for a single profile: `{ "eudes": … }`.
`args: { profile: "all" }` covers every profile (partial-result shape applies).

Present results as bullet points (`•`) with indented `–` sub-bullets — **never tables**
(they break on Telegram). The `http-clients` skill has the agreed formats.
```

- [ ] **Step 3: Leave the re-authentication section alone**

Lines 55–59 need no edit. `wealthsimple-v2` exposes the same `login` / `profiles` pair and writes the same credentials record as v1, and the section already names only `login`. Confirm this rather than assuming it:

Run: `sed -n '55,59p' container/agent-runner/src/mcp-tools/http-clients.instructions.md`
Expected: the `flow: "otp"` line names `login` and no other command. If it names a v1-only command such as `portfolio` or `positions`, replace that name with `login`.

- [ ] **Step 4: Verify the fragment is still concatenation-safe**

This file is pasted verbatim into a composed `CLAUDE.md`, so a stray frontmatter delimiter or a top-level `#` heading would corrupt the document around it.

Run: `head -1 container/agent-runner/src/mcp-tools/http-clients.instructions.md && grep -c '^---$' container/agent-runner/src/mcp-tools/http-clients.instructions.md`
Expected: the first line is `## External service access (\`http_clients\`)`, and the `---` count is `0`. (`grep -c` exits 1 when the count is 0; that exit code is expected, not a failure.)

- [ ] **Step 5: Commit**

```bash
git add container/agent-runner/src/mcp-tools/http-clients.instructions.md
git commit -m "docs(http-clients): describe wealthsimple-v2 in the agent instruction fragment

Replaces the v1 portfolio guidance. States where each field lives and
which behaviours mislead, without prescribing what to conclude."
```

---

### Task 6: Rewrite the skill's Wealthsimple section

**Files:**
- Modify: `container/skills/http-clients/SKILL.md:27-66` and `:76`

**Interfaces:**
- Consumes: everything above.
- Produces: the final agent-facing surface. Must agree with Task 5's fragment.

The skill is loaded on demand and can afford more room than the always-loaded fragment: it carries the four output formats and the traps in full.

- [ ] **Step 1: Replace the Wealthsimple section**

Replace lines 27–66 (from `## Wealthsimple` through the end of the `### Output format` subsection, stopping before `## Re-authentication`) with:

```markdown
## Wealthsimple

The service is `wealthsimple-v2`: 26 commands, one per Wealthsimple GraphQL query,
returned with no reshaping. There is no single command that returns "the portfolio".
Value, allocation and return questions are answered by combining calls — and what belongs
in the answer (which accounts, whether debt is netted out, what counts as "the total") is
decided with the user in the conversation, not fixed here.

**Always fetch fresh.** For any value / % / allocation / return question, call the API
right then. **Never** reuse numbers from earlier in the conversation or from memory — the
data moves and the user needs certainty.

### Finding commands

Don't guess command names or options.

- `http_clients({ service: "wealthsimple-v2" })` — every command, grouped by domain.
- `http_clients({ service: "wealthsimple-v2", command: "<cmd>", args: { help: true } })` —
  one command's options and their types.

Arrays, booleans and numbers pass through: `args: { ids: ["tfsa-a", "rrsp-b"] }` becomes
`--ids tfsa-a --ids rrsp-b`, `{ aggregated: true }` becomes `--aggregated`, and
`{ "include-security": false }` becomes `--no-include-security`.

### Where the data lives

- **Positions (holdings)** — `fetch-identity-positions`. One call per profile.
- **Account list** — `fetch-all-accounts`. No arguments needed.
- **Balance, net deposits, return per account** — `fetch-account-combined-financials`,
  with `ids` as an array of account ids.
- **Credit card** — `fetch-credit-card-account`, with `id`.

### Traps, all measured against the live API

- **Symbol is `security.stock.symbol`**, not `security.symbol`.
- **All amounts are already CAD.** `security.currency` is the security's native currency
  and commonly reads `USD` on a position whose `total_value.currency` reads `CAD`.
  **Never apply an FX conversion.**
- **Position value is `total_value.amount`** — a decimal string, not a number.
- **`percentage_of_account` is a percentage of its own account**, not of the portfolio. A
  position that is an account's only holding reads `100`.
- **Closed accounts are in the account list and report a net liquidation value of `0`.**
  Open accounts can also sit at `0`, so the value never identifies a closed account — only
  `status` / `is_open` does. Positions are already clean: closed accounts return none.
- **`fetch-account-combined-financials` returns `0` for a credit card.** The real numbers
  are in `fetch-credit-card-account`: `balance.current`, `balance.outstanding`,
  `balance.available_credit_limit`, `balance.pending`. This exact silent zero is why the
  previous client was retired.
- **A portfolio line of credit reports a negative net liquidation value.**
- **`simple_returns.rate` can be `null`** (cash/save accounts).
- **Cash is not a position.** Per account it is `net_liquidation_value_v2` minus the sum
  of that account's position `total_value`.
- **Output is always keyed by profile**, even for a single profile: `{ "eudes": … }`.

### Output format — never tables (they break on Telegram)

One `•` bullet per line; indented `–` sub-bullets for detail. Sort by value/return desc.
These fix the shape so it is recognisable at a glance — they do not decide what goes in.

- **By asset:** `**Alocação consolidada (Eudes + Magda)** — Total: $110.234` then
  `• **TICKER** — $value (NN,N%)` per asset.
- **Returns:** headline `**Retorno total:** +$X (+Y%)`, then per asset
  `• **TICKER** — +$ret` with a sub-bullet `  – +N% sobre custo`.
- **Per-account:** `• **TICKER** — $value` then a sub-bullet per account
  `  – <Owner> <RRSP/TFSA/FHSA>: $value` (account type matters for tax).
- **Debt:** `• **Cartão** — $88,47 devidos · limite disponível $9.904,64` and
  `• **Linha de crédito** — -$7.876,30`.
```

- [ ] **Step 2: Update the re-authentication heading**

On line 76, replace:

```markdown
**Wealthsimple (and any OTP-based service):**
```

with:

```markdown
**Wealthsimple (and any OTP-based service):**

`login` and `profiles` are shared with the older `wealthsimple` client — same credentials record, so authenticating through either covers both.
```

- [ ] **Step 3: Verify the skill's frontmatter is intact**

Run: `head -5 container/skills/http-clients/SKILL.md`
Expected: the file begins with a bare `---` on line 1, then `name: http-clients`. A corrupted first line breaks skill loading silently.

- [ ] **Step 4: Confirm no v1 references survive anywhere**

Run: `grep -rn "portfolio\|market_value\|account_value" container/skills/http-clients/SKILL.md container/agent-runner/src/mcp-tools/http-clients.instructions.md`
Expected: no hits for `market_value` or `account_value`. Hits for `portfolio` are acceptable only inside `fetch-portfolio-line-of-credit-*` command names or the phrase "of the portfolio"; anything referring to a `portfolio` **command** is a leftover and must be removed.

- [ ] **Step 5: Commit**

```bash
git add container/skills/http-clients/SKILL.md
git commit -m "docs(http-clients): rewrite the Wealthsimple skill for wealthsimple-v2

Routes to the data and the traps measured against the live API, plus the
four agreed output formats. Drops v1's portfolio/market_value guidance
and the judgements it hard-coded about what to total."
```

---

## Final verification

- [ ] Run the full host suite: `pnpm test`
- [ ] Run the host build: `pnpm run build`
- [ ] Run the container typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`
- [ ] Rebuild the agent image so the new skill and instruction fragment reach containers: `./container/build.sh`
- [ ] Restart the host: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- [ ] Ask the running agent, over its normal channel, for the credit-card balance. Expect `88,47` (or the current figure from `fetch-credit-card-account`), **not** `0`. This is the v1 failure the migration exists to fix, and it is the only end-to-end proof that matters.
