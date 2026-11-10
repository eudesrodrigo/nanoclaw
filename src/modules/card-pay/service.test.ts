import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCardPayService, type CardPayDeps } from './service.js';
import { _setStatePathForTest, _resetStatePathForTest, saveState, loadState, type CardPayState } from './state.js';
import type { WsClient } from './wealthsimple.js';
import type { Activity } from './domain.js';

let tmpDir: string;
let sent: Array<{ text: string; messageOutId: string }>;
let telegramIds: Record<string, number>;
let nowMs: number;
let seq: number;

function purchase(id: string, amount: string, merchant = 'Loja', occurred = '2026-11-09T12:00:00Z'): Activity {
  return {
    id,
    type: 'purchase',
    status: 'settled',
    amount,
    merchant_name: merchant,
    currency: 'CAD',
    occurred_at: occurred,
  };
}

function baseState(overrides: Partial<CardPayState> = {}): CardPayState {
  return {
    config: {
      enabled: true,
      chatPlatformId: 'telegram:-100',
      approverIds: ['telegram:eudes', 'telegram:magda'],
      cardId: 'card-1',
      profile: 'eudes',
    },
    seen: {},
    consumedPayments: [],
    offers: [],
    attempts: [],
    authAlerted: false,
    failStreak: 0,
    failAlerted: false,
    seeded: true,
    ...overrides,
  };
}

function makeWs(over: Partial<WsClient> = {}): WsClient {
  return {
    fetchActivities: vi.fn(async () => [] as Activity[]),
    fetchCashAccounts: vi.fn(async () => [{ id: 'ca-1', name: 'Geral' }]),
    fetchWithdrawableCents: vi.fn(async () => [{ accountId: 'ca-1', cents: 100000 }]),
    payCard: vi.fn(async () => ({ outcome: 'accepted' as const })),
    ...over,
  };
}

function makeDeps(ws: WsClient): CardPayDeps {
  return {
    ws,
    send: vi.fn(async (text: string) => {
      const messageOutId = `out-${++seq}`;
      sent.push({ text, messageOutId });
      return messageOutId;
    }),
    resolveTelegramMessageId: (messageOutId: string) => telegramIds[messageOutId] ?? null,
    now: () => nowMs,
    uuid: () => `uuid-${++seq}`,
  };
}

const group = { platform_id: 'telegram:-100', is_group: 1 };
const replyEvent = (text: string, messageId: number, senderId = 'telegram:eudes') => ({
  channelType: 'telegram',
  message: { content: { text, senderId, replyTo: { text: 'aviso', sender: 'bot', messageId } } },
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-pay-svc-'));
  _setStatePathForTest(path.join(tmpDir, 'state.json'));
  sent = [];
  telegramIds = {};
  nowMs = Date.parse('2026-11-10T12:00:00Z');
  seq = 0;
});

