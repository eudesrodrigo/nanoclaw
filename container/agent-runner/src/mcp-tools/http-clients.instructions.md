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
- Auth required: `{status: "error", code: "auth_required", flow: "token"|"otp", message: "..."}`
- CLI error: `{status: "error", code: "cli_error", exitCode: <number>, message: "..."}`
