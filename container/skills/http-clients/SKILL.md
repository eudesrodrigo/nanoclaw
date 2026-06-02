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

Discovery output arrives in `{status: "error", code: "cli_error", message: "..."}` — read the `message` field for help text. This is expected behavior, not an error.

Always discover before running. New services and commands appear automatically — don't hardcode anything.

## Multi-profile

Some services have multiple profiles (e.g. family members with separate accounts). Use `http_clients({ service: "<name>", command: "profiles" })` to list them. `args: { profile: "all" }` runs across every profile — the output is a JSON object **keyed by profile name** (e.g. `{ "eudes": …, "magda": … }`), not tagged text. Use `args: { profile: "<name>" }` for one profile.

On a multi-profile read (`--profile all`), if some profiles fail the result is **partial**: `{ "results": { "<profile>": <data> }, "errors": { "<profile>": { "code": "...", "flow"?: "...", "hint"?: "...", "profile": "<profile>" } } }`. Deliver the data in `results` right away, then recover each entry in `errors` per its `code` (see Re-authentication / Error handling) — re-authenticate **only** the failed profiles, one at a time, addressing the right person by profile name. Never discard good data because another profile failed.

## Wealthsimple

Use `portfolio` with `args: { profile: "all" }` — one call returns, per profile, the
consolidated `total` plus every account with its live value, return, holdings, and a
derived `cash` line. It's the right source for allocation, returns, and per-account
breakdowns. (`positions` is holdings-only and excludes cash.)

**Always fetch fresh.** For any value / % / allocation / return question, call the API
right then. **Never** reuse numbers from earlier in the conversation or from memory — the
data moves and the user needs certainty.

**The data:**

- All money is **already in CAD**, even for USD securities (`market_value`, `book_value`,
  `unrealized_returns`). **Never convert USD→CAD yourself.** `security.currency` is the
  security's native currency (often `USD`) — **ignore it**; it does NOT mean the value is USD.
- Position value is `market_value` (the old `account_value` is gone). Returns
  (`simple_returns` per account/total, `unrealized_returns` per position) and
  `percentage_of_account` come from the API — don't recompute them.
- `simple_returns.rate` can be `null` (cash/save accounts) — handle gracefully.

**Consolidating across profiles/accounts:** group `holdings[].market_value` by
`security.symbol` and sum (already CAD); sum every account's `cash` into a "Caixa" line.
The headline total is the API's `total.net_liquidation_value`. Carteira return is
`net_liquidation_value − net_deposits` (includes realized + cash); the per-asset
`unrealized_returns` sum is only the unrealized gain on current holdings — the two won't
tie, so present the **carteira** figure as the official total.

### Output format — never tables (they break on Telegram)

One `•` bullet per asset; indented `–` sub-bullets for detail. Sort by value/return desc.

- **Allocation by asset:** `**Alocação consolidada (Eudes + Magda)** — Total: $110.234`
  then `• **TICKER** — $value (NN,N%)` per asset, a `• **Caixa** — …` line, and a
  tech-concentration rollup.
- **Total return:** headline `**Retorno total da carteira:** +$X (+Y%)`, then per asset
  `• **TICKER** — +$ret` with a sub-bullet `  – +N% sobre custo · M% do lucro`.
- **Per-account (sell decisions):** `• **TICKER** — $value` then a sub-bullet per account
  `  – <Owner> <RRSP/TFSA/FHSA>: $value` (account type matters for tax).

## Re-authentication

Credentials (email, password, saved tokens) live on the **host**. This agent never sees them and never needs them.

- **NEVER** ask the user for an email, password, or account login.
- **NEVER** look for credential files, and **NEVER** run shell/bash for http-clients — the `http_clients` tool is the only interface. There is no local CLI in this container.

When any call returns `{status: "error", code: "auth_required"}`, recover by calling `login` for that service — do not give up and do not ask for credentials:

**Wealthsimple (and any OTP-based service):**
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
