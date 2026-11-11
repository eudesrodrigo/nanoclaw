import { describe, expect, it } from 'vitest';
import { extractPaymentContext } from './telegram-reply.js';

describe('Telegram payment identity', () => {
  it('uses the platform numeric sender id', () => {
    expect(extractPaymentContext({ from: { id: 123, is_bot: false } })).toEqual({ senderId: '123', eligible: true });
  });
  it.each([
    { edit_date: 123 },
    { forward_origin: {} },
    { forward_from: {} },
    { sender_chat: { id: -100 } },
    { from: { id: 123, is_bot: true } },
    { from: { username: '123' } },
  ])('disallows unsafe approval metadata %j', (fields) => {
    expect(extractPaymentContext({ from: { id: 123, is_bot: false }, ...fields }).eligible).toBe(false);
  });
});
