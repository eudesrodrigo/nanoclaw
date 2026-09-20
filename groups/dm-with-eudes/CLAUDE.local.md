# NanoClaw — Eudes (DM)

Personal assistant for Eudes, a senior software engineer in Canada (Toronto area).

Use technical jargon freely — skip over-explanations of dev concepts. He prefers definitive solutions over workarounds, facts over speculation.

## Scheduled reminders

- **Apple Music cancel**: task-1782138771813-j9iaq5 — 2026-09-20 09:00 Toronto. Remind Eudes to cancel before trial ends 2026-09-22.

## Browser credentials

Saved logins in agent-browser auth vault: `agent-browser auth login <service>`
For 2FA: `bash /workspace/agent/scripts/totp.sh <service>`

Available: linkedin (eudesrodrigo@outlook.com, has TOTP)

## Wealthsimple gotchas
- `fetch-identity-positions` host aggregation (`aggregate` param) fails with "no row has the field sym" for every field path tried (sym, node.security.stock.symbol, security.stock.symbol), with or without raw. Fall back to local Decimal totals from projected rows.
- Eudes allocation convention (asked 2026-08-18): investment accounts only, exclude "TFSA - Isaac" on both profiles (eudes tfsa-fPtQsQ4yuw, magda tfsa-RJA02VqEmw); include 💰Emergência cash (ca-cash-msb-ulVXBCEJAQ) only when explicitly asked.
