import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { callHttpClients } from './http-clients-service.js';

function fakeProc(stdout: string, stderr: string, code: number | null) {
  const proc = {
    stdout: { on: vi.fn((_: string, cb: (d: Buffer) => void) => cb(Buffer.from(stdout))) },
    stderr: { on: vi.fn((_: string, cb: (d: Buffer) => void) => cb(Buffer.from(stderr))) },
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      if (event === 'close') cb(code);
    }),
  };
  return proc;
}

describe('callHttpClients', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns the CLI with built args and returns the parsed result', async () => {
    spawnMock.mockReturnValue(fakeProc(JSON.stringify({ status: 'ok', data: { eudes: [1, 2] } }), '', 0));
    const result = (await callHttpClients({
      service: 'wealthsimple',
      command: 'fetch-credit-card-activities',
      args: { 'credit-account-id': 'card-1', profile: 'eudes' },
      raw: true,
    })) as { status: string; data: unknown };
    expect(result.status).toBe('ok');
    const [bin, args] = spawnMock.mock.calls[0];
    expect(String(bin).length).toBeGreaterThan(0);
    expect(args).toEqual(['wealthsimple', 'fetch-credit-card-activities', '--credit-account-id', 'card-1', '--profile', 'eudes']);
  });

  it('propagates CLI errors as classified envelopes', async () => {
    spawnMock.mockReturnValue(fakeProc('', 'boom', 1));
    const result = (await callHttpClients({ service: 'wealthsimple', command: 'credit-card-payment', args: {}, raw: true })) as {
      status: string;
      code?: string;
    };
    expect(result.status).toBe('error');
  });

  it('rejects when the process fails to spawn', async () => {
    spawnMock.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (e: Error) => void) => {
        if (event === 'error') cb(new Error('ENOENT'));
      }),
    });
    await expect(callHttpClients({ service: 'wealthsimple', command: 'x', raw: true })).rejects.toThrow('ENOENT');
  });
});
