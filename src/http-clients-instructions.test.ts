import { readFileSync } from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

// The http-clients recipes live in the always-loaded instructions fragment,
// not behind a `Skill` call. That trade is only worth it while the fragment
// stays small: every word is in the system prompt of every turn of every
// session. Measured on the production endpoint, a `Skill` turn plus a `Read`
// turn cost ~26s; this fragment costs ~1s of prefill. Past ~1500 words the
// prefill starts to eat the saving, so the cap is the whole point of the
// design. Split a service out to its own `<name>.instructions.md` rather than
// raising this number.
const WORD_CAP = 1500;

const FRAGMENT = path.join(process.cwd(), 'container/agent-runner/src/mcp-tools/http-clients.instructions.md');

describe('http-clients instructions fragment', () => {
  it('stays under the word cap', () => {
    const words = readFileSync(FRAGMENT, 'utf8').split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(WORD_CAP);
  });

  it('carries the recipes that replaced the skill', () => {
    const text = readFileSync(FRAGMENT, 'utf8');
    for (const marker of ['fetch-all-accounts', 'credit-card-payment', 'idempotency', 'receipt-detail']) {
      expect(text).toContain(marker);
    }
  });
});
