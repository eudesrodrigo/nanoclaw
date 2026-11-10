import { describe, it, expect } from 'vitest';
import { rootId, cents, dollars, processActivities, type Activity } from './domain.js';
import type { CardPayState } from './state.js';

function freshState(): CardPayState {
  return {
    config: { enabled: true, chatPlatformId: 'telegram:-100', approverIds: [], cardId: 'card-1', profile: 'eudes' },
    seen: {},
    consumedPayments: [],
    offers: [],
    attempts: [],
    authAlerted: false,
    failStreak: 0,
    failAlerted: false,
    seeded: true,
  };
}

const purchase = (id: string, amount: string, merchant = 'Loja', status = 'settled', occurred = '2026-11-09T12:00:00Z'): Activity => ({
  id,
  type: 'purchase',
  status,
  amount,
  merchant_name: merchant,
  currency: 'CAD',
  occurred_at: occurred,
});

describe('rootId', () => {
  it('strips the lowercase settlement suffix', () => {
    expect(rootId('abc-7UZVA8-0tly05u6n94k')).toBe('abc-7UZVA8');
  });
  it('keeps ids without a settlement suffix untouched', () => {
    expect(rootId('abc-7UZVA8')).toBe('abc-7UZVA8');
    expect(rootId('plain')).toBe('plain');
  });
});

describe('cents/dollars', () => {
  it('converts decimal strings to integer cents', () => {
    expect(cents('19.99')).toBe(1999);
    expect(cents('-4.5')).toBe(450);
  });
  it('formats cents as dollars', () => {
    expect(dollars(1999)).toBe('19.99');
    expect(dollars(5)).toBe('0.05');
  });
});

describe('processActivities', () => {
  it('seeds silently on first run', () => {
    const s = freshState();
    const out = processActivities(s, [purchase('p1', '10.00')], true);
    expect(out.newPurchases).toEqual([]);
    expect(s.seen.p1.st).toBe('seeded');
  });

  it('reports new purchases after seeding', () => {
    const s = freshState();
    s.seen.p1 = { st: 'seeded', amount: 1000, merchant: 'Loja', at: '2026-11-01T00:00:00Z' };
    const out = processActivities(s, [purchase('p1', '10.00'), purchase('p2', '20.00', 'Outra')], false);
    expect(out.newPurchases).toHaveLength(1);
    expect(out.newPurchases[0].merchant).toBe('Outra');
    expect(s.seen.p2.st).toBe('notified');
  });

  it('dedups a settling purchase by root id and updates the amount', () => {
    const s = freshState();
    s.seen['p1-ROOT'] = { st: 'notified', amount: 1000, merchant: 'Loja', at: '2026-11-09T12:00:00Z' };
    const out = processActivities(s, [purchase('p1-ROOT-0tly05u6n94k', '9.50')], false);
    expect(out.newPurchases).toEqual([]);
    expect(s.seen['p1-ROOT'].amount).toBe(950);
  });

  it('skips reversed purchases', () => {
    const s = freshState();
    const out = processActivities(s, [purchase('p1', '10.00', 'Loja', 'reversed')], false);
    expect(out.newPurchases).toEqual([]);
    expect(s.seen.p1).toBeUndefined();
  });

  it('marks a notified purchase paid when a matching payment appears', () => {
    const s = freshState();
    s.seen.p1 = { st: 'notified', amount: 1000, merchant: 'Loja', at: '2026-11-09T12:00:00Z' };
    const out = processActivities(
      s,
      [
        purchase('p1', '10.00'),
        { id: 'pay1', type: 'payment', status: 'posted', amount: '-10.00', merchant_name: 'Pagamento', currency: 'CAD', occurred_at: '2026-11-09T13:00:00Z' },
      ],
      false,
    );
    expect(s.seen.p1.st).toBe('paid');
    expect(out.paidMarked).toEqual([{ merchant: 'Loja', amount: '10.00' }]);
    expect(s.consumedPayments).toContain('pay1');
  });

  it('consumes each payment id once', () => {
    const s = freshState();
    s.seen.p1 = { st: 'notified', amount: 1000, merchant: 'A', at: '2026-11-09T12:00:00Z' };
    s.seen.p2 = { st: 'notified', amount: 1000, merchant: 'B', at: '2026-11-09T12:05:00Z' };
    const pay = { id: 'pay1', type: 'payment', status: 'posted', amount: '-10.00', merchant_name: 'Pagamento', currency: 'CAD', occurred_at: '2026-11-09T13:00:00Z' };
    processActivities(s, [purchase('p1', '10.00', 'A'), purchase('p2', '10.00', 'B'), pay], false);
    processActivities(s, [purchase('p1', '10.00', 'A'), purchase('p2', '10.00', 'B'), pay], false);
    const paidCount = Object.values(s.seen).filter((e) => e.st === 'paid').length;
    expect(paidCount).toBe(1);
  });

  it('prunes entries older than 45 days', () => {
    const s = freshState();
    const old = new Date(Date.now() - 46 * 864e5).toISOString();
    s.seen.old1 = { st: 'seeded', amount: 100, merchant: 'X', at: old };
    processActivities(s, [], false);
    expect(s.seen.old1).toBeUndefined();
  });
});
