import { projectUsageForStreamJson } from '@bentway/stream-json';

// OpenAI 2-tier pricing (USD per million tokens). `cachedInput` is the
// OpenAI Prompt Caching read tier; OpenAI does not bill a separate write
// tier. Unknown model → 0.
//
// Long-context pricing (e.g. gpt-5.5 above 272K input tokens, billed at
// 2x input / 1.5x output) is not modeled here; add a dedicated entry if
// a deployment needs it tracked accurately.
const OPENAI_PRICING_USD_PER_MTOK = {
  'gpt-4.1': { input: 2.0, cachedInput: 0.5, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cachedInput: 0.1, output: 1.6 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.5': { input: 5.0, cachedInput: 0.5, output: 30.0 },
  'gpt-5.5-pro': { input: 30.0, output: 180.0, cachedInput: 3.0 },
  'gpt-5-mini': { input: 0.25, cachedInput: 0.025, output: 2.0 },
  'codex-mini-latest': { input: 1.5, cachedInput: 0.375, output: 6.0 },
};

/** Total session cost in USD from a usage report. Unknown model → 0. */
export function computeTotalCostUsd(model, usage) {
  const pricing = OPENAI_PRICING_USD_PER_MTOK[model];
  if (!pricing) return 0;

  const normalized = projectUsageForStreamJson(usage);
  const uncachedInputTokens = Math.max(0, normalized.inputTokens - normalized.cachedInputTokens);

  return (
    (uncachedInputTokens / 1_000_000) * pricing.input +
    (normalized.cachedInputTokens / 1_000_000) * pricing.cachedInput +
    (normalized.outputTokens / 1_000_000) * pricing.output
  );
}
