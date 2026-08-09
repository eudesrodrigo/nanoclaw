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

The test fixtures in `src/http-clients-service.test.ts` carry it too.

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

An answer uses six fields per position: `security.stock.symbol`, `accounts`,
`quantity`, `total_value.amount`, `book_value.amount`, and
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

## Verified against the live API

These facts carry the design. A live call on 2026-08-08 confirmed each one.
Anything not in this list is unverified, and the implementation must verify it
before it ships.

- **A single-profile call still returns a profile-keyed object.**
  `fetch-identity-positions --profile eudes` returns `{"eudes": [...]}`, not a
  bare array. The projector can always iterate profile keys.
- **The $200 cap is per call, and the CLI enforces it.** The help text reads
  `Capped at 20000 ($200.00)`. Splitting a larger balance across calls is valid.
- **`security.stock.symbol` is present on every position.** 15 of 15.
- **The currency trap is real.** `security.currency` reads `USD` while
  `total_value.currency` reads `CAD` on the same position. Amounts are already
  CAD.
- **Amounts are strings, and some carry 28 decimal places.** One book value
  reads `7178.640181775510391386379161`.
- **A symbol repeats across accounts.** `AAPL` appears as three separate
  positions in three accounts.
- **`accounts` holds exactly one entry today.** 15 of 15. This is a sample, not
  a contract — see the projection rules.
- **Costco is unverified.** Its refresh token is expired, so no Costco payload
  was measured. Every Costco rule in this spec is provisional.

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
      accounts: 'accounts',
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

The payload is always keyed by profile, even for one profile. A live call
confirmed this for a single profile. The projector applies the rule to each
profile payload. For a partial result, the projector applies the rule inside
`results` and leaves `errors` unchanged.

A payload can be an array or an object. For an array, the projector unwraps
`each` on every element, then picks the fields. For an object, the projector
picks the fields directly. A path that does not resolve produces no key.

**No rule means no change.** A new CLI command returns its raw payload. Nothing
breaks when the command surface grows again.

**The projector never throws.** A malformed payload, a wrong path, or an element
that is not an object must not turn a working call into a 500. Wrap the whole
projection in a `try`. On any error, log it and return the raw payload
unchanged.

**The projector never coerces a value.** Amounts arrive as strings, and one
observed book value carries 28 decimal places. Copy the value as it is. Rounding
is a display decision, and it belongs in the recipe.

**Project a whole array when the array is small.** `accounts` holds one entry
today, across all 15 observed positions. That is a sample, not a contract.
`accounts[0].id` would silently drop a second account and corrupt the
per-account cash math. Copying the whole array costs about 20 bytes and removes
the risk. Apply the same judgment to any other short array.

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
guess a path. A wrong path silently drops the field. Costco needs a fresh
refresh token before its two rules can be written.

The projector is about 40 lines of plain TypeScript. It adds no npm dependency,
so the pnpm supply-chain policy does not apply.

#### 1.2 Projection must announce itself

A silent trim is a trap. The agent cannot know a field was removed, so it cannot
know to ask for the raw payload. It answers from what it received.

When a rule runs, the response envelope carries the rule key:

```json
{ "status": "ok", "projected": "wealthsimple/fetch-identity-positions", "data": {...} }
```

The key is absent when no rule ran. One string makes the escape hatch reachable:
the agent sees the payload is trimmed, and it knows which command to re-run.

#### 1.3 Raw escape hatch

The request body accepts `raw?: boolean`, as a **sibling of `args`, never inside
it**. A `raw` key inside `args` would reach `buildCliArgs` and render `--raw`,
which the CLI rejects. The MCP tool exposes `raw` as its own parameter for the
same reason.

When `raw` is true, the host skips projection and omits `projected`. The tool
description states this in one sentence.

#### 1.4 Positional arguments

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
value produces one positional. A number becomes a string. An empty array
produces no `--`.

`_` is reserved. A CLI flag literally named `--_` cannot be passed. No command
has one.

This cuts the Costco item search from about 80 calls to a few. It does not cut
the response size — see the Costco recipe for that half of the problem.

#### 1.5 Costco auth flow

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
stays `otp` because Wealthsimple uses OTP, and Wealthsimple is the only other
service. Add a comment: update the set when a new token-based service arrives.

Remove the prose patch from the skill.

#### 1.6 Rename the dead service

