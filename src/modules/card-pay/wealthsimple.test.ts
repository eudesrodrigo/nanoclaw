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
  it('unwraps node envelopes and keeps open CAD CASH accounts', async () => {
    const { client } = makeClient(async () =>
      ok({
        eudes: [
          { node: { id: 'ca-1', nickname: '🛒 Mercado e Gas', unified_account_type: 'CASH', currency: 'CAD', status: 'open' } },
          { node: { id: 'tfsa-1', nickname: 'Stocks', unified_account_type: 'SELF_DIRECTED_TFSA', currency: 'CAD', status: 'open' } },
          { node: { id: 'usd-1', nickname: 'USD', unified_account_type: 'CASH', currency: 'USD', status: 'open' } },
          { node: { id: 'closed-1', nickname: 'Velha', unified_account_type: 'CASH', currency: 'CAD', status: 'closed' } },
          { node: { id: 'open-flag-1', nickname: 'Só is_open', unified_account_type: 'CASH', currency: 'CAD', is_open: true } },
        ],
      }),
    );
    const accounts = await client.fetchCashAccounts('eudes');
    expect(accounts).toContainEqual({ id: 'ca-1', name: '🛒 Mercado e Gas' });
    expect(accounts).toContainEqual({ id: 'open-flag-1', name: 'Só is_open' });
    expect(accounts).toHaveLength(2);
  });

  it('still tolerates flat rows with legacy field names', async () => {
    const { client } = makeClient(async () =>
      ok([{ account_id: 'ca-9', nickname: 'Geral', account_type: 'CASH', currency: 'CAD', status: 'active' }]),
    );
    expect(await client.fetchCashAccounts('eudes')).toEqual([{ id: 'ca-9', name: 'Geral' }]);
  });
});

describe('fetchWithdrawableCents', () => {
  it('parses decimal CAD money_out_balances into cents', async () => {
    const { client, call } = makeClient(async () =>
      ok({
        eudes: [
          {
            id: 'ca-1',
            funding_flow_policy: {
              withdrawal_enabled: true,
              money_out_balances: [{ amount: '758.67', currency: 'CAD' }],
            },
          },
          {
            id: 'ca-2',
            funding_flow_policy: {
              withdrawal_enabled: true,
              money_out_balances: [{ amount: '0.01', currency: 'USD' }],
            },
          },
        ],
      }),
    );
    const out = await client.fetchWithdrawableCents(['ca-1', 'ca-2'], 'card-1', 'eudes');
    expect(out).toEqual([
      { accountId: 'ca-1', cents: 75867 },
      { accountId: 'ca-2', cents: null },
    ]);
    expect(call).toHaveBeenCalledWith({
      service: 'wealthsimple',
      command: 'fetch-accounts-withdrawable-balances',
      args: {
        'account-ids': ['ca-1', 'ca-2'],
        'destination-id': 'card-1',
        'destination-type': 'Account',
        profile: 'eudes',
      },
      raw: true,
    });
  });

  it('reports withdrawal-disabled and shape-unknown accounts as null, never zero', async () => {
    const { client } = makeClient(async () =>
      ok({
        eudes: [
          { id: 'ca-1', funding_flow_policy: { withdrawal_enabled: false } },
          { id: 'ca-2' },
        ],
      }),
    );
    expect(await client.fetchWithdrawableCents(['ca-1', 'ca-2'], 'card-1', 'eudes')).toEqual([
      { accountId: 'ca-1', cents: null },
      { accountId: 'ca-2', cents: null },
    ]);
  });
});

describe('payCard', () => {
  it('sends the mutation with amount cents and idempotency key', async () => {
    const { client, call } = makeClient(async () => ok({ success: true, errors: [] }));
    const outcome = await client.payCard({
      amountCents: 1999,
      cashAccountId: 'ca-1',
      creditAccountId: 'card-1',
      idempotencyKey: 'k-1',
      profile: 'eudes',
    });
    expect(outcome.outcome).toBe('accepted');
    expect(call).toHaveBeenCalledWith({
      service: 'wealthsimple',
      command: 'credit-card-payment',
      args: {
        'amount-cents': 1999,
        'cash-account-id': 'ca-1',
        'credit-account-id': 'card-1',
        'idempotency-key': 'k-1',
        profile: 'eudes',
      },
      raw: true,
    });
  });

  it.each<[object, PayOutcome['outcome']]>([
    [err('auth_required'), 'auth'],
    [{ status: 'error', code: 'cli_error', message: 'CreditCardPayment refused: insufficient funds' }, 'rejected'],
    [err('transient', 'timeout'), 'unknown'],
  ])('classifies %o as %s', async (envelope, expected) => {
    const { client } = makeClient(async () => envelope);
    const outcome = await client.payCard({
      amountCents: 1,
      cashAccountId: 'ca',
      creditAccountId: 'card',
      idempotencyKey: 'k',
      profile: 'eudes',
    });
    expect(outcome.outcome).toBe(expected);
  });

  it('transport failures are unknown', async () => {
    const { client } = makeClient(async () => {
      throw new Error('spawn ENOENT');
    });
    expect(
      (
        await client.payCard({
          amountCents: 1,
          cashAccountId: 'ca',
          creditAccountId: 'card',
          idempotencyKey: 'k',
          profile: 'eudes',
        })
      ).outcome,
    ).toBe('unknown');
  });
});
