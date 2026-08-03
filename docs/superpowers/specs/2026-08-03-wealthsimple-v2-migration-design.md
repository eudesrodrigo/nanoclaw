# Wealthsimple v2 migration — design

**Date:** 2026-08-03
**Status:** approved, ready for implementation planning

## Problem

`http-clients` gained a second Wealthsimple client, `wealthsimple-v2`, built against
Wealthsimple's own GraphQL backend: 26 query commands (19 Accounts, 7 Holdings), one per
Wealthsimple query and with no reshaping, plus `login` and `profiles`. The v1 client
(`wealthsimple`, 4 aggregated commands) stays installed but nanoclaw stops referring to
it.

v1 is being retired here because of how it failed, not because it was slow. Its
`FETCH_PORTFOLIO_QUERY` was a query nanoclaw composed, not one Wealthsimple runs; on a
credit-card account it returned 0 with no error and no missing field. The agent then
stated "your credit card is at zero" with full confidence. Reproduced live on 2026-08-03:
`fetch-account-combined-financials` still returns NLV `0` for `ca-credit-card-cxPxfAh-WA`,
while `fetch-credit-card-account` returns the real `current: 88.47`.

Every field name, currency rule, and aggregation in nanoclaw's Wealthsimple docs was
written against v1's shape and does not survive the move.

## Scope

Four files in nanoclaw plus one test file. No changes to the `http-clients` repository —
v1 remains installed and callable, simply unmentioned, as a fallback if v2 turns out to
miss something in real use.

| File | Change |
|------|--------|
| `src/http-clients-service.ts` | Flag builder, error classification, spawn env, timeout |
| `container/agent-runner/src/mcp-tools/http-clients.ts` | MCP `args` schema, tool description |
| `container/agent-runner/src/mcp-tools/http-clients.instructions.md` | Wealthsimple section rewritten (always in every agent's CLAUDE.md) |
| `container/skills/http-clients/SKILL.md` | Wealthsimple section rewritten |
| `src/http-clients-service.test.ts` | Cases for the two behaviour changes |

## Principle: routes to data, not conclusions

The v1 docs encoded judgement — which number is "the official total", whether to present
the portfolio figure or the sum of unrealized returns. That fixed a decision that belongs
to the user in the moment: sometimes debt counts, sometimes it doesn't; sometimes an
account is in scope, sometimes not.

The new docs state only what is verifiable about the API: which command returns what,
where a field lives, and which behaviours mislead. What to include, what to net out, and
what to call "the total" is decided in conversation, per question.

Presentation shape is the one exception — see Output templates.

## Host bridge changes

### Argument types

v2 commands need argument shapes the bridge cannot express. `args` is
`Record<string, string>` and is rendered as `--${key} ${String(value)}`:

- **Repeated flags.** `fetch-account-combined-financials` takes `--ids A --ids B …`
  (16 open accounts for one profile). Unreachable today.
- **Boolean flags.** Typer renders `bool | None` as a `--flag / --no-flag` pair that takes
  no value; `--aggregated true` fails to parse.
- **Numbers.** `--tax-year`, `--first`, `--page-size`.

`args` values become `string | number | boolean | string[]`:

| Value | Emitted |
|-------|---------|
| `"eudes"` | `--profile eudes` |
| `2026` | `--tax-year 2026` |
| `["A", "B"]` | `--ids A --ids B` |
| `true` | `--aggregated` |
| `false` | `--no-include-security` |

Keys pass through unchanged; v2's options are hyphenated (`--account-ids`,
`--sort-direction`), so callers use hyphenated keys. The MCP `inputSchema` for `args`
loosens from `additionalProperties: { type: 'string' }` to accept the same four types.

### Discovery output is discarded

`classifyCliResult` builds `message: stderr || stdout`. Typer prints a subcommand's full
command list to **stdout** (161 lines, grouped Accounts / Authentication / Holdings) and
the `Missing command` box to **stderr**, exiting 2. stderr wins, so the agent receives the
error box and none of the list.

Discovery is the primary navigation mechanism — the docs deliberately do not enumerate
commands — so this must preserve both streams. When both are present, stdout comes first;
it is the useful part.

### Rich wrapping

The CLI is spawned without `COLUMNS`, so Rich wraps help to 80 columns. Command
descriptions break across 6+ lines each inside box-drawing borders, which is both hard to
read and wasteful in tokens. Spawn with `COLUMNS=200`.

### Timeout

