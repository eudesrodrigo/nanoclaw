import { describe, it, expect, vi } from 'vitest';
import { createWsClient, type PayOutcome } from './wealthsimple.js';

const ok = (data: unknown) => ({ status: 'ok', data });
const err = (code: string, message = '') => ({ status: 'error', code, message });

function makeClient(impl: (call: { command?: string }) => Promise<object>) {
  const call = vi.fn((c: { command?: string }) => impl(c));
  return { client: createWsClient(call as never), call };
}

describe('fetchActivities', () => {
  it('unwraps the profile key and passes card, profile and start-date', async () => {
    const rows = [{ id: 'a1', type: 'purchase' }];
    const { client, call } = makeClient(async () => ok({ eudes: rows }));
    const out = await client.fetchActivities('card-1', 'eudes', '2026-10-27T00:00:00Z');
    expect(out).toEqual(rows);
    expect(call).toHaveBeenCalledWith({
      service: 'wealthsimple',
      command: 'fetch-credit-card-activities',
      args: { 'credit-account-id': 'card-1', profile: 'eudes', 'start-date': '2026-10-27T00:00:00Z' },
      raw: true,
    });
  });

  it('tolerates the results envelope and bare arrays', async () => {
    const { client } = makeClient(async () => ok({ results: [1], errors: {} }));
    expect(await client.fetchActivities('c', 'eudes', 'd')).toEqual([1]);
  });

  it('throws on error envelopes', async () => {
    const { client } = makeClient(async () => err('transient', 'network'));
    await expect(client.fetchActivities('c', 'eudes', 'd')).rejects.toMatchObject({ code: 'transient' });
  });
});

describe('fetchCashAccounts', () => {
  it('keeps open CAD CASH accounts with stable ordering fields', async () => {
    const { client } = makeClient(async () =>
      ok({
        eudes: [
          { id: 'ca-1', name: '🛒 Mercado e Gas', type: 'CASH', currency: 'CAD', status: 'open' },
          { id: 'inv-1', name: 'TFSA', type: 'INVESTMENT', currency: 'CAD', status: 'open' },
          { id: 'usd-1', name: 'USD Cash', type: 'CASH', currency: 'USD', status: 'open' },
          { id: 'closed-1', name: 'Velha', type: 'CASH', currency: 'CAD', status: 'closed' },
        ],
      }),
    );
    expect(await client.fetchCashAccounts('eudes')).toEqual([{ id: 'ca-1', name: '🛒 Mercado e Gas' }]);
  });

  it('falls back to nickname/account_id field names', async () => {
    const { client } = makeClient(async () => ok([{ account_id: 'ca-9', nickname: 'Geral', account_type: 'CASH', currency: 'CAD', status: 'active' }]));
    expect(await client.fetchCashAccounts('eudes')).toEqual([{ id: 'ca-9', name: 'Geral' }]);
  });
});

describe('fetchWithdrawableCents', () => {
  it('maps account ids to cent balances', async () => {
    const { client, call } = makeClient(async () =>
      ok([
        { account_id: 'ca-1', money_out_amount_cents: 123456 },
        { account_id: 'ca-2', amount_cents: 500 },
      ]),
    );
    const out = await client.fetchWithdrawableCents(['ca-1', 'ca-2'], 'card-1', 'eudes');
    expect(out).toEqual([
      { accountId: 'ca-1', cents: 123456 },
      { accountId: 'ca-2', cents: 500 },
    ]);
    expect(call).toHaveBeenCalledWith({
      service: 'wealthsimple',
      command: 'fetch-accounts-withdrawable-balances',
      args: { 'account-ids': ['ca-1', 'ca-2'], 'destination-id': 'card-1', 'destination-type': 'Account', profile: 'eudes' },
      raw: true,
    });
  });

  it('reports unknown balances as null instead of zero', async () => {
    const { client } = makeClient(async () => ok([{ account_id: 'ca-1' }]));
    expect(await client.fetchWithdrawableCents(['ca-1'], 'card-1', 'eudes')).toEqual([{ accountId: 'ca-1', cents: null }]);
  });
});

describe('payCard', () => {
  it('sends the mutation with amount cents and idempotency key', async () => {
    const { client, call } = makeClient(async () => ok({ success: true, errors: [] }));
    const outcome = await client.payCard({ amountCents: 1999, cashAccountId: 'ca-1', creditAccountId: 'card-1', idempotencyKey: 'k-1', profile: 'eudes' });
    expect(outcome.outcome).toBe('accepted');
    expect(call).toHaveBeenCalledWith({
      service: 'wealthsimple',
      command: 'credit-card-payment',
      args: { 'amount-cents': 1999, 'cash-account-id': 'ca-1', 'credit-account-id': 'card-1', 'idempotency-key': 'k-1', profile: 'eudes' },
      raw: true,
    });
  });

  it.each<[object, PayOutcome['outcome']]>([
    [err('auth_required'), 'auth'],
    [{ status: 'error', code: 'cli_error', message: 'CreditCardPayment refused: insufficient funds' }, 'rejected'],
    [err('transient', 'timeout'), 'unknown'],
  ])('classifies %o as %s', async (envelope, expected) => {
    const { client } = makeClient(async () => envelope);
    const outcome = await client.payCard({ amountCents: 1, cashAccountId: 'ca', creditAccountId: 'card', idempotencyKey: 'k', profile: 'eudes' });
    expect(outcome.outcome).toBe(expected);
  });

  it('transport failures are unknown', async () => {
    const { client } = makeClient(async () => {
      throw new Error('spawn ENOENT');
    });
    expect((await client.payCard({ amountCents: 1, cashAccountId: 'ca', creditAccountId: 'card', idempotencyKey: 'k', profile: 'eudes' })).outcome).toBe('unknown');
  });
});
