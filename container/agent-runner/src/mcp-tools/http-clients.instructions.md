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
