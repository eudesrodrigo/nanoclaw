import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { _setStatePathForTest, _resetStatePathForTest } from './state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-pay-wiring-'));
  _setStatePathForTest(path.join(tmpDir, 'state.json'));
});

afterEach(() => {
  _resetStatePathForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('card-pay wiring', () => {
  it('ignores inbound traffic while disabled (default state)', async () => {
    const { tryCardPayInbound } = await import('./index.js');
    const claimed = await tryCardPayInbound(
      {
        channelType: 'telegram',
        message: { content: { text: '1', replyTo: { text: 'aviso', sender: 'bot', messageId: 555 } } },
      },
      { platform_id: 'telegram:-100', is_group: 1 },
      'telegram:eudes',
    );
    expect(claimed).toBe(false);
  });
});
