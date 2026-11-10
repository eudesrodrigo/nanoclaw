import { describe, it, expect } from 'vitest';
import { extractReplyContext } from './telegram-reply.js';

describe('extractReplyContext', () => {
  it('returns null when there is no reply', () => {
    expect(extractReplyContext({ message_id: 10, text: 'hello' })).toBeNull();
  });

  it('keeps the replied-to message id', () => {
    const raw = {
      message_id: 20,
      text: '2',
      reply_to_message: { message_id: 15, text: '🔔 Nova compra no cartão', from: { first_name: 'Nano' } },
    };
    expect(extractReplyContext(raw)).toEqual({ text: '🔔 Nova compra no cartão', sender: 'Nano', messageId: 15 });
  });

  it('falls back to caption and username', () => {
    const raw = {
      message_id: 21,
      text: '2',
      reply_to_message: { message_id: 16, caption: 'aviso', from: { username: 'nanobot' } },
    };
    expect(extractReplyContext(raw)).toEqual({ text: 'aviso', sender: 'nanobot', messageId: 16 });
  });

  it('marks unknown senders', () => {
    const raw = {
      message_id: 22,
      text: '2',
      reply_to_message: { message_id: 17 },
    };
    expect(extractReplyContext(raw)).toEqual({ text: '', sender: 'Unknown', messageId: 17 });
  });
});
