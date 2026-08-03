---
name: http-clients
description: Query personal accounts and services (orders, purchases, receipts, memberships, bank info, spending) via the http-clients CLI. Trigger when the user asks about purchases, orders, receipts, account status, or data from any personal service account.
allowed-tools: mcp__nanoclaw__http_clients
---

# http-clients

MCP tool for querying personal service accounts via the host. Services and commands are auto-discovered — never assume what's available.

## Discovery

1. `http_clients()` — list available services
2. `http_clients({ service: "<name>" })` — list commands for a service
3. `http_clients({ service: "<name>", command: "<cmd>" })` — execute a command

Discovery output arrives in `{status: "error", code: "cli_error", message: "..."}` — read the `message` field for help text. This is expected: the CLI writes its command list to stdout but exits non-zero, so it's classified as `cli_error` despite containing the useful output.

Always discover before running. New services and commands appear automatically — don't hardcode anything.

## Multi-profile

Some services have multiple profiles (e.g. family members with separate accounts). Use `http_clients({ service: "<name>", command: "profiles" })` to list them. `args: { profile: "all" }` runs across every profile — the output is a JSON object **keyed by profile name** (e.g. `{ "eudes": …, "magda": … }`), not tagged text. Use `args: { profile: "<name>" }` for one profile.

On a multi-profile read (`--profile all`), if some profiles fail the result is **partial**: `{ "results": { "<profile>": <data> }, "errors": { "<profile>": { "code": "...", "flow"?: "...", "hint"?: "...", "profile": "<profile>" } } }`. Deliver the data in `results` right away, then recover each entry in `errors` per its `code` (see Re-authentication / Error handling) — re-authenticate **only** the failed profiles, one at a time, addressing the right person by profile name. Never discard good data because another profile failed.

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
  one command's options and their types. Unlike the listings above, this route returns
  `{status: "ok", data: "<help text>"}` — read `data`, not `message`.

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

- **By asset:** `**Alocação consolidada (Eudes + Magda)** — Total: $X.XXX` then
  `• **TICKER** — $value (NN,N%)` per asset.
- **Returns:** headline `**Retorno total:** +$XXX (+N%)`, then per asset
  `• **TICKER** — +$ret` with a sub-bullet `  – +N% sobre custo`.
- **Per-account:** `• **TICKER** — $value` then a sub-bullet per account
  `  – <Owner> <RRSP/TFSA/FHSA>: $value` (account type matters for tax).
- **Debt:** `• **Cartão** — $XX,XX devidos · limite disponível $X.XXX,XX` and
  `• **Linha de crédito** — -$X.XXX,XX`.

## Re-authentication

Credentials (email, password, saved tokens) live on the **host**. This agent never sees them and never needs them.

- **NEVER** ask the user for an email, password, or account login.
- **NEVER** look for credential files, and **NEVER** run shell/bash for http-clients — the `http_clients` tool is the only interface. There is no local CLI in this container.

When any call returns `{status: "error", code: "auth_required"}`, recover by calling `login` for that service — do not give up and do not ask for credentials:

**Wealthsimple (and any OTP-based service):**

`login` and `profiles` are shared with the older `wealthsimple` client — same credentials record, so authenticating through either covers both.

1. Call `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>" } })`.
   - `{status: "ok"}` → re-authenticated. Retry the original call.
   - `{code: "auth_required", flow: "otp", hint}` → a one-time code is needed (the host has the password; only the OTP is missing).
2. Ask the user **only** for the code: "Código OTP enviado para seu telefone{hint}. Me manda o código."
3. When the user replies: `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>", otp: "<code>" } })`.
4. Retry the original call.

**Costco (refresh-token paste):**
On any Costco `auth_required` (regardless of `flow`):
1. Ask the user to paste a fresh refresh token: "Open costco.ca → DevTools → Application → Cookies → copy the `refresh_token` value and send it here."
2. `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>", token: "<token>" } })`.
3. Retry the original call.

## Error handling

- `auth_required` — follow re-authentication flow above
- `transient` — a retryable network/timeout/5xx error; credentials are fine. **Retry the same command** — do NOT re-authenticate or ask for an OTP. If it still fails after a couple of retries, say plainly that the request didn't go through right now and include the actual `message`. Do NOT assert a cause you can't verify (e.g. "the provider is down") — you only know the call failed, not why.
- `cli_error` with help text — normal discovery output, read `message` field
- `cli_error` with other content — report the error message to the user
- Network/fetch error — report that the host service is unreachable

## Output

- Summarize results in natural language — don't dump raw JSON
- Use the messaging format appropriate for the channel (Telegram markdown, Slack mrkdwn, etc.)
- **Never use tables** — they render badly on Telegram. Use bullet points (`•`) with indented `–` sub-bullets for detail.
- Be concise: totals, dates, and key details — skip noise
