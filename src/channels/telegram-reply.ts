import type { ReplyContext } from './chat-sdk-bridge.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
    messageId: reply.message_id,
  };
}
