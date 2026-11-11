import { describe, expect, it, vi } from 'vitest';
import { deliverCardPay, telegramMessageId } from './delivery.js';

describe('card-pay delivery', () => {
  it('uses the channel adapter directly and keeps the returned platform id', async () => {
    const adapter = { deliver: vi.fn(async () => '-100:555') };
    expect(await deliverCardPay(adapter, 'telegram:-100', 'aviso')).toBe('-100:555');
    expect(adapter.deliver).toHaveBeenCalledWith('telegram:-100', null, { kind: 'chat', content: { text: 'aviso' } });
  });
  it('parses the composite id only for the intended chat', () => {
    expect(telegramMessageId('-100:555', 'telegram:-100')).toBe(555);
    expect(telegramMessageId('-200:555', 'telegram:-100')).toBeNull();
    expect(telegramMessageId('555', 'telegram:-100')).toBe(555);
    expect(telegramMessageId('unknown', 'telegram:-100')).toBeNull();
  });
  it('fails rather than recording delivery with no adapter or no receipt', async () => {
    await expect(deliverCardPay(undefined, 'telegram:-100', 'aviso')).rejects.toThrow();
    await expect(deliverCardPay({ deliver: vi.fn(async () => undefined) }, 'telegram:-100', 'aviso')).rejects.toThrow();
  });
});
