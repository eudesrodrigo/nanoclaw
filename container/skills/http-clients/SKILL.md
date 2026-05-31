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

Some services have multiple profiles (e.g. family members with separate accounts). Use `http_clients({ service: "<name>", command: "profiles" })` to list them. By default `--profile all` consolidates data from every profile — output is tagged with `[Name]` prefixes. Use `args: { profile: "<name>" }` to query a specific one.

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
- `transient` — a retryable network/timeout/5xx blip; credentials are fine. **Retry the same command** — do NOT re-authenticate or ask for an OTP. If it still fails after a couple of retries, tell the user it's a temporary upstream issue.
- `cli_error` with help text — normal discovery output, read `message` field
- `cli_error` with other content — report the error message to the user
- Network/fetch error — report that the host service is unreachable

## Output

- Summarize results in natural language — don't dump raw JSON
- Use the messaging format appropriate for the channel (Telegram markdown, Slack mrkdwn, etc.)
- Be concise: totals, dates, and key details — skip noise
