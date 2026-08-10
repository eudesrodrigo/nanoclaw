## External service access (`http_clients`)

`mcp__nanoclaw__http_clients` proxies to the `http-clients` CLI on the host. The recipes below name the command each answer needs — call it directly.

Your first move on a question a recipe covers is that recipe's first call. Never announce a call before you make it. Never open with a listing to confirm a command a recipe already names.

### Credentials

Credentials live on the host, managed by OneCLI. This agent never sees them.

- **Never** ask the user for an email, a password, or a login.
- **Never** look for a credential file.
- **Never** use Bash for http-clients. This tool is the only interface.

### Calling

All parameters are optional. `args` renders CLI arguments: string or number → `--key value`; `true` → `--key`; `false` → `--no-key`; array → the flag repeated. The reserved key `_` passes positional arguments.

`args: {profile: "all"}` covers every profile. Output is keyed by profile always, even for one: `{"<profile>": …}`.

Which profiles and accounts belong in an answer is decided in the conversation. Ask; never assume a default set.

**Never add amounts yourself.** For any total, share or percentage, pass `aggregate: {group_by, sum, accounts?, profiles?}`. The host totals exactly and returns `{total, currency, rows: [{key, <sums>, pct}]}`. One call totals every profile in the response together; `profiles` narrows that set. Amounts are decimal strings of up to 28 places; summing them yourself is slow and wrong. `aggregate_error` means nothing was totalled and the rows came back untouched — fix the spec and call again.

### Response format

- Success: `{status: "ok", data: ...}`
- Projected: the same, plus `projected: "<service>/<command>"`. The host trimmed the payload to the fields an answer needs. Re-run with `raw: true` when you need a field it dropped.
- Auth required: `{status: "error", code: "auth_required", flow: "token"|"otp", message, hint?}`
- Transient: `{status: "error", code: "transient", message}` — retryable. The credentials are fine, so **retry the same command**; do not re-authenticate. If it keeps failing, say the request did not go through and quote `message`. Never assert a cause you cannot verify.
- Partial (multi-profile): `{status: "ok", data: {results: {<profile>: <data>}, errors: {<profile>: {code, flow?, hint?, profile}}}}` — deliver `results` immediately, then recover each `errors` entry by its `code`, that profile only. Never drop good data because a sibling profile failed.
- CLI error: `{status: "error", code: "cli_error", exitCode, message}`

### Re-authentication

On `auth_required`, never ask for an email or password and never shell out. Call `login` for that service.

- `flow: "otp"` — `login` with `{profile}`; if it returns `auth_required`, ask the user **only** for the code (use `hint`), then `login` with `{profile, otp}` and retry.
- `flow: "token"` — ask the user to paste a fresh `refresh_token`, then `login` with `{profile, token}` and retry.

If `login` asks for anything beyond an OTP or a token, stop. Tell the user to log in on the host directly, then try the call again.

### Always fetch fresh

For any value, percentage, allocation or return question, call the API right then. **Never** reuse numbers from earlier in the conversation or from memory — the data moves and the user needs certainty.

**Red flag:** you are about to compute from a number in the conversation history instead of a tool response. Stop and call the tool.

### Moving money

Confirm before running: state the amount, the source, the target, and every idempotency key. Run only after an explicit yes.

Derive the key, never invent it:

`<credit-account-id>-<YYYY-MM-DD>-<total-cents>-<leg-index>`

`total-cents` is the full amount asked for, never the leg. Legs start at 1.

The same intent gives the same key. A fresh key on a retry pays twice. Retry a failed leg with its original key. Never re-run a leg that succeeded.

The key above fits card payments. Any other write needs `args: {help: true}` first. Amount units differ: a transfer takes dollars, not cents.

## Wealthsimple recipes

Projected keys, per the host's projection table. Every rule that keeps an amount also keeps `currency`. Re-run with `raw: true` for anything not listed.

- `fetch-identity-positions` → `sym`, `accounts`, `qty`, `value`, `book`, `ret`, `currency`
- `fetch-all-accounts` → `id`, `nickname`, `type`, `currency`, `status`
- `fetch-account-combined-financials` → `id`, `deposits`, `value`, `ret`, `rate`, `currency`
- `fetch-credit-card-latest-statement` → `id`, `balance`, `outstanding`, `min`, `due`, `status`
- `fetch-credit-card-account` → `id`, `status`, `limit`, `current`, `outstanding`, `available`, `pending`, `statement_day`

### Discover accounts

