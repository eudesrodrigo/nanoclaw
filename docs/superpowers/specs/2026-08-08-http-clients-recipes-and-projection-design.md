# http-clients: recipes, payload projection, and write safety

Date: 2026-08-08
Status: approved, ready for planning

## Problem

The `http-clients` CLI changed. The nanoclaw side did not follow. Four problems
result.

### 1. The documented service name is dead

The CLI renamed `wealthsimple-v2` to `wealthsimple`. Three files still name the
dead service:

- `container/skills/http-clients/SKILL.md`
- `container/agent-runner/src/mcp-tools/http-clients.instructions.md`
- `container/agent-runner/src/mcp-tools/http-clients.ts` (tool description, line 28)

`http-clients wealthsimple-v2` now exits with `No such command`. Every
Wealthsimple call fails until an agent re-discovers the name.

### 2. The command surface grew, and it now moves money

Wealthsimple went from 26 commands to 89, in 12 domains. Five commands move real
money:

- `credit-card-payment`
- `credit-card-scheduled-payment`
- `credit-card-scheduled-payment-cancel`
- `funding-intent-internal-transfer-create`
- `funding-intent-cancel`

No current instruction mentions these commands. No confirmation protocol exists.

`credit-card-payment` carries three traps. The amount is in cents
(`--amount-cents 14161` is $141.61). One call is capped at $200. Without
`--idempotency-key`, a retry pays a second time.

### 3. The common query costs 35k tokens

The dominant request in the recorded conversations is portfolio allocation. It
needs two calls:

| Call | Bytes |
|---|---|
| `fetch-identity-positions --profile all` | 84,620 |
| `fetch-all-accounts --profile all` | 48,011 |

That is 133 KB, or about 35k tokens, for 19 positions and 19 accounts. The user
asks for it three to five times in one conversation, because the numbers move
after each trade.

An answer uses six fields per position: `security.stock.symbol`,
`accounts[0].id`, `quantity`, `total_value.amount`, `book_value.amount`, and
`unrealized_returns.amount`. The rest is `logo_url`, `security_groups`,
`features`, and a 20-field quote. Measured projection to the useful fields:

- positions: 54,067 → 2,689 bytes (20x)
- accounts: 32,938 → 1,833 bytes (18x)

### 4. The skill has the wrong form for its failures

The skill review (framework: `superpowers:writing-skills`) found these defects.

- **Prohibition where a recipe belongs.** The file holds 23 prohibition markers
  (`NEVER`, `Don't`, `Do not`) against 10 numbered steps. All 10 steps sit in one
  section. The framework states that prohibition only works for a discipline
  failure. For a procedure failure, prohibition makes the result worse.
- **The measured failures are procedure failures.** An agent guessed 35 command
  names while `Don't guess command names` was already in the file. An agent
  picked `fetch-payment-methods` to pay a card. An agent exhausted its context
  twice on a Costco item search.
- **The description breaks discovery.** It opens with what the skill does, not
  when to use it. It uses `Trigger when`, not third person. Its triggers are
  English only, but every recorded request is Portuguese.
- **Size.** 1,369 words. The framework target is under 500. It is the largest
  skill in `container/skills/`. `http-clients.instructions.md` repeats 780 more
  words of the same content, and the host loads that file into every CLAUDE.md,
  in every session.
- **Narrative and baked-in policy.** The file holds four war stories. Its output
  formats hardcode `Alocação consolidada (Eudes + Magda)`.

## Recorded baseline failures

These are real, recorded failures. The test plan uses them as the RED phase.

| Date | Failure | Cause |
|---|---|---|
| 2026-06-14 | Costco Nespresso search: context exhausted twice, wrong answer | 90-day default window, one `receipt-detail` call per barcode |
| (session) | 35 guessed command names | Discovery output arrived under `status: "error"`; agent skipped it |
| 2026-06-05 | Reused a stale number after the user traded | No fetch-fresh discipline that holds |
| 2026-08-08 | `fetch-payment-methods` chosen to pay a card | It returns external banks, not Wealthsimple cash accounts |

## Decisions

1. Recipes **and** payload projection. Recipes alone do not fix the 133 KB cost.
2. The host projects by default. The agent asks for raw data when it must.
3. Money commands need explicit chat confirmation before the agent runs them.
4. A thin `SKILL.md` plus one reference file per service.
5. Recipes describe the repeated procedure, never the user's policy.

Decision 5 is a hard rule. No recipe names a person, an account, or an
exclusion. "Exclude TFSA Isaac" and "Eudes + Magda" are conversation arguments.
The user states them each time.

## Design

### Part 1 — host changes

#### 1.1 Payload projection

New file: `src/http-clients-projections.ts`.

