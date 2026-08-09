---
name: http-clients
description: Use when the user asks about their own accounts at an external service — balance, portfolio allocation, positions, returns, net worth, credit card balance or statement, spending, purchases, orders, receipts, membership — or asks to pay a card or move money between their own accounts. Portuguese triggers: alocação, posições, retorno, patrimônio, fatura, cartão, quanto gastei, quando compramos, extrato, pagar cartão.
allowed-tools: mcp__nanoclaw__http_clients, Read
---

# http-clients

Discover; never assume.

## Recipes

Read the reference file before combining calls. It lists the projected keys too.

- `references/wealthsimple.md` — accounts, allocation, returns, card, paying, spending
- `references/costco.md` — orders, receipts, item history, membership

## Profiles

`args: {profile: "all"}` covers every profile. Output is keyed by profile always, even for one: `{"<profile>": …}`.

Which profiles and accounts belong in an answer is decided in the conversation. Ask; never assume a default set.

## Moving money

Confirm before running: state the amount, the source, the target, and every idempotency key. Run only after an explicit yes.

Derive the key, never invent it:

`<credit-account-id>-<YYYY-MM-DD>-<total-cents>-<leg-index>`

`total-cents` is the full amount asked for, never the leg. Legs start at 1.

The same intent gives the same key. A fresh key on a retry pays twice. Retry a failed leg with its original key. Never re-run a leg that succeeded.

The key above fits card payments. Any other write needs `args: {help: true}` first. Amount units differ: a transfer takes dollars, not cents.

## Always fetch fresh

For any value, percentage, allocation or return question, call the API right then. **Never** reuse numbers from earlier in the conversation or from memory — the data moves and the user needs certainty.

**Red flag:** you are about to compute from a number in the conversation history instead of a tool response. Stop and call the tool.

## Credentials

Credentials live on the host, managed by OneCLI. This agent never sees them.

- **Never** ask the user for an email, a password, or a login.
- **Never** look for a credential file.
- **Never** use Bash for http-clients. The tool is the only interface.

On `auth_required`, call `login` for that service — the flow is in the tool instructions. If `login` then asks for anything beyond an OTP or a token — an email, a password — stop. Tell the user to log in on the host directly, outside this tool. Then try the call again.