Replace `wealthsimple-v2` with `wealthsimple` in all four files: `SKILL.md`,
`http-clients.instructions.md`, `http-clients.ts`, and the string fixtures in
`http-clients-service.test.ts`. Then grep the repository for the old name. Only
the earlier documents under `docs/superpowers/` may still hold it. Those are a
historical record. Do not edit them.

#### 1.7 End the triplication

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
  SKILL.md                     max 400 words, allowed-tools gains Read
  references/wealthsimple.md   max 600 words
  references/costco.md         max 300 words
```

The word budgets are a requirement, not a target. Token economy is the point of
the whole change. A reference file that grows past its budget has to drop
content, not raise the budget. Check with `wc -w`.

**The references document the projected shape, not the raw payload.** The agent
never sees `security.stock.symbol`; it sees `sym`. A field note written against
the raw path sends the agent looking for a key that is not there. Each reference
file opens with the projected shape of the commands it uses, and names the raw
path only where the agent would need `raw: true` to reach it.

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
command only after an explicit "yes" in the same conversation.

**The idempotency key must be derived, never invented.** The CLI help is
explicit: *"Reuse to retry safely; omitted, a fresh one pays again."* A key
generated fresh on each attempt makes the flag decorative — the retry pays a
second time, which is the exact failure the flag exists to prevent.

The key is a deterministic string:

```
<credit-account-id>-<YYYY-MM-DD>-<total-cents>-<leg-index>
```

- `credit-account-id` and `total-cents` bind the key to this intent.
- `YYYY-MM-DD` lets the same payment happen again on a later day.
- `leg-index` starts at 1 and distinguishes the calls of a split.

The same intent, retried, produces the same key. A different leg produces a
different key. The agent shows every key in the confirmation, so a retry is
auditable by eye.

**Splitting past the $200 cap.** The CLI caps one call at 20000 cents. A larger
balance needs one call per leg. The agent shows all legs before the first call.
If a leg fails, the agent reports which legs succeeded, and retries only the
failed leg with its original key. The agent never re-runs a succeeded leg, and
never merges two legs into one retry.

```
You: pay the card

Agent: Payment ready to confirm:
  • Total: $289.93 (statement closed 28 Jul)
  • From: Salário (ca-cash-msb-hQmo1iJfXA)
  • To: card (ca-credit-card-cxPxfAh-WA)
  • Capped at $200 per call, so 2 calls:
      leg 1 — $200.00  key ca-credit-card-cxPxfAh-WA-2026-08-08-28993-1
      leg 2 — $89.93   key ca-credit-card-cxPxfAh-WA-2026-08-08-28993-2
  Confirm?

You: yes