```ts
type ProjectionRule = {
  /** Path to unwrap on each array element, e.g. 'node' for GraphQL edges. */
  each?: string;
  /** Output key -> source path. Path syntax: dots and [n], e.g. 'accounts[0].id'. */
  fields: Record<string, string>;
};

export const PROJECTIONS: Record<string, ProjectionRule> = {
  'wealthsimple/fetch-identity-positions': {
    each: 'node',
    fields: {
      sym: 'security.stock.symbol',
      acct: 'accounts[0].id',
      qty: 'quantity',
      value: 'total_value.amount',
      book: 'book_value.amount',
      ret: 'unrealized_returns.amount',
    },
  },
};
```

The key is `"<service>/<command>"`.

`src/http-clients-service.ts` applies the rule after `classifyCliResult`. It
applies the rule only when `status` is `ok` and `data` is a parsed object.

The payload is always keyed by profile, even for one profile. The projector
applies the rule to each profile payload. For a partial result, the projector
applies the rule inside `results` and leaves `errors` unchanged.

A payload can be an array or an object. For an array, the projector unwraps
`each` on every element, then picks the fields. For an object, the projector
picks the fields directly. A path that does not resolve produces no key.

**No rule means no change.** A new CLI command returns its raw payload. Nothing
breaks when the command surface grows again.

Rules ship for these commands:

| Key | Shape verified |
|---|---|
| `wealthsimple/fetch-identity-positions` | yes |
| `wealthsimple/fetch-all-accounts` | yes |
| `wealthsimple/fetch-credit-card-account` | yes |
| `wealthsimple/fetch-payment-methods` | yes |
| `wealthsimple/fetch-account-combined-financials` | no |
| `wealthsimple/fetch-credit-card-latest-statement` | no |
| `costco/receipts` | no |
| `costco/receipt-detail` | no |

Write each unverified rule against a live call during implementation. Do not
guess a path. A wrong path silently drops the field.

The projector is about 40 lines of plain TypeScript. It adds no npm dependency,
so the pnpm supply-chain policy does not apply.

#### 1.2 Raw escape hatch

The request body accepts `raw?: boolean`. The MCP tool accepts a `raw` parameter.
When `raw` is true, the host skips projection. The tool description states this.

#### 1.3 Positional arguments

`buildCliArgs` in `src/http-clients-service.ts:85` turns every key into
`--key`. Two Costco commands take positional arguments:

- `receipt-detail BARCODES...`
- `order-details ORDER_NUMBERS...`

An agent found that `args: {"": "x"}` produces `-- x`, which works by accident.
An array under the same key produces `-- a -- b`, which is wrong: Click reads the
second `--` as a value.

`buildCliArgs` gains a reserved key `_`:

```ts
buildCliArgs('costco', 'receipt-detail', { _: ['b1', 'b2'], profile: 'all' })
// ['costco', 'receipt-detail', '--profile', 'all', '--', 'b1', 'b2']
```

The builder emits flags first, then `--`, then the positional values. A string
value produces one positional. An empty array produces no `--`.

This turns the Costco item search from about 80 calls into 2.

#### 1.4 Costco auth flow

`classifyCliResult` at `src/http-clients-service.ts:173` maps
`AuthenticationError` to `flow: "otp"` for every service. Costco needs
`flow: "token"`. A live call today returns `AuthenticationError: HTTP Error 400`,
so Costco currently reports the OTP flow. `SKILL.md` patches this in prose
("regardless of `flow`") instead of fixing the source.

`classifyCliResult` gains an options object:

```ts
classifyCliResult(code, stdout, stderr, opts?: { isListing?: boolean; service?: string })
```

A small set names the token-flow services. Today it holds `costco`. The default
stays `otp`, so existing tests keep passing. Add a comment: update the set when a
new token-based service arrives.

Remove the prose patch from the skill.

#### 1.5 Rename the dead service

Replace `wealthsimple-v2` with `wealthsimple` in all four files: `SKILL.md`,
`http-clients.instructions.md`, `http-clients.ts`, and the string fixtures in
`http-clients-service.test.ts`. Then grep the repository for the old name. Only
the earlier documents under `docs/superpowers/` may still hold it. Those are a
historical record. Do not edit them.

#### 1.6 End the triplication

- `http-clients.instructions.md` keeps only the generic mechanism: the response
  envelope, error codes, profiles and partial results, and `raw`. It removes all
  Wealthsimple detail and points to the skill. This file loads into every
  CLAUDE.md, in every session.
- The tool description in `http-clients.ts` becomes one line. It names no
  service.
- `SKILL.md` and its references own the recipes.

### Part 2 — skill changes

#### 2.1 Files

```
container/skills/http-clients/
  SKILL.md                     ~400 words, allowed-tools gains Read
  references/wealthsimple.md
  references/costco.md
```

#### 2.2 Description