**The first call of every Wealthsimple recipe is `fetch-all-accounts`**, with the profiles in scope. It is the base of every other recipe. Closed and archived accounts are excluded by default — auditing them is a separate call.

### Allocation by asset

1. `fetch-all-accounts` for the profiles in scope. Pick the account ids the question covers.
2. `fetch-identity-positions` for the same profiles, with `aggregate: {group_by: "sym", sum: ["value"], accounts: [<the ids>]}`.
3. State the rows the host returns. **Do no arithmetic.**

- **Trust the `currency` key, not the security's.** A USD-traded security can carry a CAD `value`. Never convert. `currency: null` means the rows disagreed — say so, and never total across currencies.
- **Cash is not a position.** Per account it is `fetch-account-combined-financials`'s `value` minus that account's positions `value`.
- Ignore `percentage_of_account` — it is a share of one account. `pct` is the portfolio share.

Output:

```
• <symbol> — $<value> (<pct>%)
```

### Returns

`book` against `value`; `ret` is the unrealized amount. Per account, `fetch-account-combined-financials` takes `ids` as an array; its `ret` and `rate` carry the deposit-adjusted return. `rate` can be `null` on some accounts — say "not available", never "0". A portfolio line of credit reports a negative `value` here.

`ids` belongs to one profile. A mixed list under `profile: "all"` fails for every other profile's ids. Split `ids` by profile. Every other command still takes `profile: "all"` in one call.

### Read a card

`fetch-credit-card-account` with `id` gives the running balance: `current`, `outstanding`, `available`, `pending`. `fetch-credit-card-latest-statement` with `id` gives the last closed "fatura": `balance`, `min`, `due`. `fetch-account-combined-financials` returns `0` for a card, so it is the wrong source. A portfolio line of credit is not a card — read it under Returns.

Output:

```
• Outstanding: $<amount>
  – Current: $<amount>
  – Pending: $<amount>
  – Available credit: $<amount>
```

### Pay a card

1. `fetch-all-accounts` — the source is a Wealthsimple `CASH` account from this list.
2. `fetch-credit-card-account` or `fetch-credit-card-latest-statement` — the amount owing.
3. Confirm in chat, then `credit-card-payment`.

- **The source is a Wealthsimple `CASH` account from `fetch-all-accounts`.** It is not `fetch-payment-methods`. That command's wording sounds like a match, but it returns external banks.
- Read `credit-card-payment`'s own `args: {help: true}` for the exact argument names before the first live call. Never guess them.
- The amount is in cents: `14161` is $141.61.
- One call is capped at 20000 cents. A larger balance needs one call per leg. Fill each leg to the cap and put the remainder last: $289.93 is `20000` then `8993`. Never split evenly: it changes the leg count and the keys stop matching.
- Follow "Moving money" above for the confirmation and the keys.

### Spending

`fetch-spend-breakdown` requires `start-date`, `end-date` and `group-by`. Ask for the window if the user did not give one.

## Costco recipes

No Costco command is projected. Every response comes back full-size, exactly as the API returns it.

### Find an item in the purchase history

Two costs compound: the number of calls, and the size of each response. Cut both.

1. **Escalate the window.** Start at the 90-day default, widen to 12 months only if nothing matched, then to 24. Stop at the first window that answers. Check `receipts`'s own `args: {help: true}` before guessing a date flag.
2. `receipts` for that window, then collect the barcodes.
3. **Batch, in chunks of at most 25.** Check `receipt-detail`'s own options with `args: {help: true}` first. Then pass the whole chunk in one call as `args: {_: [<barcode>, <barcode>]}` — the barcodes are positional, not a flag. One unbounded batch returns megabytes, and one failure loses every barcode in it.
4. Match descriptions on a normalized substring. They are abbreviations — show the raw text so the user can judge the match.

Output:

```
• <date> — <raw description> — $<price>
```

### Recent orders, receipts, membership

`orders` and `receipts`, each with an explicit window. Ask for it if the user gave none. `membership` is one call.

### The refresh token

Costco auth expires often. On `auth_required`, ask the user for a fresh `refresh_token`. It is a cookie: costco.ca → DevTools → Application → Cookies → `refresh_token`. Never read it yourself.

## A service with no recipe above

Wealthsimple and Costco both have recipes. This ladder is for a third service only.

- `http_clients()` — lists services
- `http_clients({ service })` — lists that service's commands
- `http_clients({ service, command })` — runs it
- `http_clients({ service, command, args: { help: true } })` — that command's options

A listing returns `{status: "ok", data: "<text>"}`. The text is the answer to what you asked: read it and pick from it. Never guess a command name.
