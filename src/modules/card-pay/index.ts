import { randomUUID } from 'node:crypto';

import { callHttpClients } from '../../http-clients-service.js';
import { getMessagingGroupByPlatform, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { resolveSession, writeOutboundDirect, openInboundDb } from '../../session-manager.js';
import { loadState } from './state.js';
import { createWsClient } from './wealthsimple.js';
import { createCardPayService, type InboundLike, type GroupLike } from './service.js';
import { log } from '../../log.js';

let cachedTarget: { agentGroupId: string; sessionId: string } | null = null;

function resolveTarget(): { agentGroupId: string; sessionId: string } | null {
  if (cachedTarget) return cachedTarget;
  const state = loadState();
  const mg = getMessagingGroupByPlatform('telegram', state.config.chatPlatformId);
  if (!mg) return null;
  const agent = getMessagingGroupAgents(mg.id)[0];
  if (!agent) return null;
  const { session } = resolveSession(agent.agent_group_id, mg.id, null, agent.session_mode);
  cachedTarget = { agentGroupId: agent.agent_group_id, sessionId: session.id };
  return cachedTarget;
}

const service = createCardPayService({
  ws: createWsClient(callHttpClients),
  async send(text) {
    const target = resolveTarget();
    if (!target) {
      log.warn('card-pay: no session for configured chat — message not sent');
      return null;
    }
    const id = `cardpay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeOutboundDirect(target.agentGroupId, target.sessionId, {
      id,
      kind: 'chat',
      platformId: loadState().config.chatPlatformId,
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ text }),
    });
    return id;
  },
  resolveTelegramMessageId(messageOutId) {
    const target = resolveTarget();
    if (!target) return null;
    try {
      const db = openInboundDb(target.agentGroupId, target.sessionId);
      try {
        const row = db
          .prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?')
          .get(messageOutId) as { platform_message_id: string | null } | undefined;
        return row?.platform_message_id ? Number(row.platform_message_id) : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  uuid: () => randomUUID(),
});

export function tryCardPayInbound(event: InboundLike, mg: GroupLike, userId: string | null): Promise<boolean> {
  return service.handleInbound(event, mg, userId);
}

let timer: NodeJS.Timeout | null = null;
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
  timer = setInterval(() => void guardedPoll(), 15 * 60 * 1000);
  timer.unref();
  setTimeout(() => void guardedPoll(), 10_000).unref();
}

export function stopCardPay(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
