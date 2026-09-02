#!/usr/bin/env bash
# Card monitor — pre-task script for the recurring schedule_task series.
# Runs inside the agent container before the agent wakes. Read-only: it only
# fetches the Wealthsimple card feed via the host http-clients service and
# keeps a state file. It never moves money — payment stays in the agent turn.
#
# Contract (container/agent-runner/src/scheduling/task-script.ts): the last
# stdout line must be {"wakeAgent": bool, "data": {...}}. Budget: 30s total,
# so the fetch aborts at 22s and reports a silent skip.
#
# Wakes the agent only when:
#   - a new purchase appears (dedup by activity id in the state file)
#   - auth breaks (once, on the transition — not every tick)
#   - 8 consecutive failed checks (once, on the transition)
# A payment equal in value to a notified purchase marks it paid, silently.
set -euo pipefail

exec node --input-type=module - <<'EOF'
import fs from "node:fs";

const URL_BASE = process.env.HTTP_CLIENTS_URL;
const STATE = process.env.CARD_MONITOR_STATE || "/workspace/agent/card_monitor_state.json";
const CARD = "ca-credit-card-cxPxfAh-WA";
const PROFILE = "eudes";
const WINDOW_DAYS = 14;   // feed window per check; pagination is bounded by start-date
const PRUNE_DAYS = 45;    // drop state entries older than this
const FAIL_ALERT_STREAK = 8; // ~2h at every-15-min before alerting a persistent failure

const out = (wakeAgent, data) => {
  console.log(JSON.stringify({ wakeAgent, data }));
  process.exit(0);
};

if (!URL_BASE) out(false, { skipped: "HTTP_CLIENTS_URL not set" });

const firstRun = !fs.existsSync(STATE);
const state = firstRun
  ? { seen: {}, consumedPayments: [], authAlerted: false, failStreak: 0, failAlerted: false }
  : JSON.parse(fs.readFileSync(STATE, "utf8"));

const save = () => {
  fs.writeFileSync(STATE + ".tmp", JSON.stringify(state, null, 1));
  fs.renameSync(STATE + ".tmp", STATE);
};

const fail = (code, message) => {
  if (code === "auth_required") {
    if (!state.authAlerted) {
      state.authAlerted = true;
      save();
      out(true, { alert: "auth_required", message });
    }
    save();
    out(false, { skipped: "auth_required (already alerted)" });
  }
  state.failStreak = (state.failStreak || 0) + 1;
  if (state.failStreak >= FAIL_ALERT_STREAK && !state.failAlerted) {
    state.failAlerted = true;
    save();
    out(true, { alert: "check_failing", consecutiveFailures: state.failStreak, message });
  }
  save();
  out(false, { skipped: code, message });
};

const startDate = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().replace(/\.\d{3}Z$/, "Z");

let res;
try {
  const r = await fetch(`${URL_BASE}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      service: "wealthsimple",
      command: "fetch-credit-card-activities",
      args: { "credit-account-id": CARD, profile: PROFILE, "start-date": startDate },
      raw: true,
    }),
    signal: AbortSignal.timeout(22_000),
  });
  res = await r.json();
} catch (e) {
  res = { status: "error", code: "transient", message: String(e) };
}

if (res.status !== "ok") fail(res.code || "error", res.message || "");

// Unwrap: data is keyed by profile ({eudes: [...]}); tolerate the partial
// shape ({results, errors}) and a bare array.
let rows = res.data;
if (rows && !Array.isArray(rows) && rows.results) {
  const perr = rows.errors && rows.errors[PROFILE];
  if (perr) fail(perr.code || "error", `profile error: ${JSON.stringify(perr).slice(0, 200)}`);
  rows = rows.results;
}
if (rows && !Array.isArray(rows)) rows = rows[PROFILE] ?? Object.values(rows).find(Array.isArray);
if (!Array.isArray(rows)) fail("bad_shape", JSON.stringify(res).slice(0, 300));

state.authAlerted = false;
state.failAlerted = false;
state.failStreak = 0;

const cents = (a) => Math.round(Math.abs(parseFloat(a)) * 100);
const ts = (s) => new Date(s).getTime() || 0;
const dollars = (c) => (c / 100).toFixed(2);

const newPurchases = [];
for (const a of rows) {
  if (a.type !== "purchase" || a.status === "reversed") continue;
  const prev = state.seen[a.id];
  if (prev) {
    prev.amount = cents(a.amount); // authorized→settled can adjust the amount
    continue;
  }
  state.seen[a.id] = {
    st: firstRun ? "seeded" : "notified",
    amount: cents(a.amount),
    merchant: a.merchant_name,
    at: a.occurred_at,
  };
  if (!firstRun) {
    newPurchases.push({
      id: a.id,
      merchant: a.merchant_name,
      amount: dollars(cents(a.amount)),
      currency: a.currency,
      occurred_at: a.occurred_at,
      status: a.status,
    });
  }
}

// A payment of the exact value of one notified purchase marks it paid.
// Each payment id is consumed once so it cannot pay two equal purchases.
const consumed = new Set(state.consumedPayments || []);
const paidMarked = [];
const payments = rows
  .filter((a) => a.type === "payment" && !consumed.has(a.id))
  .sort((x, y) => ts(x.occurred_at) - ts(y.occurred_at));
for (const p of payments) {
  const match = Object.values(state.seen).find(
    (s) => s.st === "notified" && s.amount === cents(p.amount) && ts(s.at) <= ts(p.occurred_at),
  );
  if (match) {
    match.st = "paid";
    consumed.add(p.id);
    paidMarked.push({ merchant: match.merchant, amount: dollars(match.amount) });
  }
}
state.consumedPayments = [...consumed].slice(-200);

const cutoff = Date.now() - PRUNE_DAYS * 864e5;
for (const [id, s] of Object.entries(state.seen)) {
  if (ts(s.at) && ts(s.at) < cutoff) delete state.seen[id];
}

save();
if (newPurchases.length) out(true, { newPurchases, paidMarked });
out(false, { checked: rows.length, firstRun, paidMarked });
EOF
