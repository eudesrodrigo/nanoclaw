---
name: costco
description: Navigate Costco.ca for purchase history, price checks, product search, and general account access. Trigger when user asks about Costco, purchases, groceries, or product prices.
allowed-tools: Bash(agent-browser:*), Bash(node *)
---

# Costco

Browser-based access to the user's Costco.ca account. Use agent-browser to navigate, authenticate, and extract information.

## Rules

- **Always use `send_message` with plain text.** Never use cards, structured outputs, or any other format.
- **Use Telegram formatting only:** single `*asterisks*` for bold, `_underscores_` for italic, `•` for bullets. No markdown headings, no `**double asterisks**`, no `[links](url)`.
- **Authenticate before navigating.** Always verify you are logged in before attempting any account-specific action.

## Authentication

1. Open Costco and check if already logged in:
   ```bash
   agent-browser open "https://www.costco.ca/my-account"
   agent-browser snapshot -i
   ```

2. If you see a login page (sign-in form, "Sign In" button, etc.) instead of the account page, log in:
   ```bash
   agent-browser auth login costco
   ```

3. Wait for the page to load and verify login succeeded:
   ```bash
   agent-browser snapshot -i
   ```
   You should see "My Account" or the user's name. If login failed, notify the user and stop.

No 2FA is required for Costco.

## Purchase History

1. Navigate to order history:
   ```bash
   agent-browser open "https://www.costco.ca/myaccount/#/app/e442e6e6-2602-4a39-937b-8b28b4457ed3/ordersandpurchases"
   agent-browser snapshot -i
   ```

2. Extract order information from the page — dates, items, totals.

3. If the user asks about a specific order, click into it for details.

4. For older orders, look for pagination or date range filters on the page.

## Product Search

1. Navigate to search:
   ```bash
   agent-browser open "https://www.costco.ca/CatalogSearch?keyword={query}"
   agent-browser snapshot -i
   ```

2. Extract product names, prices, availability from the results.

3. Click into a product for full details (description, price, reviews).

## Price Check

1. Navigate directly to the product page if you have the URL, or search first.

2. Extract the current price, any discounts, and member pricing.

3. Report back with the price details.

## General Navigation

For any other Costco request:

1. Navigate to the relevant page
2. Take a snapshot to understand the current state
3. Interact as needed (click, fill forms, scroll)
4. Report findings to the user

## Tips

- Costco.ca may show different content based on warehouse membership (the user has a Canadian membership)
- Prices on costco.ca are warehouse prices, which may differ from in-store
- Some items are online-only, some are warehouse-only
- If a page requires interaction (clicking tabs, expanding sections), use `agent-browser click` with the appropriate selector
