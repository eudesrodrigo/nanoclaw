## External service access (`http_clients`)

`mcp__nanoclaw__http_clients` proxies to the `http-clients` CLI on the host. Credentials are managed on the host — this agent never sees them.

### Discovery

All parameters are optional. Omit fields to discover what's available:

- `http_clients()` — lists available services
- `http_clients({ service: "costco" })` — lists commands for that service
- `http_clients({ service: "costco", command: "receipts" })` — executes the command

Discovery output arrives as `{status: "error", code: "cli_error", message: "..."}` — read the `message` field for the help text. This is normal (the CLI writes help to stderr).

### Parameters

- `service` (string, optional) — service name (e.g. `costco`, `wealthsimple`)
- `command` (string, optional) — CLI command (e.g. `receipts`, `positions`, `login`, `profiles`)
- `args` (object, optional) — key-value pairs passed as CLI flags (e.g. `{profile: "eudes", type: "warehouse"}`)

### Response format

- Success: `{status: "ok", data: ...}`
- Auth required: `{status: "error", code: "auth_required", flow: "token"|"otp", message: "...", hint?: "..."}`
- Transient: `{status: "error", code: "transient", message: "..."}` — a retryable network/timeout/5xx blip. The credentials are fine: **just retry the same command** (do not re-authenticate, do not ask for an OTP). If it still fails after a couple of retries, tell the user it's a temporary upstream issue.
- CLI error: `{status: "error", code: "cli_error", exitCode: <number>, message: "..."}`

### Re-authentication

Credentials live on the host — this agent never sees or needs them. On `{code: "auth_required"}`, **never** ask for an email/password and **never** shell out: call `login` for the service.

- `flow: "otp"` (e.g. Wealthsimple): call `login` with `{profile}`; if it returns `auth_required/flow:"otp"`, ask the user **only** for the OTP code (use `hint`), then call `login` with `{profile, otp}` and retry.
- `flow: "token"` (e.g. Costco): ask the user to paste a fresh `refresh_token`, then `login` with `{profile, token}` and retry.
