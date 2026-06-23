// Cache-write tier projection coverage.
//
// `projectUsageForStreamJson` carries `cacheCreationInputTokens`
// (Anthropic's `cache_creation_input_tokens`, surfaced via
// `input_tokens_details.cache_creation_tokens`). `accumulateUsage` folds
// it across turns, and `buildResultEvent` emits it into
// `result.usage.cache_creation_input_tokens`.
//
// Default-0 invariant: providers that don't report a write tier produce
// `input_tokens_details` with no `cache_creation_tokens` key → projection
// reads 0 → accumulator carries 0 → `buildResultEvent` emits 0.
import { describe, it, expect } from 'vitest';
import { projectUsageForStreamJson, buildResultEvent } from '@bentway/stream-json';
import { accumulateUsage } from '@bentway/core/usage';

type ResultEvent = {
  type: string;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
  total_cost_usd?: number;
};

describe('projectUsageForStreamJson — cache-write tier', () => {
  it('reads input_tokens_details.cache_creation_tokens when present', () => {
    const out = projectUsageForStreamJson({
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 30, cache_creation_tokens: 20 },
    });
    expect(out).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 30,
      cacheCreationInputTokens: 20,
      reasoningTokens: 0,
    });
  });

  it('defaults cacheCreationInputTokens to 0 when absent (openai/ollama shape)', () => {
    const out = projectUsageForStreamJson({
      input_tokens: 100,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 10 }, // no cache_creation_tokens
    });
    expect(out.cacheCreationInputTokens).toBe(0);
  });

  it('defaults cacheCreationInputTokens to 0 when input_tokens_details absent', () => {
    expect(projectUsageForStreamJson({ input_tokens: 10, output_tokens: 5 }).cacheCreationInputTokens).toBe(0);
    expect(projectUsageForStreamJson({}).cacheCreationInputTokens).toBe(0);
    expect(projectUsageForStreamJson(undefined as unknown as Record<string, number>).cacheCreationInputTokens).toBe(0);
  });
});

describe('accumulateUsage — cache-write tier folds across turns', () => {
  it('first-turn shortcut passes the turn object through (write tier present)', () => {
    const t1 = { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 10, cache_creation_tokens: 20 } };
    const acc = accumulateUsage({}, t1);
    expect(acc).toEqual(t1);
  });

  it('turn 2+ explicit-literal: folds cache_creation_tokens next to cached_tokens', () => {
    const t1 = { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 10, cache_creation_tokens: 20 } };
    const t2 = { input_tokens: 200, output_tokens: 80, input_tokens_details: { cached_tokens: 5, cache_creation_tokens: 15 } };
    const acc = accumulateUsage(accumulateUsage({}, t1), t2);
    expect(acc.input_tokens).toBe(300);
    expect(acc.output_tokens).toBe(130);
    expect(acc.input_tokens_details.cached_tokens).toBe(15);
    expect(acc.input_tokens_details.cache_creation_tokens).toBe(35);
  });

  it('turn-2 with no write tier reported (turn): folds to 0', () => {
    // Turn 1 reported a write; turn 2 didn't. Accumulator preserves turn-1 write.
    const t1 = { input_tokens: 100, output_tokens: 50, input_tokens_details: { cache_creation_tokens: 20 } };
    const t2 = { input_tokens: 50, output_tokens: 10 }; // no details at all
    const acc = accumulateUsage(accumulateUsage({}, t1), t2);
    expect(acc.input_tokens_details.cache_creation_tokens).toBe(20);
  });

  it('openai/ollama path (no write tier ever reported): cache_creation_tokens stays 0 across turns', () => {
    const t1 = { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 30 } };
    const t2 = { input_tokens: 80, output_tokens: 40, input_tokens_details: { cached_tokens: 10 } };
    const acc = accumulateUsage(accumulateUsage({}, t1), t2);
    expect(acc.input_tokens_details.cache_creation_tokens).toBe(0);
    expect(acc.input_tokens_details.cached_tokens).toBe(40);
  });
});

describe('buildResultEvent — emits cache_creation_input_tokens', () => {
  it('emits the projected cache_creation_input_tokens (non-zero)', () => {
    const ev = buildResultEvent({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      usage: {
        input_tokens: 170,
        output_tokens: 30,
        input_tokens_details: { cached_tokens: 100, cache_creation_tokens: 20 },
      },
      totalCostUsd: 0,
      durationApiMs: 0,
      numTurns: 1,
      resultText: 'ok',
    }) as unknown as ResultEvent;
    expect(ev.usage).toEqual({
      input_tokens: 170,
      output_tokens: 30,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 100,
    });
  });

  it('emits 0 when usage has no write tier (openai/ollama path — byte-identity)', () => {
    const ev = buildResultEvent({
      model: 'gpt-4.1',
      provider: 'openai',
      usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 20 } },
      totalCostUsd: 0,
      durationApiMs: 0,
      numTurns: 1,
      resultText: 'ok',
    }) as unknown as ResultEvent;
    expect(ev.usage).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20,
    });
  });
});