afterEach(() => {
  _resetStatePathForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('pollOnce', () => {
  it('does nothing when disabled', async () => {
    saveState(baseState({ config: { ...baseState().config, enabled: false } }));
    const ws = makeWs();
    await createCardPayService(makeDeps(ws)).pollOnce();
    expect(ws.fetchActivities).not.toHaveBeenCalled();
  });

  it('notifies a new purchase with numbered accounts and balances', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '42.50', 'Farmácia')]) });
    const svc = createCardPayService(makeDeps(ws));
    await svc.pollOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Farmácia');
    expect(sent[0].text).toContain('42.50');
    expect(sent[0].text).toContain('1) Geral');
    expect(sent[0].text).toContain('1000.00');
    const s = loadState();
    expect(s.seen.p1.st).toBe('notified');
    expect(s.offers).toHaveLength(1);
    expect(s.offers[0].amountCents).toBe(4250);
    expect(s.offers[0].accounts[0].accountId).toBe('ca-1');
  });

  it('seeds silently on the first run', async () => {
    saveState(baseState({ seeded: false }));
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    await createCardPayService(makeDeps(ws)).pollOnce();
    expect(sent).toHaveLength(0);
    const s = loadState();
    expect(s.seen.p1.st).toBe('seeded');
    expect(s.seeded).toBe(true);
  });

  it('sends a manual-payment message instead of an offer above CAD 200', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '250.00')]) });
    await createCardPayService(makeDeps(ws)).pollOnce();
    expect(sent[0].text).toContain('200');
    expect(sent[0].text.toLowerCase()).toContain('manual');
    expect(loadState().offers).toHaveLength(0);
  });

  it('alerts once on auth failure and recovers silently', async () => {
    saveState(baseState());
    let fail = true;
    const ws = makeWs({
      fetchActivities: vi.fn(async () => {
        if (fail) throw Object.assign(new Error('auth'), { code: 'auth_required' });
        return [purchase('p1', '10.00')];
      }),
    });
    const svc = createCardPayService(makeDeps(ws));
    await svc.pollOnce();
    await svc.pollOnce();
    expect(sent.filter((m) => m.text.toLowerCase().includes('autentica'))).toHaveLength(1);
    fail = false;
    await svc.pollOnce();
    const s = loadState();
    expect(s.authAlerted).toBe(false);
    expect(s.seen.p1.st).toBe('notified');
  });

  it('alerts once after 8 consecutive failures', async () => {
    saveState(baseState());
    const ws = makeWs({
      fetchActivities: vi.fn(async () => {
        throw Object.assign(new Error('boom'), { code: 'transient' });
      }),
    });
    const svc = createCardPayService(makeDeps(ws));
    for (let i = 0; i < 9; i++) await svc.pollOnce();
    expect(sent.filter((m) => m.text.toLowerCase().includes('falhou'))).toHaveLength(1);
  });

  it('reoffers when the settled amount changes', async () => {
    saveState(baseState());
    let rows: Activity[] = [purchase('p1', '10.00')];
    const ws = makeWs({ fetchActivities: vi.fn(async () => rows) });
    const svc = createCardPayService(makeDeps(ws));
    await svc.pollOnce();
    rows = [purchase('p1', '12.00')];
    await svc.pollOnce();
    const s = loadState();
    expect(s.offers).toHaveLength(2);
    expect(s.offers[0].state).toBe('invalidated');
    expect(s.offers[1].amountCents).toBe(1200);
    expect(sent).toHaveLength(2);
  });

  it('expires offers after 24h', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    const svc = createCardPayService(makeDeps(ws));
    await svc.pollOnce();
    nowMs += 25 * 3600 * 1000;
    await svc.pollOnce();
    expect(loadState().offers[0].state).toBe('expired');
  });

  it('a poll in flight cannot clobber payment state written by a reply', async () => {
    saveState(baseState());
    const ws = makeWs({
      fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]),
      fetchCashAccounts: vi.fn(async () => [{ id: 'ca-1', name: 'Geral' }]),
      fetchWithdrawableCents: vi.fn(async () => [{ accountId: 'ca-1', cents: 100000 }]),
      payCard: vi.fn(async () => ({ outcome: 'accepted' }) as const),
    });
    const svc = createCardPayService(makeDeps(ws));

    await svc.pollOnce();
    telegramIds[sent[0].messageOutId] = 555;

    let releaseFetch!: (rows: Activity[]) => void;
    const fetchGate = new Promise<Activity[]>((r) => (releaseFetch = r));
    (ws.fetchActivities as ReturnType<typeof vi.fn>).mockImplementation(() => fetchGate);

    const poll = svc.pollOnce();
    const reply = svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes');
    releaseFetch([purchase('p1', '10.00')]);
    await Promise.all([poll, reply]);

    const s = loadState();
    expect(ws.payCard).toHaveBeenCalledTimes(1);
    expect(s.offers[0].state).toBe('paid');
    expect(s.attempts).toHaveLength(1);
    expect(s.attempts[0].state).toBe('accepted');

    (ws.fetchActivities as ReturnType<typeof vi.fn>).mockResolvedValue([purchase('p1', '10.00')]);
    await svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes');
    expect(ws.payCard).toHaveBeenCalledTimes(1);
  });

  it('recovers a stuck submitting attempt on the next poll', async () => {
    const st = baseState();
    st.seen.p1 = { st: 'notified', amount: 1000, merchant: 'Loja', at: '2026-11-09T12:00:00Z' };
    st.offers.push({
      id: 'o1',
      purchaseKey: 'p1',
      messageOutId: 'out-1',
      telegramMessageId: 555,
      merchant: 'Loja',
      amountCents: 1000,
      currency: 'CAD',
      accounts: [{ num: 1, accountId: 'ca-1', name: 'Geral', balanceCents: 100000, observedAt: '12:00' }],
      createdAt: '2026-11-10T11:00:00.000Z',
      state: 'paying',
    });
    st.attempts.push({
      offerId: 'o1',
      userId: 'telegram:eudes',
      accountId: 'ca-1',
      amountCents: 1000,
      idempotencyKey: 'k-1',
      state: 'submitting',
      at: '2026-11-10T11:05:00.000Z',
    });
    saveState(st);

    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    await createCardPayService(makeDeps(ws)).pollOnce();

    const s = loadState();
    expect(s.attempts[0].state).toBe('unknown');
    expect(s.offers[0].state).toBe('blocked');
    expect(sent.some((m) => m.text.toLowerCase().includes('incerto'))).toBe(true);
  });
});

