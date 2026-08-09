import { describe, it, expect, vi } from 'vitest';

import { applyProjection, resolvePath, PROJECTIONS } from './http-clients-projections.js';
import { log } from './log.js';

const POSITION = {
  node: {
    id: 'abc',
    quantity: '6.0801',
    accounts: [{ id: 'tfsa-wwsko4ic' }],
    percentage_of_account: '19.56',
    security: { currency: 'USD', stock: { symbol: 'AAPL' }, logo_url: 'https://x/y.png' },
    total_value: { amount: '2657.0953575075', currency: 'CAD' },
    book_value: { amount: '7178.640181775510391386379161', currency: 'CAD' },
    unrealized_returns: { amount: '457.4353575075', currency: 'CAD' },
  },
};

const KEY = 'wealthsimple/fetch-identity-positions';

// Trimmed from a real element of `http-clients wealthsimple fetch-all-accounts
// --profile eudes` on 2026-08-08 (node id ca-cash-msb-dUD0sYfiog). Nested
// lists are shortened to one entry each; every field the rule reads, plus a
// few it must drop, are copied byte for byte.
const ACCOUNT = {
  cursor: 'MQ',
  node: {
    id: 'ca-cash-msb-dUD0sYfiog',
    archived_at: null,
    branch: 'WS',
    closed_at: null,
    currency: 'CAD',
    unified_account_type: 'CASH',
    type: 'ca_cash_msb',
    is_open: true,
    nickname: '🚙 Carro - Seg e Men: 895',
    status: 'open',
    account_features: [
      { name: 'WALLET', enabled: true, functional: true, first_enabled_on: '2023-04-14T15:56:46.421121Z' },
    ],
    account_owners: [{ account_id: 'ca-cash-msb-dUD0sYfiog', name: 'Eudes Nunes de Oliveira' }],
    custodian_accounts: [{ id: 'WK185RQ35CAD', branch: 'WS', custodian: 'so', status: 'open' }],
    linked_account: null,
  },
};

// Real element (id ca-cash-msb-dUD0sYfiog) from
// `http-clients wealthsimple fetch-account-combined-financials --profile
// eudes --ids ca-cash-msb-dUD0sYfiog --ids tfsa-wwsko4ic --ids
// rrsp-QW7Yf-vAMg` on 2026-08-08. This command returns a bare array — no
// node/cursor wrapper.
const FINANCIALS = {
  id: 'ca-cash-msb-dUD0sYfiog',
  financials: {
    current_combined: {
      id: 'ca-cash-msb-dUD0sYfiog-CAD',
      net_deposits_v2: { amount: '395.27', cents: 39527, currency: 'CAD' },
      net_liquidation_value_v2: { amount: '582.12', cents: 58212, currency: 'CAD' },
      simple_returns: {
        amount: { amount: '186.85', cents: 18685, currency: 'CAD' },
        as_of: null,
        rate: '0.472715',
        reference_date: '1970-01-01',
      },
    },
  },
};

// Real payload from `http-clients wealthsimple fetch-credit-card-latest-statement
// --profile eudes --id ca-credit-card-cxPxfAh-WA` on 2026-08-08. This command
// returns a single object (no array, no `each`).
const STATEMENT = {
  id: 'ca-credit-card-cxPxfAh-WA',
  latest_statement: {
    id: 'credit-statement-ca-credit-card-cxPxfAh-WA-20260725',
    minimum_payment_outstanding: '0.0',
    statement_balance_outstanding: '0.0',
    minimum_payment_due: '47.9',
    payment_due_date: '2026-08-18',
    statement_balance: '958.06',
    statement_open_date: '2026-07-01',
    statement_close_date: '2026-07-24',
    payment_status: 'paid_full',
    credit_line: '10000.0',
    is_paid_fully: true,
    is_after_due_date: false,
  },
};

// Real payload from `http-clients wealthsimple fetch-credit-card-account
// --profile eudes --id ca-credit-card-cxPxfAh-WA` on 2026-08-08. current_cards
// carries a masked card number ("************0491") — still dropped by the
// rule, since the field itself should never round-trip through the projector.
const CC_ACCOUNT = {
  id: 'ca-credit-card-cxPxfAh-WA',
  created_at: '2026-07-01T14:30:51.520768Z',
  status: 'open',
  credit_limit: 10000,
  balance: {
    current: '187.20',
    outstanding: '289.93',
    available_credit_limit: '9710.07',
    pending: '102.73',
  },
  card_product_id: 'ws_visa_infinite_privilege',
  statement_day_of_month: 25,
  current_cards: [{ id: 'credit-card-527024131287', card_number: '************0491', card_variant: 'primary' }],
  preferences: { card_reward_redemption_type: 'manual' },
};

function ok(data: unknown) {
  return { status: 'ok', data };
}

