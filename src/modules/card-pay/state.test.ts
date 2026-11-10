import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadState, saveState, _setStatePathForTest, _resetStatePathForTest, type CardPayState } from './state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-pay-state-'));
  _setStatePathForTest(path.join(tmpDir, 'state.json'));
});

afterEach(() => {
  _resetStatePathForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadState', () => {
  it('returns a fresh disabled state when no file exists', () => {
    const s = loadState();
    expect(s.config.enabled).toBe(false);
    expect(s.seen).toEqual({});
    expect(s.offers).toEqual([]);
    expect(s.attempts).toEqual([]);
  });

  it('returns parsed state when the file exists', () => {
    const s: CardPayState = {
      config: { enabled: true, chatPlatformId: 'telegram:-100', approverIds: ['telegram:1'], cardId: 'card-1', profile: 'eudes' },
      seen: { root1: { st: 'notified', amount: 100, merchant: 'M', at: '2026-11-01T00:00:00Z' } },
      consumedPayments: [],
      offers: [],
      attempts: [],
      authAlerted: false,
      failStreak: 0,
      failAlerted: false,
      seeded: true,
    };
    fs.writeFileSync(path.join(tmpDir, 'state.json'), JSON.stringify(s));
    expect(loadState().seen.root1.amount).toBe(100);
  });

  it('throws on malformed JSON rather than silently reseeding', () => {
    fs.writeFileSync(path.join(tmpDir, 'state.json'), '{not json');
    expect(() => loadState()).toThrow();
  });
});

describe('saveState', () => {
  it('persists and reloads', () => {
    const s = loadState();
    s.seen.root1 = { st: 'paid', amount: 50, merchant: 'X', at: '2026-11-01T00:00:00Z' };
    saveState(s);
    expect(loadState().seen.root1.st).toBe('paid');
  });

  it('never leaves a partial file behind (atomic rename)', () => {
    const s = loadState();
    saveState(s);
    expect(fs.existsSync(path.join(tmpDir, 'state.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'state.json'))).toBe(true);
  });
});
