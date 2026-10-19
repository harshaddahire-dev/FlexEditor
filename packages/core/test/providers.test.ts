import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS, contextWindowFor, estimateTokens } from '../src';

describe('context windows', () => {
  it('knows common model families and leaves the rest unknown', () => {
    expect(contextWindowFor('claude-sonnet-5-5')).toBe(200_000);
    expect(contextWindowFor('anthropic/claude-3.5-haiku')).toBe(200_000);
    expect(contextWindowFor('gpt-4.1-mini')).toBe(1_000_000);
    expect(contextWindowFor('gpt-4o')).toBe(128_000);
    expect(contextWindowFor('gemini-2.5-pro')).toBe(1_000_000);
    expect(contextWindowFor('my-local-finetune')).toBeNull();
  });
  it('estimates tokens from characters, counting tool calls and tool specs', () => {
    const base = estimateTokens([{ role: 'user', content: 'x'.repeat(400) }]);
    expect(base).toBeGreaterThanOrEqual(100);
    expect(base).toBeLessThan(120);
    const withCall = estimateTokens([{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'split_clip', arguments: { clipId: 'c1' } }] }]);
    expect(withCall).toBeGreaterThan(5);
    expect(estimateTokens([], [{ name: 't', description: 'd'.repeat(80), parameters: {} }])).toBeGreaterThan(20);
  });
});

describe('presets', () => {
  it('lock built-in providers to their official endpoints; only custom is editable', () => {
    for (const [k, p] of Object.entries(PROVIDER_PRESETS)) expect(p.editableUrl).toBe(k === 'custom');
    expect(PROVIDER_PRESETS.anthropic.baseUrl).toBe('https://api.anthropic.com/v1');
  });
});
