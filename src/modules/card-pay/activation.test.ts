import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCardPayService } from './service.js';
import { loadState, saveState, _setStatePathForTest, _resetStatePathForTest } from './state.js';
import { createWsClient } from './wealthsimple.js';

let dir: string;
const now = Date.parse('2026-11-10T12:00:00Z');
const activity = {
  id: 'p1',
  type: 'purchase',
  status: 'settled',
  amount: '10.00',
  currency: 'CAD',
  merchant_name: 'Store',
  occurred_at: '2026-11-10T11:00:00Z',
};
const group = { platform_id: 'telegram:-100', is_group: 1 };
const event = () => ({
  channelType: 'telegram',
  sourceChannelType: 'telegram',
  message: {
    content: { text: '1', replyTo: { messageId: 555 }, telegramPayment: { senderId: '123', eligible: true } },
  },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-activation-'));
  _setStatePathForTest(path.join(dir, 'state.json'));
  const state = loadState();
  state.config = {
    enabled: true,
    chatPlatformId: group.platform_id,
    approverIds: ['telegram:123', 'telegram:456'],
    cardId: 'card',
    profile: 'eudes',
  };
  state.seeded = true;
  state.seen.p1 = { st: 'notified', amount: 1000, merchant: 'Store', at: activity.occurred_at };
  state.offers.push({
    id: 'offer1',
    purchaseKey: 'p1',
    messageOutId: '-100:555',
    telegramMessageId: 555,
    merchant: 'Store',
    amountCents: 1000,
    currency: 'CAD',
    accounts: [{ num: 1, accountId: 'cash', name: 'Geral', balanceCents: 5000, observedAt: '12:00' }],
    createdAt: new Date(now).toISOString(),
    state: 'active',
  });
  saveState(state);
});
afterEach(() => {
  _resetStatePathForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(rows = [activity]) {
  const ws = {
    fetchActivities: vi.fn(async () => rows),
    fetchCashAccounts: vi.fn(async () => [{ id: 'cash', name: 'Geral' }]),
    fetchWithdrawableCents: vi.fn(async () => [{ accountId: 'cash', cents: 5000 }]),
    payCard: vi.fn(async () => ({ outcome: 'accepted' as const })),
  };
  const send = vi.fn(async () => '-100:556');
  const service = createCardPayService({
    ws,
    send,
    now: () => now,
    uuid: () => 'key1',
    resolveTelegramMessageId: () => 555,
  });
  return { ws, send, service };
}

describe('payment activation boundary', () => {
  it('consumes CLI impersonation without paying', async () => {
    const { service, ws } = fixture();
    const input = { ...event(), sourceChannelType: 'cli' };
    expect(await service.handleInbound(input, group, 'telegram:123')).toBe(true);
    expect(ws.payCard).not.toHaveBeenCalled();
  });

  it('rejects mismatched platform identity and edited or forwarded approvals', async () => {
    const { service, ws } = fixture();
    const wrong = event();
    wrong.message.content.telegramPayment.senderId = '999';
    await service.handleInbound(wrong, group, 'telegram:123');
    const edited = event();
    edited.message.content.telegramPayment.eligible = false;
    await service.handleInbound(edited, group, 'telegram:123');
    expect(ws.payCard).not.toHaveBeenCalled();
  });

  it.each([
    { rows: [{ ...activity, status: 'reversed' }] },
    { rows: [{ ...activity, amount: '11.00' }] },
    { rows: [{ ...activity, currency: 'USD' }] },
    { rows: [] },
  ])('rechecks the actual purchase before payment: %j', async ({ rows }) => {
    const { service, ws } = fixture(rows);
    await service.handleInbound(event(), group, 'telegram:123');
    expect(ws.payCard).not.toHaveBeenCalled();
  });

  it('checks expiry without waiting for another poll', async () => {
    const state = loadState();
    state.offers[0].createdAt = new Date(now - 25 * 3600000).toISOString();
    saveState(state);
    const { service, ws } = fixture();
    await service.handleInbound(event(), group, 'telegram:123');
    expect(ws.payCard).not.toHaveBeenCalled();
  });

  it('blocks unknown authentication outcomes instead of reopening the offer', async () => {
    const { service, ws } = fixture();
    ws.payCard.mockResolvedValue({ outcome: 'auth' } as never);
    await service.handleInbound(event(), group, 'telegram:123');
    expect(loadState().offers[0].state).toBe('blocked');
    await service.handleInbound(event(), group, 'telegram:123');
    expect(ws.payCard).toHaveBeenCalledTimes(1);
  });

  it('requires explicit mutation success from the configured profile', async () => {
    for (const data of [{}, 'ok', { magda: { success: true } }, { eudes: { success: false } }]) {
      const client = createWsClient(async () => ({ status: 'ok', data }));
      const result = await client.payCard({
        amountCents: 1000,
        cashAccountId: 'cash',
        creditAccountId: 'card',
        idempotencyKey: 'k',
        profile: 'eudes',
      });
      expect(result.outcome).not.toBe('accepted');
    }
  });

  it('does not read accounts from another profile', async () => {
    const client = createWsClient(async () => ({
      status: 'ok',
      data: { magda: [{ id: 'other', type: 'CASH', currency: 'CAD', status: 'open' }] },
    }));
    await expect(client.fetchCashAccounts('eudes')).rejects.toThrow();
  });

  it('does not infer a second purchase paid from our automated payment', async () => {
    const state = loadState();
    state.seen.p1.st = 'paid';
    state.seen.p2 = { ...state.seen.p1, st: 'notified' };
    state.attempts.push({
      offerId: 'offer1',
      userId: 'telegram:123',
      accountId: 'cash',
      amountCents: 1000,
      idempotencyKey: 'old-key',
      state: 'accepted',
      at: activity.occurred_at,
    });
    saveState(state);
    const { service } = fixture([
      { ...activity, id: 'p2' },
      { ...activity, id: 'payment1', type: 'payment', occurred_at: new Date(now).toISOString() },
    ]);
    await service.pollOnce();
    expect(loadState().seen.p2.st).toBe('notified');
  });

  it('never creates a payable offer for a foreign-currency purchase', async () => {
    const { service } = fixture([{ ...activity, id: 'usd', currency: 'USD' }]);
    await service.pollOnce();
    expect(loadState().offers.filter((offer) => offer.purchaseKey === 'usd' && offer.state === 'active')).toHaveLength(
      0,
    );
  });

  it('retries only confirmation delivery after an accepted payment', async () => {
    const { ws, send } = fixture();
    const deps = {
      ws,
      send,
      resolveTelegramMessageId: () => 555,
      now: () => now,
      uuid: () => 'key1',
      retryPaymentResults: true,
    };
    const first = createCardPayService(deps);
    send.mockRejectedValueOnce(new Error('Telegram offline'));
    await expect(first.handleInbound(event(), group, 'telegram:123')).resolves.toBe(true);
    expect(loadState().attempts[0].state).toBe('accepted');
    const restarted = createCardPayService(deps);
    await restarted.pollOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(ws.payCard).toHaveBeenCalledTimes(1);
  });

  it('validates and pays only the persisted amount and account', async () => {
    const { service, ws } = fixture();
    await service.handleInbound(event(), group, 'telegram:123');
    expect(ws.payCard).toHaveBeenCalledWith({
      amountCents: 1000,
      cashAccountId: 'cash',
      creditAccountId: 'card',
      idempotencyKey: 'key1',
      profile: 'eudes',
    });
    expect(loadState().attempts[0].state).toBe('accepted');
  });
});
