# Costco recipes

No Costco command is projected. Every response comes back full-size, exactly as the API returns it.

## Find an item in the purchase history

Two costs compound: the number of calls, and the size of each response. Cut both.

1. **Escalate the window.** Start at the 90-day default. Widen to 12 months only if nothing matched, then to 24. Stop at the first window that answers the question. Check `receipts`'s own options with `args: {help: true}` before guessing a date flag.
2. `receipts` for that window, then collect the barcodes.
3. **Batch, in chunks of at most 25.** Check `receipt-detail`'s own options with `args: {help: true}` first. Then pass the whole chunk in one call as `args: {_: [<barcode>, <barcode>]}` — the barcodes are positional, not a flag. One unbounded batch over two years returns megabytes, and one failure loses every barcode in it.
4. Match item descriptions on a normalized substring. Descriptions are abbreviations — show the raw text in the answer so the user can judge the match.

Output:

```
• <date> — <raw description> — $<price>
```

## Recent orders and receipts

`orders` and `receipts`, each with an explicit window. Ask for the window if the user did not give one.

## Membership

`membership`, one call.

## The refresh token

Costco auth expires often. On `auth_required`, ask the user for a fresh `refresh_token`. It is a cookie: costco.ca → DevTools → Application → Cookies → `refresh_token`. Never read it yourself.
