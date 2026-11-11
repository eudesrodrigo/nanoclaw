import type { ChannelAdapter } from '../../channels/adapter.js';

export function telegramMessageId(id: string, platformId: string): number | null {
  const chatId = platformId.replace(/^telegram:/, '');
  const parts = id.split(':');
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== chatId)) return null;
  const last = parts.at(-1) ?? '';
  if (!/^[1-9]\d*$/.test(last)) return null;
  const value = Number(last);
  return Number.isSafeInteger(value) ? value : null;
}

export async function deliverCardPay(
  adapter: Pick<ChannelAdapter, 'deliver'> | undefined,
  platformId: string,
  text: string,
): Promise<string> {
  if (!adapter) throw new Error('Telegram adapter unavailable');
  const id = await adapter.deliver(platformId, null, { kind: 'chat', content: { text } });
  if (!id || telegramMessageId(id, platformId) === null) throw new Error('Telegram delivery receipt unavailable');
  return id;
}
