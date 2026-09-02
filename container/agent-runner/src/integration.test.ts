import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import { loadConfig } from './config.js';

beforeEach(() => {
  // The loop reads the runner config; without this it throws on the first
  // iteration and the tests below never exercise anything.
  loadConfig();
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

function insertTask(id: string, content: object) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content, series_id)
       VALUES (?, 'task', datetime('now'), 'pending', ?, ?)`,
    )
    .run(id, JSON.stringify(content), id);
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopUntilAborted(provider, controller.signal);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise;
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopUntilAborted(provider, controller.signal);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise;
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopUntilAborted(provider, controller.signal);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise;
  });

  // Regression: a recurring task that comes due while the query from an
  // earlier turn is still open arrives through the follow-up poller. Without
  // the pre-task gate there, every tick reached the provider — a 15-minute
  // task woke the agent all day long.
  it('should not reach the provider when a follow-up task is gated by its script', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });

    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="discord-test">ok</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopUntilAborted(provider, controller.signal);

    // The chat turn leaves the query open, waiting for follow-ups.
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);

    insertTask('t-due', { prompt: 'check the card', script: `echo '{"wakeAgent": false}'` });
    await waitFor(() => getPendingMessages().length === 0, 3000);

    controller.abort();
    await loopPromise;

    // One provider turn: the chat message. The task never got there.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Hello');
    expect(getUndeliveredMessages()).toHaveLength(1);
  });
});

// Helper: run the poll loop until the signal aborts it. Awaiting the returned
// promise after abort matters — a loop still running when afterEach closes the
// session DB keeps the whole test process alive.
function runPollLoopUntilAborted(provider: MockProvider, signal: AbortSignal): Promise<void> {
  return runPollLoop({ provider, cwd: '/tmp', signal });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
