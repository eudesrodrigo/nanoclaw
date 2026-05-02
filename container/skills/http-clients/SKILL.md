---
name: http-clients
description: Query personal accounts and services (orders, purchases, receipts, memberships, bank info, spending) via the http-clients CLI. Trigger when the user asks about purchases, orders, receipts, account status, or data from any personal service account.
allowed-tools: Bash(http-clients *)
---

# http-clients

CLI tool for querying personal service accounts. Services and commands are auto-discovered — never assume what's available.

## Discovery

1. Run `http-clients --help` to see available services
2. Run `http-clients <service> --help` to see commands for a service
3. Run `http-clients <service> <command> --help` to see flags and options

Always discover before running. New services appear automatically — don't hardcode anything.

## Multi-profile

Some services have multiple profiles (e.g. family members with separate accounts). Use `<service> profiles` to list them. By default `--profile all` consolidates data from every profile — output is tagged with `[Name]` prefixes. Use `--profile <name>` to query a specific one.

## Error Handling

- `TokenNotFoundError` or missing token — tell the user their token for that service is not configured
- `AuthenticationError` — tell the user their token may have expired and needs to be recaptured
- For other errors, report the error message to the user

## Output

- Summarize results in natural language — don't dump raw CLI output
- Use the messaging format appropriate for the channel (Telegram markdown, Slack mrkdwn, etc.)
- Be concise: totals, dates, and key details — skip noise
