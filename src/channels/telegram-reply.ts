import type { ReplyContext } from './chat-sdk-bridge.js';

export function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
    messageId: reply.message_id,
  };
}

export function extractPaymentContext(raw: Record<string, unknown>): { senderId: string; eligible: boolean } {
  const from = raw.from as { id?: unknown; is_bot?: boolean } | undefined;
  const id = from?.id;
  const senderId = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : '';
  return {
    senderId,
    eligible:
      Boolean(senderId) &&
      from?.is_bot === false &&
      !raw.sender_chat &&
      !raw.edit_date &&
      !raw.forward_origin &&
      !raw.forward_from &&
      !raw.forward_from_chat &&
      !raw.forward_date,
  };
}
