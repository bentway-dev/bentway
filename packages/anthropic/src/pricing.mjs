import { projectUsageForStreamJson } from '@bentway/stream-json';

// Anthropic 3-tier pricing (USD per million tokens). Cache tiers per
// Anthropic's published rates: the 5-minute ephemeral cache writes at
// 1.25× the input rate and reads at 0.1× the input rate. (1-hour beta
// writes at 2× input; not modeled here.) Source of truth:
// https://platform.claude.com/docs/en/about-claude/pricing.
//
// Dated model ids (`claude-haiku-4-5-20251001`, etc.) are normalized to
// the bare id before lookup. Unknown model → 0 (the cost field is
// optional in the emitted result event).
const ANTHROPIC_PRICING_USD_PER_MTOK = {
  'claude-opus-4-8':   { input: 5.0, cacheWrite: 6.25, cacheRead: 0.50, output: 25.0 },
  'claude-opus-4-7':   { input: 5.0, cacheWrite: 6.25, cacheRead: 0.50, output: 25.0 },
  'claude-sonnet-4-6': { input: 3.0, cacheWrite: 3.75, cacheRead: 0.30, output: 15.0 },
  'claude-haiku-4-5':  { input: 1.0, cacheWrite: 1.25, cacheRead: 0.10, output: 5.0 },
};

/**
 * Total session cost in USD from a usage report. Bills four tiers:
 * uncached input + cache-write + cache-read + output. Unknown model → 0.
 * Dated model ids are normalized to the bare id before lookup.
 */
export function computeAnthropicTotalCostUsd(model, usage) {
  const baseModel = typeof model === 'string' ? model.replace(/-\d{8}$/, '') : model;
  const pricing = ANTHROPIC_PRICING_USD_PER_MTOK[baseModel];
  if (!pricing) return 0;
  const n = projectUsageForStreamJson(usage);
  const uncached = Math.max(0, n.inputTokens - n.cachedInputTokens - n.cacheCreationInputTokens);
  return (
    (uncached / 1_000_000) * pricing.input +
    (n.cachedInputTokens / 1_000_000) * pricing.cacheRead +
    (n.cacheCreationInputTokens / 1_000_000) * pricing.cacheWrite +
    (n.outputTokens / 1_000_000) * pricing.output
  );
}