describe('resolvePath', () => {
  it('walks dotted paths', () => {
    expect(resolvePath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
  });

  it('walks array indexes', () => {
    expect(resolvePath({ a: [{ id: 'x' }] }, 'a[0].id')).toBe('x');
  });

  it('returns undefined for a path that does not resolve', () => {
    expect(resolvePath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined instead of throwing on a null mid-path', () => {
    expect(resolvePath({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('applyProjection', () => {
  it('trims each element of a profile array to the rule fields', () => {
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [POSITION] })) as Record<
      string,
      unknown
    >;
    const data = out.data as Record<string, unknown[]>;
    expect(data.eudes[0]).toEqual({
      sym: 'AAPL',
      accounts: [{ id: 'tfsa-wwsko4ic' }],
      qty: '6.0801',
      value: '2657.0953575075',
      book: '7178.640181775510391386379161',
      ret: '457.4353575075',
      currency: 'CAD',
    });
  });

  it('keeps the valuation currency, not the security trading currency', () => {
    // Regression for the CAD-valued/USD-traded trap: AAPL trades in USD
    // (security.currency) but this identity's holding is valued in CAD
    // (total_value.currency). The projected `currency` must be the latter.
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [POSITION] })) as Record<
      string,
      unknown
    >;
    const first = (out.data as Record<string, Record<string, unknown>[]>).eudes[0];
    expect(first.currency).toBe('CAD');
    expect(POSITION.node.security.currency).toBe('USD');
  });

  it('marks the response with the rule key', () => {
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [POSITION] })) as Record<
      string,
      unknown
    >;
    expect(out.projected).toBe(KEY);
  });

  it('sets no projected key when no rule matches', () => {
    const out = applyProjection('wealthsimple', 'no-such-command', ok({ eudes: [{ a: 1 }] })) as Record<
      string,
      unknown
    >;
    expect(out.projected).toBeUndefined();
    expect(out.data).toEqual({ eudes: [{ a: 1 }] });
  });

  it('projects inside results and leaves errors untouched on a partial result', () => {
    const partial = ok({
      results: { eudes: [POSITION] },
      errors: { magda: { code: 'auth_required', flow: 'otp', profile: 'magda' } },
    });
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', partial) as Record<string, unknown>;
    const data = out.data as Record<string, Record<string, unknown>>;
    expect((data.results.eudes as unknown[])[0]).toHaveProperty('sym', 'AAPL');
    expect(data.errors).toEqual({ magda: { code: 'auth_required', flow: 'otp', profile: 'magda' } });
  });

  it('keeps a string amount byte for byte', () => {
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [POSITION] })) as Record<
      string,
      unknown
    >;
    const first = (out.data as Record<string, Record<string, unknown>[]>).eudes[0];
    expect(first.book).toBe('7178.640181775510391386379161');
    expect(typeof first.book).toBe('string');
  });

  it('keeps every entry of a multi-account position', () => {
    const twoAccounts = {
      node: { ...POSITION.node, accounts: [{ id: 'tfsa-a' }, { id: 'rrsp-b' }] },
    };
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [twoAccounts] })) as Record<
      string,
      unknown
    >;
    const first = (out.data as Record<string, Record<string, unknown>[]>).eudes[0];
    expect(first.accounts).toEqual([{ id: 'tfsa-a' }, { id: 'rrsp-b' }]);
  });

  it('omits a key whose path does not resolve', () => {
    const noSymbol = { node: { ...POSITION.node, security: { currency: 'CAD' } } };
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok({ eudes: [noSymbol] })) as Record<
      string,
      unknown
    >;
    const first = (out.data as Record<string, Record<string, unknown>[]>).eudes[0];
    expect(first).not.toHaveProperty('sym');
    expect(first).toHaveProperty('qty', '6.0801');
  });

  it('leaves an error envelope alone', () => {
    const errorResult = { status: 'error', code: 'auth_required', flow: 'otp' };
    expect(applyProjection('wealthsimple', 'fetch-identity-positions', errorResult)).toEqual(errorResult);
  });

  it('leaves a plain-text listing alone', () => {
    const listing = ok('Commands:\n  fetch-identity-positions');
    expect(applyProjection('wealthsimple', 'fetch-identity-positions', listing)).toEqual(listing);
  });

  it('returns the raw payload instead of throwing when projection fails', () => {
    const spy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const hostile = ok({
      get eudes() {
        throw new Error('boom');
      },
    });
    expect(() => applyProjection('wealthsimple', 'fetch-identity-positions', hostile)).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ships a rule for the verified positions command', () => {
    expect(PROJECTIONS[KEY]).toBeDefined();
  });

  it('handles __proto__ profile key without silent data loss', () => {
    // Regression test: ensure __proto__ keys are stored as ordinary data properties,
    // not triggered as the Object.prototype.__proto__ setter.
    const payload = JSON.parse(`{
      "__proto__": [${JSON.stringify(POSITION)}],
      "eudes": [${JSON.stringify(POSITION)}]
    }`);
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', ok(payload)) as Record<string, unknown>;
    const data = out.data as Record<string, unknown[]>;

    // The __proto__ profile must be present with projected data.
    expect(data).toHaveProperty('__proto__');
    expect(Array.isArray(data.__proto__)).toBe(true);
    expect((data.__proto__ as unknown[])[0]).toHaveProperty('sym', 'AAPL');

    // Verify JSON round-trip preserves the __proto__ key.
    const serialized = JSON.stringify(out);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.data).toHaveProperty('__proto__');
    expect(Array.isArray((deserialized.data as Record<string, unknown>).__proto__)).toBe(true);
  });

  it('trims an account to the rule fields', () => {
    const out = applyProjection('wealthsimple', 'fetch-all-accounts', {
      status: 'ok',
      data: { eudes: [ACCOUNT] },
    }) as Record<string, unknown>;
    expect(out.projected).toBe('wealthsimple/fetch-all-accounts');
    expect((out.data as Record<string, unknown[]>).eudes[0]).toEqual({
      id: 'ca-cash-msb-dUD0sYfiog',
      nickname: '🚙 Carro - Seg e Men: 895',
      type: 'CASH',
      currency: 'CAD',
      status: 'open',
    });
  });

  it('trims a combined-financials entry to the rule fields', () => {
    const out = applyProjection('wealthsimple', 'fetch-account-combined-financials', {
      status: 'ok',
      data: { eudes: [FINANCIALS] },
    }) as Record<string, unknown>;
    expect(out.projected).toBe('wealthsimple/fetch-account-combined-financials');
    expect((out.data as Record<string, unknown[]>).eudes[0]).toEqual({
      id: 'ca-cash-msb-dUD0sYfiog',
      deposits: '395.27',
      value: '582.12',
      ret: '186.85',
      rate: '0.472715',
      currency: 'CAD',
    });
  });

  it('trims a credit-card latest statement to the rule fields', () => {
    const out = applyProjection('wealthsimple', 'fetch-credit-card-latest-statement', {
      status: 'ok',
      data: { eudes: STATEMENT },
    }) as Record<string, unknown>;
    expect(out.projected).toBe('wealthsimple/fetch-credit-card-latest-statement');
    expect(out.data).toEqual({
      eudes: {
        id: 'ca-credit-card-cxPxfAh-WA',
        balance: '958.06',
        outstanding: '0.0',
        min: '47.9',
        due: '2026-08-18',
        status: 'paid_full',
      },
    });
    // No `currency` key: the real payload has no sibling currency anywhere.
    expect((out.data as Record<string, unknown>).eudes).not.toHaveProperty('currency');
  });

  it('trims a credit-card account to the rule fields, dropping card numbers', () => {
    const out = applyProjection('wealthsimple', 'fetch-credit-card-account', {
      status: 'ok',
      data: { eudes: CC_ACCOUNT },
    }) as Record<string, unknown>;
    expect(out.projected).toBe('wealthsimple/fetch-credit-card-account');
    expect(out.data).toEqual({
      eudes: {
        id: 'ca-credit-card-cxPxfAh-WA',
        status: 'open',
        limit: 10000,
        current: '187.20',
        outstanding: '289.93',
        available: '9710.07',
        pending: '102.73',
        statement_day: 25,
      },
    });
    const projectedAccount = (out.data as Record<string, unknown>).eudes as Record<string, unknown>;
    expect(projectedAccount).not.toHaveProperty('current_cards');
    expect(projectedAccount).not.toHaveProperty('preferences');
    // No `currency` key: the real payload has no sibling currency anywhere.
    expect(projectedAccount).not.toHaveProperty('currency');
  });

  it('warns when a rule keeps no fields from a non-empty payload', () => {
    // How an upstream schema change presents: the call succeeds, the rule
    // matches nothing, and `{}` reads as "this profile holds nothing".
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const out = applyProjection('wealthsimple', 'fetch-identity-positions', {
      status: 'ok',
      data: { eudes: [{ renamed_node: { total_value: { amount: '1.00' } } }] },
    }) as Record<string, unknown>;

    expect(out.data).toEqual({ eudes: [{}] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept no fields'), {
      key: 'wealthsimple/fetch-identity-positions',
      profile: 'eudes',
    });
    warn.mockRestore();
  });

  it('does not warn when the payload is genuinely empty', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    applyProjection('wealthsimple', 'fetch-identity-positions', { status: 'ok', data: { eudes: [] } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves no rule for costco, since the refresh token is expired and no live payload exists', () => {
    expect(PROJECTIONS['costco/receipts']).toBeUndefined();
    expect(PROJECTIONS['costco/receipt-detail']).toBeUndefined();
  });
});
