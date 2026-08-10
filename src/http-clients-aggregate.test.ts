import { describe, it, expect } from 'vitest';

import { addDecimal, applyAggregate, divideToPercent } from './http-clients-aggregate.js';

// Values in this file are invented. Every real amount stays out of the repo.
// The 28-decimal-place shape is copied from the live payload, not the values.
const D28 = (amount: string) => {
  const [whole, fraction = ''] = amount.split('.');
  return `${whole}.${fraction.padEnd(25, '0')}`;
};

function positions() {
  const p = (sym: string, acc: string, value: string, book: string) => ({
    sym,
    accounts: [acc],
    qty: '1.0',
    value,
    book,
    ret: '0.0',
    currency: 'CAD',
  });
  return {
    eudes: [
      p('VFV', 'acc-1', D28('19889.51'), D28('15200.12')),
      p('XEQT', 'acc-1', D28('3963.14'), D28('3610.00')),
      p('VFV', 'acc-2', D28('9909.52'), D28('8100.44')),
      p('VFV', 'acc-9', D28('49000.00'), D28('40000.00')),
    ],
    magda: [p('VFV', 'acc-3', D28('6572.19'), D28('5400.00'))],
  };
}

describe('addDecimal', () => {
  it('sums decimal strings exactly, with no float error', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754. Money cannot do that.
    expect(addDecimal('0.1', '0.2')).toBe('0.3');
  });

  it('keeps every place of a 28-decimal value', () => {
    expect(addDecimal('0.0000000000000000000000001', '0.0000000000000000000000002')).toBe(
      '0.0000000000000000000000003',
    );
  });

  it('handles differing scales and negatives', () => {
    expect(addDecimal('10', '-0.25')).toBe('9.75');
    expect(addDecimal('-1.5', '1.5')).toBe('0');
  });
});

describe('divideToPercent', () => {
  it('returns two decimal places, half-up', () => {
    expect(divideToPercent('1', '3')).toBe('33.33');
    expect(divideToPercent('2', '3')).toBe('66.67');
  });

  it('returns null when the total is zero', () => {
    expect(divideToPercent('5', '0')).toBeNull();
  });
});

describe('applyAggregate', () => {
  const envelope = () => ({
    status: 'ok',
    projected: 'wealthsimple/fetch-identity-positions',
    data: positions(),
  });

  it('groups by a field and sums the named fields across profiles', () => {
    const out = applyAggregate(envelope(), { group_by: 'sym', sum: ['value'] }) as {
      aggregated: unknown;
      data: { total: string; rows: { key: string; value: string; pct: string }[] };
    };
    const rows = Object.fromEntries(out.data.rows.map((r) => [r.key, r]));
    // 19889.51 + 9909.52 + 49000.00 + 6572.19
    expect(rows.VFV.value).toBe('85371.22');
    expect(rows.XEQT.value).toBe('3963.14');
    expect(out.data.total).toBe('89334.36');
  });

  it('keeps only the accounts the caller named', () => {
    const out = applyAggregate(envelope(), {
      group_by: 'sym',
      sum: ['value'],
      accounts: ['acc-1', 'acc-2', 'acc-3'],
    }) as { data: { total: string; rows: { key: string; value: string; pct: string }[] } };
    const rows = Object.fromEntries(out.data.rows.map((r) => [r.key, r]));
    // acc-9 is excluded, so its 49000 must be absent from both row and total.
    expect(rows.VFV.value).toBe('36371.22');
    expect(out.data.total).toBe('40334.36');
    expect(rows.VFV.pct).toBe('90.17');
    expect(rows.XEQT.pct).toBe('9.83');
  });

  it('keeps only the profiles the caller named', () => {
    const out = applyAggregate(envelope(), { group_by: 'sym', sum: ['value'], profiles: ['magda'] }) as {
      data: { total: string; rows: { key: string }[] };
    };
    expect(out.data.rows.map((r) => r.key)).toEqual(['VFV']);
    expect(out.data.total).toBe('6572.19');
  });

  it('sums more than one field and orders rows by the first one, descending', () => {
    const out = applyAggregate(envelope(), { group_by: 'sym', sum: ['value', 'book'] }) as {
      data: { rows: { key: string; value: string; book: string }[] };
    };
    expect(out.data.rows.map((r) => r.key)).toEqual(['VFV', 'XEQT']);
    // 15200.12 + 8100.44 + 40000.00 + 5400.00
    expect(out.data.rows[0].book).toBe('68700.56');
  });

  it('marks the envelope so the agent knows the payload is derived', () => {
    const out = applyAggregate(envelope(), { group_by: 'sym', sum: ['value'] }) as {
      aggregated: { group_by: string; rows: number; matched: number };
    };
    expect(out.aggregated.group_by).toBe('sym');
    expect(out.aggregated.matched).toBe(5);
  });

  it('reports a currency only when every matched row agrees', () => {
    const mixed = {
      status: 'ok',
      data: {
        eudes: [
          { sym: 'A', accounts: ['x'], value: '1', currency: 'CAD' },
          { sym: 'B', accounts: ['x'], value: '1', currency: 'USD' },
        ],
      },
    };
    const out = applyAggregate(mixed, { group_by: 'sym', sum: ['value'] }) as { data: { currency: string | null } };
    expect(out.data.currency).toBeNull();
  });

  it('leaves a failed envelope untouched', () => {
    const failed = { status: 'error', code: 'auth_required' };
    expect(applyAggregate(failed, { group_by: 'sym', sum: ['value'] })).toBe(failed);
  });

  it('returns the payload untouched when the group_by field is on no row', () => {
    const out = applyAggregate(envelope(), { group_by: 'nope', sum: ['value'] }) as {
      aggregate_error?: string;
      data: unknown;
    };
    expect(out.aggregate_error).toContain('nope');
    expect(out.data).toEqual(positions());
  });

  it('returns the payload untouched when a summed value is not a number', () => {
    const bad = { status: 'ok', data: { eudes: [{ sym: 'A', accounts: ['x'], value: 'n/a' }] } };
    const out = applyAggregate(bad, { group_by: 'sym', sum: ['value'] }) as {
      aggregate_error?: string;
      data: unknown;
    };
    expect(out.aggregate_error).toContain('value');
    expect(out.data).toEqual({ eudes: [{ sym: 'A', accounts: ['x'], value: 'n/a' }] });
  });

  it('matches an account filter against a plain string account field too', () => {
    const flat = { status: 'ok', data: { eudes: [{ sym: 'A', accounts: 'acc-1', value: '10' }] } };
    const out = applyAggregate(flat, { group_by: 'sym', sum: ['value'], accounts: ['acc-1'] }) as {
      data: { total: string };
    };
    expect(out.data.total).toBe('10');
  });
});
