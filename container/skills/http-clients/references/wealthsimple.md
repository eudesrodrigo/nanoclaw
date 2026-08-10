# Wealthsimple recipes

Projected keys, per `src/http-clients-projections.ts`. Every rule that keeps an amount also keeps a `currency` key next to it. Re-run with `raw: true` for anything not listed.

- `fetch-identity-positions` → `sym`, `accounts`, `qty`, `value`, `book`, `ret`, `currency`
- `fetch-all-accounts` → `id`, `nickname`, `type`, `currency`, `status`
- `fetch-account-combined-financials` → `id`, `deposits`, `value`, `ret`, `rate`, `currency`
- `fetch-credit-card-latest-statement` → `id`, `balance`, `outstanding`, `min`, `due`, `status`
- `fetch-credit-card-account` → `id`, `status`, `limit`, `current`, `outstanding`, `available`, `pending`, `statement_day`

## Discover accounts

`fetch-all-accounts` is the base of every other recipe. Closed and archived accounts are excluded by default — auditing them is a separate call.

Ask which accounts belong in the answer. Never pick a default set.

## Allocation by asset

1. `fetch-identity-positions` for the chosen profiles.
2. `fetch-all-accounts` for the account nicknames.
3. Sum `value` across every position sharing a `sym`.

- **One symbol is several positions.** The same symbol appears once per account holding it. A position's `accounts` field is an array — use every entry, not just the first.
- **Trust the `currency` key, not the security's.** A USD-traded security can still carry a `value` in CAD. Never guess the currency, and never convert it yourself.
- **Amounts are decimal strings**, some with 28 decimal places. Round to 2 decimals for display, and round only at the very end.
- **Cash is not a position.** Per account it is `fetch-account-combined-financials`'s `value` minus the sum of that account's `fetch-identity-positions` `value` entries.
- The projection drops `percentage_of_account` — a share of its own account, not the portfolio. Compute your own percentage from `value`.

Output:

```
• <symbol> — $<value> (<pct>%)
  – <account name>: $<value>
```

## Returns

`book` against `value`; `ret` is the unrealized amount. Per account, `fetch-account-combined-financials` takes `ids` as an array; its `ret` and `rate` carry the deposit-adjusted return. `rate` can be `null` on some accounts — say "not available", never "0". A portfolio line of credit reports a negative `value` here.

`ids` belongs to one profile. A mixed list under `profile: "all"` fails for every other profile's ids. Call once per profile.

## Read a card

`fetch-credit-card-account` with `id` gives the current running balance: `current`, `outstanding`, `available`, `pending`. `fetch-credit-card-latest-statement` with `id` gives the last closed "fatura": `balance`, `min`, `due`. `fetch-account-combined-financials` returns `0` for a card, so it is the wrong source. A portfolio line of credit is not a card — read it under Returns.

Output:

```
• Outstanding: $<amount>
  – Current: $<amount>
  – Pending: $<amount>
  – Available credit: $<amount>
```

## Pay a card

1. `fetch-all-accounts` — the source is a Wealthsimple `CASH` account from this list.
2. `fetch-credit-card-account` or `fetch-credit-card-latest-statement` — the amount owing.
3. Confirm in chat, then `credit-card-payment`.

- **The source is a Wealthsimple `CASH` account from `fetch-all-accounts`.** It is not `fetch-payment-methods`. That command's wording sounds like a match, but it returns external banks, not Wealthsimple cash accounts.
- Read `credit-card-payment`'s own `args: {help: true}` output for the exact argument names before the first live call. Don't guess them.
- The amount is in cents: `14161` is $141.61.
- One call is capped at 20000 cents. A larger balance needs one call per leg. Fill each leg to the cap and put the remainder last: $289.93 is `20000` then `8993`. Never split it evenly — a different split gives a different leg count, and the keys stop matching.
- Follow the write protocol in `SKILL.md` for the confirmation and the keys.

## Spending

`fetch-spend-breakdown` requires `start-date`, `end-date` and `group-by`. Ask for the window if the user did not give one.
