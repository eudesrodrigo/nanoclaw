import { describe, expect, it } from 'vitest';

import { buildDefaultSettings } from './group-init.js';

function parse(json: string): { env: Record<string, string>; model: string } {
  return JSON.parse(json);
}

describe('buildDefaultSettings', () => {
  it('uses ANTHROPIC_MODEL for every tier when no per-tier override is set', () => {
    const s = parse(buildDefaultSettings({ ANTHROPIC_MODEL: 'router-default' }));

    expect(s.model).toBe('router-default');
    expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('router-default');
    expect(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('router-default');
    expect(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('router-default');
  });

  it('lets a per-tier override win over ANTHROPIC_MODEL', () => {
    const s = parse(
      buildDefaultSettings({
        ANTHROPIC_MODEL: 'router-default',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.4-mini',
      }),
    );

    expect(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.4-mini');
    expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('router-default');
    expect(s.model).toBe('router-default');
  });

  it('falls back to the built-in tier names when the env is empty', () => {
    const s = parse(buildDefaultSettings({}));

    expect(s.model).toBe('claude-opus');
    expect(s.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus');
    expect(s.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet');
    expect(s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku');
  });

  it('keeps the non-model Claude Code settings untouched', () => {
    const s = parse(buildDefaultSettings({ ANTHROPIC_MODEL: 'router-default' }));

    expect(s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(s.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD).toBe('1');
    expect(s.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
  });

  it('emits pretty-printed JSON with a trailing newline', () => {
    const out = buildDefaultSettings({ ANTHROPIC_MODEL: 'router-default' });

    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('\n  "model"');
  });
});
