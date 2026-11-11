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

function unwrapProfileRows(data: unknown, profile: string): unknown[] {
  let rows = data;
  if (rows && !Array.isArray(rows) && typeof rows === 'object') {
    const envelope = rows as Record<string, unknown>;
    const errors = envelope.errors as Record<string, unknown> | undefined;
    if (errors?.[profile]) throw new Error('Profile query failed');
    rows = envelope.results ?? envelope;
    if (rows && !Array.isArray(rows) && typeof rows === 'object') {
      rows = (rows as Record<string, unknown>)[profile];
    }
  }
  if (!Array.isArray(rows)) throw Object.assign(new Error('unexpected shape from http-clients'), { code: 'bad_shape' });
  return rows;
}

const firstString = (rec: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v) return v;
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
      return unwrapProfileRows(res.data, profile) as Activity[];
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
      const rows = unwrapProfileRows(res.data, profile) as Record<string, unknown>[];
      return rows
        .map((outer) => {
          const r = (typeof outer.node === 'object' && outer.node !== null
            ? outer.node
            : outer) as Record<string, unknown>;
          const status = (firstString(r, ['status', 'state']) ?? '').toUpperCase();
          return {
            id: firstString(r, ['id', 'account_id', 'accountId']),
            name: firstString(r, ['name', 'nickname', 'display_name']),
            type: (firstString(r, ['unified_account_type', 'type', 'account_type']) ?? '').toUpperCase(),
            currency: (firstString(r, ['currency']) ?? '').toUpperCase(),
            closed: r.is_open === false || !(['OPEN', 'ACTIVE'].includes(status) || (!status && r.is_open === true)),
          };
        })
        .filter((a) => a.id && a.type === 'CASH' && a.currency === 'CAD' && !a.closed)
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
      const rows = unwrapProfileRows(res.data, profile) as Record<string, unknown>[];
      const decimalToCents = (v: unknown): number | null => {
        const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
        return typeof v === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(v) ? null : Number.isFinite(n) && n >= 0 && Number.isSafeInteger(Math.round(n * 100)) ? Math.round(n * 100) : null;
      };
      return rows.map((r) => {
        const policy = (r.funding_flow_policy ?? {}) as Record<string, unknown>;
        const balances = (policy.money_out_balances ?? []) as Array<Record<string, unknown>>;
        const cad = balances.find((b) => String(b.currency).toUpperCase() === 'CAD');
        const disabled = policy.withdrawal_enabled !== true;
        return {
          accountId: firstString(r, ['account_id', 'accountId', 'id']) ?? '',
          cents: disabled ? null : decimalToCents(cad?.amount),
        };
      });
    },

    async payCard(input) {
      let res: { status?: string; code?: string; message?: string; data?: unknown };
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
        })) as typeof res;
      } catch (e) {
        return { outcome: 'unknown', reason: e instanceof Error ? e.message : String(e) };
      }
      if (res.status === 'ok') {
        const envelope = res.data as Record<string, unknown> | null;
        const result = envelope && typeof envelope === 'object'
          ? (envelope[input.profile] ?? envelope) as Record<string, unknown>
          : null;
        if (result?.success === true) return { outcome: 'accepted' };
        if (result?.success === false) return { outcome: 'rejected', reason: 'Wealthsimple recusou o pagamento' };
        return { outcome: 'unknown', reason: 'Resposta de pagamento sem confirmação explícita' };
      }
      if (res.code === 'auth_required') return { outcome: 'auth' };
      const message = res.message ?? res.code ?? 'error';
      if (/refused/i.test(message)) return { outcome: 'rejected', reason: message };
      return { outcome: 'unknown', reason: message };
    },
  };
}
