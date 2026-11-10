import type { CardPayState } from './state.js';

export interface Activity {
  id: string;
  type: string;
  status: string;
  amount: string;
  merchant_name: string;
  currency: string;
  occurred_at: string;
}

export interface NewPurchase {
  key: string;
  merchant: string;
  amount: string;
  amountCents: number;
  currency: string;
  occurredAt: string;
  status: string;
}

export interface ProcessResult {
  newPurchases: NewPurchase[];
  paidMarked: Array<{ merchant: string; amount: string }>;
}

const PRUNE_DAYS = 45;

export function rootId(id: string): string {
  return String(id).replace(/-(?=[^-]*[a-z])[0-9a-z]{8,}$/, '');
}

export function cents(amount: string): number {
  return Math.round(Math.abs(parseFloat(amount)) * 100);
}

export function dollars(c: number): string {
  return (c / 100).toFixed(2);
}

const ts = (s: string): number => new Date(s).getTime() || 0;

export function processActivities(state: CardPayState, rows: Activity[], firstRun: boolean): ProcessResult {
  const newPurchases: NewPurchase[] = [];
  for (const a of rows) {
    if (a.type !== 'purchase' || a.status === 'reversed') continue;
    const key = rootId(a.id);
    const prev = state.seen[key];
    if (prev) {
      prev.amount = cents(a.amount);
      continue;
    }
    state.seen[key] = {
      st: firstRun ? 'seeded' : 'notified',
      amount: cents(a.amount),
      merchant: a.merchant_name,
      at: a.occurred_at,
    };
    if (!firstRun) {
      newPurchases.push({
        key,
        merchant: a.merchant_name,
        amount: dollars(cents(a.amount)),
        amountCents: cents(a.amount),
        currency: a.currency,
        occurredAt: a.occurred_at,
        status: a.status,
      });
    }
  }

  const consumed = new Set(state.consumedPayments);
  const paidMarked: Array<{ merchant: string; amount: string }> = [];
  const payments = rows
    .filter((a) => a.type === 'payment' && !consumed.has(rootId(a.id)))
    .sort((x, y) => ts(x.occurred_at) - ts(y.occurred_at));
  for (const p of payments) {
    const match = Object.values(state.seen).find(
      (s) => s.st === 'notified' && s.amount === cents(p.amount) && ts(s.at) <= ts(p.occurred_at),
    );
    if (match) {
      match.st = 'paid';
      consumed.add(rootId(p.id));
      paidMarked.push({ merchant: match.merchant, amount: dollars(match.amount) });
    }
  }
  state.consumedPayments = [...consumed].slice(-200);

  const cutoff = Date.now() - PRUNE_DAYS * 864e5;
  for (const [id, s] of Object.entries(state.seen)) {
    if (ts(s.at) && ts(s.at) < cutoff) delete state.seen[id];
  }

  return { newPurchases, paidMarked };
}