```
Use when the user asks about their own accounts at an external service —
balance, portfolio allocation, positions, returns, net worth, credit card
balance or statement, spending, purchases, orders, receipts, membership —
or asks to pay a card or move money between their own accounts. Portuguese
triggers: alocação, posições, retorno, patrimônio, fatura, cartão, quanto
gastei, quando compramos, extrato, pagar cartão.
```

Third person. Opens with "Use when". No workflow summary. It holds the
Portuguese words the user types.

#### 2.3 SKILL.md content

The common mechanism: three-level discovery, profiles and partial results, error
codes, the write protocol, and an index of the reference files.

Two discipline sections. These are the only prohibitions in the skill. Each one
gets a rationalization table and a red-flags list.

**Fetch fresh.** Recorded rationalizations: "I already fetched this in this
conversation", "the user only changed the filter, the numbers are the same", "it
was a few minutes ago". Red flag: computing from a number in the conversation
history instead of a tool response.

**Credentials.** Never ask for an email or a password. Never look for a
credential file. Never use the shell for http-clients.

Everything else moves to a recipe or to a field note in a reference file.

#### 2.4 Write protocol

Before any of the five money commands, the agent states the operation in plain
text: the amount, the source account, and the target account. The agent runs the
command only after an explicit "yes" in the same conversation. The agent always
passes `idempotency-key`.

```
You: pay the card

Agent: Payment ready to confirm:
  • Amount: $141.61 (statement closed 28 Jul)
  • From: Salário (ca-cash-msb-hQmo1iJfXA)
  • To: card (ca-credit-card-cxPxfAh-WA)
  Confirm?

You: yes

Agent: Paid. $141.61 debited from Salário.
```

#### 2.5 Wealthsimple recipes

Each recipe is a parameterized procedure. Each one ends with an output shape in
`•` bullets. No recipe names a person or an account.

- **Discover accounts.** The base of every other recipe. Closed and archived
  accounts are excluded by default. `--archived` and `--closed` are equality
  filters, so an audit is a second call.
- **Allocation by asset.** Positions plus accounts. The symbol is at
  `security.stock.symbol`, not `security.symbol`. Amounts are already CAD;
  `security.currency` is the security's native currency and often reads `USD`.
  Never convert. `percentage_of_account` is a share of its own account, not of
  the portfolio. Cash is not a position: per account it is the net liquidation
  value minus the sum of that account's position values.
- **Returns.** `book_value` against `total_value`. `simple_returns.rate` can be
  `null` for cash and save accounts.
- **Read a card.** `fetch-credit-card-account` with `id`. Use
  `balance.current`, `balance.outstanding`, `balance.available_credit_limit`,
  and `balance.pending`. `fetch-account-combined-financials` returns `0` for a
  card. A portfolio line of credit reports a negative value.
- **Pay a card.** The source is a Wealthsimple `CASH` account from
  `fetch-all-accounts`. It is **not** `fetch-payment-methods`, which returns
  external banks. The amount is in cents. One call is capped at $200, so a larger
  balance needs more than one call. Always pass `idempotency-key`. Confirm first.
- **Spending.** `fetch-spend-breakdown` requires `start-date`, `end-date`, and
  `group-by`.

#### 2.6 Costco recipes

- **Find an item in the purchase history.** Set the window explicitly; the
  default is 90 days and that default produced the June failure. Collect every
  barcode, then pass them in one batched `receipt-detail` call through `_`. Item
  descriptions are abbreviations, for example `NEW STBX NES` for Starbucks
  Nespresso. Match on a normalized substring, and show the raw abbreviation in
  the answer so the user can judge the match.
- **Recent orders and receipts.**
- **Membership.**

## Testing

### Host tests

`src/http-clients-service.test.ts` already exists and covers `buildCliArgs` and
`classifyCliResult`. Add pure unit tests, with no network:

- projection applies per profile, and inside `results` for a partial result
- projection leaves `errors` unchanged
- a command with no rule returns its payload unchanged
- `raw: true` skips projection
- an unresolved path produces no key
- `_` renders positional arguments after `--`
- `_` with an array renders every value after one `--`
- `_` with an empty array renders no `--`
- `AuthenticationError` for `costco` gives `flow: "token"`
- `AuthenticationError` with no service still gives `flow: "otp"`

Update the `wealthsimple-v2` string fixtures in the existing tests to
`wealthsimple`.

### Skill tests

The Iron Law applies: no skill without a failing test first. The RED phase uses
the four recorded baseline failures above, not invented scenarios. Run each one
against the new skill.

The two discipline sections need a wording micro-test against a no-guidance
control, five repetitions each, with every flagged match read by hand. The
workspace `CLAUDE.md` requires this for a behavioral rule.

## Out of scope

- Aggregate commands inside the `http-clients` library. That is a different
  repository.
- A second tier of agent self-modification.
- Any change to the OneCLI credential path.