30s → 60s. v2 follows pagination inside a single command, and `run_service` iterates
profiles sequentially under `--profile all`, so a two-profile paginated read serialises.
Measured `fetch-identity-positions` at ~1s for one profile; the raise is headroom, not a
fix for an observed timeout.

## Data routes (documented content)

Verified live against the real account on 2026-08-03.

### Positions

`fetch-identity-positions` — one call per profile, 15 positions across 4 accounts.

- Symbol is at `security.stock.symbol`. **Not** `security.symbol`.
- `security.currency` reads `USD` while `total_value.currency` reads `CAD`: the value is
  already converted. Never apply FX.
- Position value is `total_value.amount`, a **string**. v1's `market_value` is gone.
- `percentage_of_account` is a percentage **of its account**, not of the portfolio — one
  position reads `100`. Not usable for allocation across accounts.
- `accounts[].id` links a position to its account. `security` and `accounts` sit behind
  `@include` directives whose document default is `false`; the service turns both on.
- Closed accounts contribute no positions.

### Accounts

`fetch-all-accounts` — every account with its full object graph.

- ~60 KB compacted for 37 accounts; ~25 KB for the 16 open ones. There is no server-side
  filter — `page_size` is the only option — so any filtering happens after the response
  has already arrived.
- 21 of 37 are `closed` and every one returns NLV `0`.
- **`0` does not identify a closed account.** Two *open* accounts also sit at zero
  (`ca-cash-lp04lacd`, `resp-GBP-1BmWyA`). Only `status` / `is_open` distinguishes them.
- Filtering to open accounts does not shrink this response; it shrinks the follow-up
  `--ids` call (16 instead of 37).

### Financials

`fetch-account-combined-financials --ids …` — balance, net deposits, returns per account.

- `net_liquidation_value_v2.amount`, `net_deposits_v2.amount`, `simple_returns.rate`.
- `simple_returns.rate` can be `null` (cash/save accounts).
- **Returns `0` for credit-card accounts.** The real numbers come from
  `fetch-credit-card-account --id`: `balance.current`, `balance.outstanding`,
  `balance.available_credit_limit`, `balance.pending`.
- A portfolio line of credit arrives as a negative NLV (`-7876.30`).

### Cash

Cash is not a position. Per account it is `net_liquidation_value_v2 − Σ total_value` of
that account's positions. Verified: TFSA $23, RRSP $106, FHSA $0, TFSA-Isaac $27.

### Output envelope

Always keyed by profile, even for a single profile: `{ "eudes": … }`. On `--profile all`
with a failure, the shape becomes `{ results: {…}, errors: {…} }` — unchanged from v1.

### Authentication

`login` and `profiles` are shared with v1: same `SERVICE_NAME`, same credentials record.
Authenticating through either client authenticates both. The OTP flow is unchanged —
`OTPRequired:<hint>` on stderr, exit 2, retry with `--otp`.

## Discovery (documented content)

No command list in the docs, by decision. Two moves are taught:

- Omit `command` → the full grouped command list.
- `args: { help: true }` → help for one command, including every option and its type.

## Output templates

Presentation skeletons, not content rules. They fix shape so the reader can recognise a
format at a glance; they never say which accounts or values belong in it.

1. **By asset** — `• **TICKER** — $value (NN,N%)`, sorted by value descending.
2. **Returns** — `• **TICKER** — +$gain`, sub-bullet `– +N% sobre custo`.
3. **By account** — `• **TICKER** — $value`, sub-bullet `– <Owner> <RRSP/TFSA/FHSA>: $value`.
4. **Debt** — `• **Cartão** — $88,47 devidos · limite disponível $9.904,64`,
   `• **Linha de crédito** — -$7.876,30`.

Hard rule, retained from v1: **never tables.** Tables break Telegram rendering. Bullets
`•` with `–` sub-bullets.

## Testing

`src/http-clients-service.test.ts` (vitest, host):

- Flag builder: string, number, boolean `true`, boolean `false`, array, and a mixed
  object; verify emitted `argv` exactly.
- `classifyCliResult`: exit 2 with content on both streams keeps both, stdout first; exit
  2 with stderr only is unchanged; exit 0 with JSON stdout is unchanged.

No container-side tests — `http-clients.ts` only widens a schema and forwards.

## Explicitly out of scope

- Removing v1 from the `http-clients` repository.
- Any change to the Costco client or its documented flow.
- Host-side filtering or reshaping of service responses. The bridge stays a dumb proxy;
  service-specific logic in it is what produced the v1 failure.
