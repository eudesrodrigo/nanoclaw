import type { Activity } from './domain.js';

export interface PayInput {
  amountCents: number;
  cashAccountId: string;
  creditAccountId: string;
  idempotencyKey: string;
  profile: string;
}

export type PayOutcome =
  | { outcome: 'accepted' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown'; reason: string }
  | { outcome: 'auth' };

interface CallFn {
  (call: {
    service?: string;
    command?: string;
    args?: Record<string, string | number | boolean | string[]>;
    raw?: boolean;
  }): Promise<object>;
}

function unwrapProfileRows(data: unknown): unknown[] {
  let rows = data;
  if (rows && !Array.isArray(rows) && typeof rows === 'object') {
    const rec = rows as Record<string, unknown>;
    if (Array.isArray(rec.results)) rows = rec.results;
    else {
      const keyed = Object.values(rec).find(Array.isArray);
      if (keyed) rows = keyed;
    }
  }
  if (!Array.isArray(rows)) throw Object.assign(new Error('unexpected shape from http-clients'), { code: 'bad_shape' });
  return rows as unknown[];
}

const firstString = (rec: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
};

const firstNumber = (rec: Record<string, unknown>, keys: string[]): number | null => {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
};

export interface WsClient {
  fetchActivities(cardId: string, profile: string, startDate: string): Promise<Activity[]>;
  fetchCashAccounts(profile: string): Promise<Array<{ id: string; name: string }>>;
  fetchWithdrawableCents(
    accountIds: string[],
    destinationId: string,
    profile: string,
  ): Promise<Array<{ accountId: string; cents: number | null }>>;
  payCard(input: PayInput): Promise<PayOutcome>;
}

export function createWsClient(call: CallFn): WsClient {
  return {
    async fetchActivities(cardId, profile, startDate) {
      const res = (await call({
        service: 'wealthsimple',
        command: 'fetch-credit-card-activities',
        args: { 'credit-account-id': cardId, profile, 'start-date': startDate },
        raw: true,
      })) as { status?: string; code?: string; message?: string; data?: unknown };
      if (res.status !== 'ok')
        throw Object.assign(new Error(res.message || res.code || 'fetch failed'), { code: res.code });
      return unwrapProfileRows(res.data) as Activity[];
    },

    async fetchCashAccounts(profile) {
      const res = (await call({
        service: 'wealthsimple',
        command: 'fetch-all-accounts',
        args: { profile },
        raw: true,
      })) as {
        status?: string;
        code?: string;
        message?: string;
        data?: unknown;
      };
      if (res.status !== 'ok')
        throw Object.assign(new Error(res.message || res.code || 'fetch failed'), { code: res.code });
      const rows = unwrapProfileRows(res.data) as Record<string, unknown>[];
      return rows
        .map((r) => ({
          id: firstString(r, ['id', 'account_id', 'accountId']),
          name: firstString(r, ['name', 'nickname', 'display_name']),
          type: (firstString(r, ['type', 'account_type']) ?? '').toUpperCase(),
          currency: (firstString(r, ['currency']) ?? '').toUpperCase(),
          status: (firstString(r, ['status', 'state']) ?? '').toUpperCase(),
        }))
        .filter((a) => a.id && a.type === 'CASH' && a.currency === 'CAD' && a.status !== 'CLOSED')
        .map((a) => ({ id: a.id as string, name: a.name ?? (a.id as string) }));
    },

    async fetchWithdrawableCents(accountIds, destinationId, profile) {
      const res = (await call({
        service: 'wealthsimple',
        command: 'fetch-accounts-withdrawable-balances',
        args: { 'account-ids': accountIds, 'destination-id': destinationId, 'destination-type': 'Account', profile },
        raw: true,
      })) as { status?: string; code?: string; message?: string; data?: unknown };
      if (res.status !== 'ok')
        throw Object.assign(new Error(res.message || res.code || 'fetch failed'), { code: res.code });
      const rows = unwrapProfileRows(res.data) as Record<string, unknown>[];
      return rows.map((r) => ({
        accountId: firstString(r, ['account_id', 'accountId', 'id']) ?? '',
        cents: firstNumber(r, ['money_out_amount_cents', 'amount_cents', 'withdrawable_cents', 'balance_cents']),
      }));
    },

    async payCard(input) {
      let res: { status?: string; code?: string; message?: string };
      try {
        res = (await call({
          service: 'wealthsimple',
          command: 'credit-card-payment',
          args: {
            'amount-cents': input.amountCents,
            'cash-account-id': input.cashAccountId,
            'credit-account-id': input.creditAccountId,
            'idempotency-key': input.idempotencyKey,
            profile: input.profile,
          },
          raw: true,
        })) as { status?: string; code?: string; message?: string };
      } catch (e) {
        return { outcome: 'unknown', reason: e instanceof Error ? e.message : String(e) };
      }
      if (res.status === 'ok') return { outcome: 'accepted' };
      if (res.code === 'auth_required') return { outcome: 'auth' };
      const message = res.message ?? res.code ?? 'error';
      if (/refused/i.test(message)) return { outcome: 'rejected', reason: message };
      return { outcome: 'unknown', reason: message };
    },
  };
}
