import { serializeForOpenAI } from '@bentway/core/transcript';

/**
 * Build the OpenAI `serializeRequest` closure — the request-shape seam
 * injected into `runTurnLoop`. Captures per-session config and returns
 * `({ shadowTranscript, input, previousResponseId }) → { apiKey, baseUrl, body }`
 * where the body is the /v1/responses request.
 *
 * Two body shapes via the `stateless` flag:
 *   - `stateless: false` (default): per-turn `input` delta +
 *     `previous_response_id`; the server-side conversation thread owns
 *     history.
 *   - `stateless: true`: full transcript replay via
 *     `serializeForOpenAI(shadowTranscript)` with `store: false` +
 *     `include: ['reasoning.encrypted_content']` so encrypted-reasoning
 *     blocks round-trip across turns without server state.
 *
 * `tools` is the flat array (i.e. `runtimeTools.tools`). The caller
 * extracts it before constructing the factory.
 *
 * @param {{ apiKey: string, baseUrl: string, model: string, instructions: string,
 *   reasoningConfig: object, promptCacheKey?: string, stateless: boolean,
 *   tools: object[] }} cfg
 * @returns {(args: { shadowTranscript: object, input: object, previousResponseId?: string })
 *   => { apiKey: string, baseUrl: string, body: object }}
 */
export function makeOpenAiSerializeRequest({ apiKey, baseUrl, model, instructions, reasoningConfig, promptCacheKey, stateless, tools }) {
  return ({ shadowTranscript, input, previousResponseId }) => ({
    apiKey,
    baseUrl,
    body: stateless
      ? {
          model,
          instructions,
          input: serializeForOpenAI(shadowTranscript),
          store: false,
          include: ['reasoning.encrypted_content'],
          tools,
          ...reasoningConfig,
          ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        }
      : {
          model,
          instructions,
          input,
          previous_response_id: previousResponseId,
          tools,
          ...reasoningConfig,
          // Bias request routing toward a backend that holds this prefix.
          // The cache key is the host's responsibility to compute so
          // non-matching prefixes don't pool under one key.
          ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        },
  });
}
