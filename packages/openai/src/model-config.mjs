export const DEFAULT_MODEL = 'gpt-4.1';
export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// Max retry attempts for transient API failures (timeouts, 429, 5xx).
// The turn loop applies exponential backoff with `RETRY_BASE_DELAY_MS` —
// the host passes those constants through.
export const MAX_API_RETRIES = 3;

/**
 * Identify reasoning models — gpt-5 family, o-series, codex-* — which
 * accept (and benefit from) the `reasoning` parameter on the Responses
 * API. Sending `reasoning` to a non-reasoning model returns 400, so
 * gate the parameter on this predicate.
 *
 * The pattern:
 *   - `gpt-5*`     — gpt-5, gpt-5.4, gpt-5-mini, gpt-5.4-mini, gpt-5.4-nano, gpt-5.5
 *   - `o<digit>*`  — o1, o1-mini, o1-preview, o3, o3-mini, o4-mini
 *   - `codex*`     — codex-mini-latest
 */
export function isReasoningModel(model) {
  if (typeof model !== 'string') return false;
  return /^(gpt-5|o[1-9]|codex)/.test(model);
}

/**
 * Build an OpenAI `prompt_cache_key` from environment variables. The key
 * biases request routing toward a backend that already holds this
 * request's prompt prefix. It composes the available identity dimensions
 * (`AGENT_NAME` is required; `TENANT_ID` and `MODEL_NAME` are folded in
 * when set) plus a manual version suffix.
 *
 * Bump the version suffix when the prompt shape changes meaningfully —
 * a composition change costs at most one cold prefix write per identity
 * tuple. Returns `undefined` when no identity is available (skips the
 * cache-key request param).
 */
export function buildPromptCacheKey(env = process.env) {
  const agent = env.AGENT_NAME;
  if (!agent) return undefined;
  const parts = [agent];
  if (env.TENANT_ID) parts.push(env.TENANT_ID);
  if (env.MODEL_NAME) parts.push(env.MODEL_NAME);
  parts.push('v1');
  return parts.join('-');
}
