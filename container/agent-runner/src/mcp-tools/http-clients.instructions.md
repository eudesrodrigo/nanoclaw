## External service access (`http_clients`)

`mcp__nanoclaw__http_clients` proxies to the `http-clients` CLI on the host. Credentials are managed on the host — this agent never sees them.

### Discovery

All parameters are optional. Omit fields to discover what's available:

- `http_clients()` — lists available services
- `http_clients({ service: "costco" })` — lists commands for that service
- `http_clients({ service: "costco", command: "receipts" })` — executes the command

Discovery output arrives as `{status: "error", code: "cli_error", message: "..."}` — read the `message` field for the help text. This is normal (the CLI writes its command list to stdout but exits non-zero, so it's classified as `cli_error` despite containing the useful output).

### Parameters

- `service` (string, optional) — service name (e.g. `costco`, `wealthsimple-v2`)
- `command` (string, optional) — CLI command (e.g. `receipts`, `fetch-identity-positions`, `login`, `profiles`)
- `args` (object, optional) — key-value pairs passed as CLI flags. String/number → `--key value`; `true` → `--key`; `false` → `--no-key`; array → the flag repeated (`{ids: ["a","b"]}` → `--ids a --ids b`)

### Response format

- Success: `{status: "ok", data: ...}`
- Auth required: `{status: "error", code: "auth_required", flow: "token"|"otp", message: "...", hint?: "..."}`
- Transient: `{status: "error", code: "transient", message: "..."}` — a retryable network/timeout/5xx error. The credentials are fine: **just retry the same command** (do not re-authenticate, do not ask for an OTP). If it still fails after a couple of retries, say plainly that the request didn't go through right now and include the actual `message`. Do not assert a cause you can't verify — you only know the call failed, not why.
- Partial (multi-profile reads): `{status: "ok", data: {results: {<profile>: <data>}, errors: {<profile>: {code, flow?, hint?, profile}}}}` — deliver `results` immediately, then recover each `errors` entry by its `code` for that profile only (one at a time). Don't drop good data because a sibling profile failed.
- CLI error: `{status: "error", code: "cli_error", exitCode: <number>, message: "..."}`

### Wealthsimple (`wealthsimple-v2`)

26 commands, one per Wealthsimple GraphQL query, returned with no reshaping. There is no
aggregated "portfolio" command — a question about value, allocation or return is answered
by combining calls, and what belongs in the answer is decided in the conversation.

**Always fetch fresh** for any value / % / return question — never reuse numbers from
earlier in the conversation or from memory; the data moves and the user needs certainty.

Don't guess command names. Omit `command` for the full list grouped by domain; pass
`args: { help: true }` for one command's options and their types — that route returns
`{status: "ok", data: "<help text>"}`, not the `cli_error` envelope the listings above use.

**Positions** — `fetch-identity-positions`
- Symbol is at `security.stock.symbol`, **not** `security.symbol`.
- `security.currency` is the security's native currency (often `USD`); the amount in
  `total_value` is already CAD. **Never convert.**
- Value is `total_value.amount`, a decimal **string**.
- `percentage_of_account` is a percentage of its own account, not of the portfolio.
- `accounts[].id` links a position to its account. Closed accounts return no positions.

**Accounts** — `fetch-all-accounts`
- Large (tens of KB) and has no server-side filter.
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

### Re-authentication

Credentials live on the host — this agent never sees or needs them. On `{code: "auth_required"}`, **never** ask for an email/password and **never** shell out: call `login` for the service.

- `flow: "otp"` (e.g. Wealthsimple): call `login` with `{profile}`; if it returns `auth_required/flow:"otp"`, ask the user **only** for the OTP code (use `hint`), then call `login` with `{profile, otp}` and retry.
- `flow: "token"` (e.g. Costco): ask the user to paste a fresh `refresh_token`, then `login` with `{profile, token}` and retry.