describe('handleInbound', () => {
  async function notifiedService(ws: WsClient) {
    const deps = makeDeps(ws);
    const svc = createCardPayService(deps);
    await svc.pollOnce();
    const messageOutId = sent[0].messageOutId;
    telegramIds[messageOutId] = 555;
    return { svc, deps };
  }

  it('ignores messages that are not replies to our notification', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    const { svc } = await notifiedService(ws);
    expect(
      await svc.handleInbound(
        { channelType: 'telegram', message: { content: { text: '2' } } },
        group,
        'telegram:eudes',
      ),
    ).toBe(false);
    expect(await svc.handleInbound(replyEvent('2', 999), group, 'telegram:eudes')).toBe(false);
  });

  it('ignores messages from other chats', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    const { svc } = await notifiedService(ws);
    expect(
      await svc.handleInbound(replyEvent('2', 555), { platform_id: 'telegram:-200', is_group: 1 }, 'telegram:eudes'),
    ).toBe(false);
  });

  it('pays on a valid number without requiring a mention', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '42.50', 'Farmácia')]) });
    const { svc } = await notifiedService(ws);
    expect(await svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes')).toBe(true);
    expect(ws.payCard).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 4250,
        cashAccountId: 'ca-1',
        creditAccountId: 'card-1',
        profile: 'eudes',
      }),
    );
    const s = loadState();
    expect(s.seen.p1.st).toBe('paid');
    expect(s.offers[0].state).toBe('paid');
    expect(s.attempts[0].state).toBe('accepted');
    expect(s.attempts[0].idempotencyKey).toMatch(/^uuid-/);
    const confirm = sent.at(-1)!.text;
    expect(confirm).toContain('Farmácia');
    expect(confirm.toLowerCase()).toContain('aceitou');
  });

  it('magda can also authorize', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    const { svc } = await notifiedService(ws);
    expect(await svc.handleInbound(replyEvent('1', 555, 'telegram:magda'), group, 'telegram:magda')).toBe(true);
    expect(ws.payCard).toHaveBeenCalledTimes(1);
  });

  it('rejects other users without paying', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    const { svc } = await notifiedService(ws);
    expect(await svc.handleInbound(replyEvent('1', 555, 'telegram:stranger'), group, 'telegram:stranger')).toBe(true);
    expect(ws.payCard).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text.toLowerCase()).toContain('eudes');
    expect(loadState().seen.p1.st).toBe('notified');
  });

  it('replies with an error on invalid numbers and keeps the offer active', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    const { svc } = await notifiedService(ws);
    expect(await svc.handleInbound(replyEvent('abc', 555), group, 'telegram:eudes')).toBe(true);
    expect(await svc.handleInbound(replyEvent('9', 555), group, 'telegram:eudes')).toBe(true);
    expect(ws.payCard).not.toHaveBeenCalled();
    expect(loadState().offers[0].state).toBe('active');
  });

  it('rechecks balance and refuses insufficient funds', async () => {
    saveState(baseState());
    const ws = makeWs({
      fetchActivities: vi.fn(async () => [purchase('p1', '80.00')]),
      fetchWithdrawableCents: vi.fn(async () => [{ accountId: 'ca-1', cents: 5000 }]),
    });
    const { svc } = await notifiedService(ws);
    expect(await svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes')).toBe(true);
    expect(ws.payCard).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text.toLowerCase()).toContain('saldo insuficiente');
  });

  it('refuses when balance is unavailable rather than assuming zero', async () => {
    saveState(baseState());
    const ws = makeWs({
      fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]),
      fetchWithdrawableCents: vi.fn(async () => [{ accountId: 'ca-1', cents: null }]),
    });
    const { svc } = await notifiedService(ws);
    expect(await svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes')).toBe(true);
    expect(ws.payCard).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text.toLowerCase()).toContain('saldo');
  });

  it('double replies run a single payment', async () => {
    saveState(baseState());
    let release!: (o: { outcome: 'accepted' }) => void;
    const gate = new Promise<{ outcome: 'accepted' }>((r) => (release = r));
    const ws = makeWs({
      fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]),
      payCard: vi.fn(() => gate),
    });
    const { svc } = await notifiedService(ws);
    const first = svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes');
    const second = svc.handleInbound(replyEvent('1', 555), group, 'telegram:magda');
    release({ outcome: 'accepted' });
    await Promise.all([first, second]);
    expect(ws.payCard).toHaveBeenCalledTimes(1);
    expect(loadState().attempts).toHaveLength(1);
  });

  it('unknown outcome blocks the offer and never retries automatically', async () => {
    saveState(baseState());
    const ws = makeWs({
      fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]),
      payCard: vi.fn(async () => ({ outcome: 'unknown', reason: 'timeout' }) as const),
    });
    const { svc } = await notifiedService(ws);
    await svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes');
    expect(sent.at(-1)!.text.toLowerCase()).toContain('verific');
    const s = loadState();
    expect(s.offers[0].state).toBe('blocked');
    expect(s.attempts[0].state).toBe('unknown');
    await svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes');
    expect(ws.payCard).toHaveBeenCalledTimes(1);
  });

  it('rejected payment reopens the offer for another account', async () => {
    saveState(baseState());
    const ws = makeWs({
      fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]),
      payCard: vi.fn(async () => ({ outcome: 'rejected', reason: 'refused: insufficient funds' }) as const),
    });
    const { svc } = await notifiedService(ws);
    await svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes');
    expect(sent.at(-1)!.text.toLowerCase()).toContain('recusado');
    expect(loadState().offers[0].state).toBe('active');
  });

  it('refuses to pay an expired offer', async () => {
    saveState(baseState());
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    const { svc } = await notifiedService(ws);
    nowMs += 25 * 3600 * 1000;
    await svc.pollOnce();
    expect(await svc.handleInbound(replyEvent('1', 555), group, 'telegram:eudes')).toBe(true);
    expect(ws.payCard).not.toHaveBeenCalled();
    expect(sent.at(-1)!.text.toLowerCase()).toContain('expirad');
  });

  it('does not pay a purchase the manual matcher already marked paid', async () => {
    const st = baseState();
    st.seen.p1 = { st: 'paid', amount: 1000, merchant: 'Loja', at: '2026-11-09T12:00:00Z' };
    saveState(st);
    const ws = makeWs({ fetchActivities: vi.fn(async () => [purchase('p1', '10.00')]) });
    const svc = createCardPayService(makeDeps(ws));
    await svc.pollOnce();
    expect(sent.filter((m) => m.text.includes('1)'))).toHaveLength(0);
  });
});
