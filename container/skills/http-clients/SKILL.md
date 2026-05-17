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

When any call returns `{status: "error", code: "auth_required"}`, check the `flow` field:

**flow: "token" (e.g. Costco)**:
1. Message the user: "Costco token expired for profile '<profile>'. Open costco.ca → DevTools → Application → Cookies → copy the `refresh_token` value and send it here."
2. When the user provides the token: `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>", token: "<token>" } })`
3. Retry the original operation.

**flow: "otp" (e.g. Wealthsimple)**:
1. Try login first (may succeed with saved claim): `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>" } })`
2. If response indicates OTP is required, message the user: "Wealthsimple OTP sent to your phone. Send me the code."
3. When the user provides the code: `http_clients({ service: "<name>", command: "login", args: { profile: "<profile>", otp: "<code>" } })`
4. Retry the original operation.

## Error handling

- `auth_required` — follow re-authentication flow above
- `cli_error` with help text — normal discovery output, read `message` field
- `cli_error` with other content — report the error message to the user
- Network/fetch error — report that the host service is unreachable

## Output

- Summarize results in natural language — don't dump raw JSON
- Use the messaging format appropriate for the channel (Telegram markdown, Slack mrkdwn, etc.)
- Be concise: totals, dates, and key details — skip noise