Agent: Paid. $289.93 debited from Salário in 2 calls.
```

#### 2.5 Wealthsimple recipes

Each recipe is a parameterized procedure. Each one ends with an output shape in
`•` bullets. No recipe names a person or an account.

- **Discover accounts.** The base of every other recipe. Closed and archived
  accounts are excluded by default. `--archived` and `--closed` are equality
  filters, so an audit is a second call.
- **Allocation by asset.** Positions plus accounts. Projected keys: `sym`,
  `accounts`, `qty`, `value`, `book`, `ret`.
  - **One symbol produces several positions.** `AAPL` was observed as three
    positions in three accounts. Allocation by asset sums `value` across every
    position with the same `sym`.
  - **Amounts are already CAD. Never convert.** The projection drops
    `security.currency` for this reason — it reads `USD` on a position whose
    `total_value.currency` is `CAD`.
  - **Amounts are strings, and precision is noise.** One observed book value
    carries 28 decimal places. Round to 2 decimals for display, and round only
    at the end.
  - **Cash is not a position.** Per account it is the net liquidation value
    minus the sum of that account's `value` entries.
  - The projection also drops `percentage_of_account`, which is a share of its
    own account and not of the portfolio. That removes the trap instead of
    warning about it.
- **Returns.** `book` against `value`, and `ret` for the unrealized amount.
  `simple_returns.rate` lives on the account, not the position, and it can be
  `null` for cash and save accounts.
- **Read a card.** `fetch-credit-card-account` with `id`. Use
  `balance.current`, `balance.outstanding`, `balance.available_credit_limit`,
  and `balance.pending`. `fetch-account-combined-financials` returns `0` for a
  card. A portfolio line of credit reports a negative value.
- **Pay a card.** The source is a Wealthsimple `CASH` account from
  `fetch-all-accounts`. It is **not** `fetch-payment-methods`, which returns
  external banks. The amount is in cents. One call is capped at 20000 cents, so
  a larger balance needs one call per leg. Follow the write protocol for the
  key and the split.
- **Spending.** `fetch-spend-breakdown` requires `start-date`, `end-date`, and
  `group-by`.

#### 2.6 Costco recipes

Costco is unverified. Write these recipes only after a fresh refresh token
allows a live call. Do not guess a field path.

- **Find an item in the purchase history.** Two costs compound here, and the
  recipe has to cut both. Batching alone cuts the call count and leaves the
  response size untouched — that is the same 35k-token failure moved to Costco.
  - **Escalate the window; do not open it wide.** Start at the 90-day default.
    Widen to 12 months only if nothing matched, then to 24 months. Stop at the
    first window that answers the question. The June failure came from the
    narrow default, but a 24-month first pass fails the same way from the other
    end.
  - **Chunk the barcodes.** Pass them through `_` in batches of at most 25. One
    unbounded batch over 24 months returns megabytes, and one failure loses
    every barcode in it.
  - **A projection rule for `receipt-detail` is a prerequisite.** Keep the
    barcode, the date, and each item's description and price. Nothing else. The
    recipe does not ship before the rule does.
  - **Descriptions are abbreviations**, for example `NEW STBX NES` for Starbucks
    Nespresso. Match on a normalized substring, and show the raw abbreviation in
    the answer so the user can judge the match.
- **Recent orders and receipts.** `orders` and `receipts`, with an explicit
  window.
- **Membership.** `membership`, one call.

## Testing

### Host tests

`src/http-clients-service.test.ts` already exists and covers `buildCliArgs` and
`classifyCliResult`. Add pure unit tests, with no network:

- projection applies per profile, and inside `results` for a partial result
- projection leaves `errors` unchanged
- a command with no rule returns its payload unchanged, and sets no `projected`
- a command with a rule sets `projected` to the rule key
- `raw: true` skips projection and omits `projected`
- an unresolved path produces no key
- a payload that makes the projector throw returns the raw payload, not a 500
- a string amount with 28 decimal places survives byte for byte
- an `accounts` array with two entries keeps both
- `_` renders positional arguments after `--`
- `_` with an array renders every value after one `--`
- `_` with an empty array renders no `--`
- a numeric positional renders as a string
- `AuthenticationError` for `costco` gives `flow: "token"`
- `AuthenticationError` with no service still gives `flow: "otp"`

Update the `wealthsimple-v2` string fixtures in the existing tests to
`wealthsimple`.

The idempotency key is derived by the agent, not by the host, so no host test
covers it. The write protocol is covered by a skill test.

### Skill tests

The Iron Law applies: no skill without a failing test first. The RED phase uses
the four recorded baseline failures above, not invented scenarios. Run each one
against the new skill.

The two discipline sections need a wording micro-test against a no-guidance
control, five repetitions each, with every flagged match read by hand. The
workspace `CLAUDE.md` requires this for a behavioral rule.

Add one more skill test for the write protocol: a split payment where the second
leg fails. The agent must retry only the failed leg, with its original key.

## Rollout

No step in this change rebuilds the container image. The mounts decide what a
change needs:

| Change | Reaches the agent by | Action needed |
|---|---|---|
| `container/skills/http-clients/**` | read-only bind mount at `/app/skills` | none; the next read picks it up |
| `container/agent-runner/src/**` | read-only bind mount at `/app/src` | restart the container |
| `http-clients.instructions.md` | composed into `CLAUDE.md` at spawn | restart the session |
| `src/**` (host) | the host process | restart nanoclaw |

Order: build and test the host, restart nanoclaw, then restart the running
containers.

## Acceptance criteria

The change is done when all of these hold in a real conversation.

1. "qual minha alocação?" is answered from two calls that return under 5 KB
   together, down from 133 KB.
2. The answer groups a repeated symbol across accounts into one line.
3. Asking the same question again re-fetches, and the numbers change after a
   trade.
4. A card payment over $200 shows every leg and every key before the first
   call, and runs only after an explicit "yes".
5. A Costco item search answers from the narrowest window that contains the
   item, and never returns more than 25 barcodes in one call.
6. `wc -w` on each of the three skill files is inside its budget.
7. `grep -rn wealthsimple-v2` matches nothing outside `docs/superpowers/`.

## Out of scope

- Aggregate commands inside the `http-clients` library. That is a different
  repository.
- A second tier of agent self-modification.
- Any change to the OneCLI credential path.
