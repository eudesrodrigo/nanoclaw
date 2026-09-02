# Wealthsimple card monitor

Recurring task created by the admin (host session) on 2026-09-02. The design
was agreed with Eudes in this group on 2026-09-02 — do not re-ask the closed
decisions below.

## Moving parts

- **Task**: series `task-1788370096846-axgvur` (see CLAUDE.local.md),
  cron `*/15 * * * *`. A pre-task script runs before you wake; you are only
  woken when there is something to act on.
- **Script**: `/workspace/agent/scripts/card-monitor.sh` — fetches the card
  feed read-only and updates the state file. Admin-owned: never edit it and
  never call http-clients from Bash yourself; if it needs a change, tell Eudes
  to ask the admin.
- **State**: `/workspace/agent/card_monitor_state.json` —
  `seen[<activity-id>] = {st: seeded|notified|paid, amount (cents), merchant, at}`.
  This file is the single source of truth for "was purchase X paid?".
- **Card**: `ca-credit-card-cxPxfAh-WA` (Eudes's Visa Infinite Privilege, the
  only card — Magda has none; do not monitor anything else).

## When you wake with `newPurchases`

For each purchase, send one group message in this exact shape (times in
America/Toronto):

```
🔔 Nova compra no cartão
<merchant> — $<amount> CAD
<dd/mm> às <HH:MM>

Sugestão de conta: <account name>

Pagar agora (adiantado, valor exato)?
```

- Suggest the paying account by matching the merchant to the named
  Wealthsimple CASH accounts (`fetch-all-accounts`): groceries/gas →
  `🛒 Mercado e Gas`, restaurants → `👨🏻‍🍳Restaurant`, car → `🚙 Carro`, etc.
  No obvious match → `Geral`. If Eudes names another account, use that one.
- On an explicit "sim": pay the exact purchase amount from the suggested CASH
  account, following the "Pay a card" recipe (amount in cents, idempotency
  keys, confirm before running).
- **Purchase over $200.00**: do not pay and do not split. Say the amount is
  above the automation's limit and Eudes must pay manually in the app.
- After a successful payment, set that purchase's `st` to `"paid"` in the
  state file. (If you forget, the script self-heals on the next tick by
  matching the payment in the feed.)

## When you wake with `alert`

- `auth_required`: tell the group once, in one line, that card checks are
  paused until Wealthsimple is re-authenticated, and offer to run the OTP
  login when Eudes is ready. The script stays silent until auth recovers.
- `check_failing`: tell the group once that the card check has been failing
  repeatedly (include the error message).

## Closed decisions (agreed 2026-09-02 — do not re-ask)

- Every purchase notifies: no minimum amount, no quiet window.
- A manual payment equal in value to a notified purchase marks it paid
  automatically (script does this, silently). Known accepted risk: two open
  purchases with the same exact value can be mismatched.
- `paidMarked` entries in the script output need no message.
- "Já paguei X?" → answer from the state file, never from memory.
