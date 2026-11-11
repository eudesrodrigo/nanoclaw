import { randomUUID } from 'node:crypto';
import { callHttpClients } from '../../http-clients-service.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { loadState } from './state.js';
import { createWsClient } from './wealthsimple.js';
import { createCardPayService, type InboundLike, type GroupLike } from './service.js';
import { deliverCardPay, telegramMessageId } from './delivery.js';
import { log } from '../../log.js';

const service = createCardPayService({
  ws: createWsClient(callHttpClients),
  send: (text) => deliverCardPay(getChannelAdapter('telegram'), loadState().config.chatPlatformId, text),
  resolveTelegramMessageId: (id) => telegramMessageId(id, loadState().config.chatPlatformId),
  now: () => Date.now(),
  uuid: () => randomUUID(),
});

export function tryCardPayInbound(event: InboundLike, mg: GroupLike, userId: string | null): Promise<boolean> {
  return service.handleInbound(event, mg, userId);
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let polling = false;

async function guardedPoll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    await service.pollOnce();
  } catch (err) {
    log.error('card-pay poll failed', { err });
  } finally {
    polling = false;
  }
}

export function startCardPay(): void {
  if (timer) return;
  timer = setInterval(() => void guardedPoll(), 15 * 60 * 1000);
  timer.unref();
  initialTimer = setTimeout(() => void guardedPoll(), 10_000);
  initialTimer.unref();
  log.info('card-pay monitor started', { enabled: loadState().config.enabled });
}

export function stopCardPay(): void {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
}
