# http-clients Integration — Adopt GraphQL `portfolio` (drop the old stitch) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. This is a docs-only change to the agent-facing integration surface — no host/container code, no tests to write (markdown fragments, mounted live).

**Goal:** Update the nanoclaw `http_clients` integration so the agent fetches Wealthsimple data the **new** way — the consolidated `portfolio` command with live GraphQL values — instead of the **old** way (stitching `accounts` + `positions` by hand and assuming the stale REST field `account_value`).

**Why now:** The `http-clients` package shipped 0.6.0 (Wealthsimple REST → GraphQL). The CLI surface changed: a new `portfolio` command returns the consolidated total + per-account value/return + holdings + derived cash in one call, with **live** values; position field `account_value` was renamed `market_value`; cash is no longer a synthetic position; per-position `unrealized_returns` / `percentage_of_account` and per-account/identity `simple_returns` now come from the API. The integration docs the agent reads are generic and still implicitly steer it to the old pattern.

**Scope:** Two agent-facing files only. No host TypeScript, no container code, no package changes. (Error-classification adjustments are a separate track — see `docs/superpowers/specs/2026-06-02-http-clients-error-classification-and-observability-design.md`.)

---

## Contract change reference (package 0.6.0)

| | Old (REST) | New (GraphQL 0.6.0) |
|---|---|---|
| WS commands | `accounts`, `positions` | `accounts`, `positions`, **`portfolio`** |
| Consolidation | call both, merge/convert/compute cash by hand | one `portfolio` → `total` + per-account value/return/holdings + derived `cash` |
| Position value field | `account_value` | **`market_value`** |
| Returns | hand-computed | `simple_returns` (per account + `total`), `unrealized_returns` (per position) |
| % of account | hand-computed | `percentage_of_account` |
| Cash | synthetic line inside `positions` | excluded from `positions`; `portfolio` provides per-account `cash` |
| Freshness | stale REST snapshot | live (web-app source of truth) |

`portfolio` output shape (per profile): `{ total: {net_liquidation_value, net_deposits, simple_returns}, accounts: [{ account: {id, type, nickname, net_liquidation_value, net_deposits, simple_returns}, holdings: [{security:{symbol,name,...}, quantity, book_value, market_value, unrealized_returns, percentage_of_account}], cash }] }`. Under `--profile all`, wrapped per profile (and partial-result shape on per-profile failure, already documented).

---

## File structure

- Modify: `container/agent-runner/src/mcp-tools/http-clients.instructions.md` — add a short Wealthsimple subsection steering to `portfolio`. This file is symlinked into every group's `CLAUDE.md` via `.claude-fragments/module-http-clients.md`, so the edit reaches all agents with no regeneration.
- Modify: `container/skills/http-clients/SKILL.md` — add the parallel guidance in the mounted container skill.

Design note (decided): keep the steering **lean and Wealthsimple-scoped**. Field names are discoverable at runtime from the JSON; we name only the load-bearing rename (`account_value` → `market_value`) and the behavioral shifts (prefer `portfolio`, values are live, cash is separate, returns come from the API). We do **not** enumerate every field — that would re-stale on the next package change.

---

### Task 1: Steer the auto-loaded instructions to `portfolio`

**Files:**
- Modify: `container/agent-runner/src/mcp-tools/http-clients.instructions.md`

- [ ] **Step 1: Add a Wealthsimple subsection**

After the `### Response format` section (before `### Re-authentication`), insert:

```markdown
### Wealthsimple data (use `portfolio`)

For account values, holdings, and returns, call `portfolio` — a single call returns the
consolidated `total` plus every account with its live value, return, holdings, and a
derived `cash` line. Prefer it over calling `accounts` + `positions` separately and
consolidating by hand.

- Values are **live** (the Wealthsimple web-app source of truth) — not a stale snapshot.
- Position market value is `market_value` (the old `account_value` field is gone).
- Returns come from the API: `simple_returns` (per account and on `total`) and
  `unrealized_returns` (per position). Don't recompute returns yourself.
- Cash is a separate per-account field, not a position.
- `args: { profile: "all" }` consolidates across profiles (partial-result shape applies).
```

- [ ] **Step 2: Verify the symlink resolves the edit**

Run: `readlink groups/dm-with-home/.claude-fragments/module-http-clients.md`
Expected: `/app/src/mcp-tools/http-clients.instructions.md` (container path; confirms the fragment is the live file — no regeneration needed).

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/mcp-tools/http-clients.instructions.md
git commit -m "feat(http-clients): steer agent to Wealthsimple portfolio (GraphQL) over manual stitch"
```

---

### Task 2: Mirror the guidance in the mounted skill

**Files:**
- Modify: `container/skills/http-clients/SKILL.md`

- [ ] **Step 1: Add the same steering**

Replace the `## Output` section header block by inserting a new section **before** `## Output`:

```markdown
## Wealthsimple

For account values, holdings, and returns, use the `portfolio` command — one call returns
the consolidated total plus every account with live value, return, holdings, and derived
cash. Prefer it over stitching `accounts` + `positions` by hand. Values are live (web-app
source of truth); position value is `market_value` (the old `account_value` is gone);
returns (`simple_returns`, `unrealized_returns`) and `percentage_of_account` come from the
API — don't recompute them; cash is a separate per-account field.
```

- [ ] **Step 2: Sanity-check markdown**

Run: `git diff --stat container/skills/http-clients/SKILL.md`
Expected: file shows as modified.

- [ ] **Step 3: Commit**

```bash
git add container/skills/http-clients/SKILL.md
git commit -m "docs(http-clients skill): prefer Wealthsimple portfolio (GraphQL) over manual stitch"
```

---

### Task 3: Live verification (optional, needs credentials)

- [ ] **Step 1: Confirm `portfolio` is discoverable and returns the new shape**

Run (host): `http-clients wealthsimple portfolio --profile eudes` (or via a running container's `http_clients` tool).
Expected: JSON with `{ <profile>: { total: {...}, accounts: [{account, holdings, cash}] } }`; holdings carry `market_value`; no `account_value`. If it asks for OTP, that's the normal re-auth flow — not a blocker for the docs change.

Note: prompt/skill changes are mounted, so they go live on the agent's next turn — no container rebuild, no host restart.

---

## Self-review

- **Coverage:** new `portfolio` command surfaced (Task 1+2); old `account_value` rename called out; "don't recompute returns / cash is separate / values are live" behavioral shifts captured; both agent-facing surfaces (auto-loaded fragment + mounted skill) updated.
- **No host/container code or tests touched** — correct for a prompt-only change.
- **Symlink propagation** verified in Task 1 Step 2 (no fragment regeneration step needed).
- **Out of scope:** error-classification/observability adjustments (separate spec); package changes; any group-level `CLAUDE.local.md` agent memory (runtime state, not source-controlled here).
