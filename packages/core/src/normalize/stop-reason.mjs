// Stop-reason normalization: map each provider's native terminal reason
// onto the neutral StopReason enum every port (and the turn loop) speaks.
//
// Neutral enum:
//   end_turn | tool_use | max_tokens | stop_sequence | refusal | paused | context_exceeded
//
// Imports nothing — not even node:*.

/** @typedef {'end_turn'|'tool_use'|'max_tokens'|'stop_sequence'|'refusal'|'paused'|'context_exceeded'} StopReason */

/** The neutral stop_reason enum, frozen for safe sharing. */
export const STOP_REASONS = Object.freeze({
  END_TURN: 'end_turn',
  TOOL_USE: 'tool_use',
  MAX_TOKENS: 'max_tokens',
  STOP_SEQUENCE: 'stop_sequence',
  REFUSAL: 'refusal',
  PAUSED: 'paused',
  CONTEXT_EXCEEDED: 'context_exceeded',
});

// Anthropic /v1/messages `stop_reason`. end_turn, tool_use, max_tokens,
// stop_sequence and refusal pass through unchanged; pause_turn → paused
// (server-tool pause; append the turn and re-request); a context overflow
// reported as a stop_reason → context_exceeded.
const ANTHROPIC = Object.freeze({
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  refusal: 'refusal',
  pause_turn: 'paused',
  model_context_window_exceeded: 'context_exceeded',
});

// OpenAI Responses / Chat Completions `finish_reason`. llama.cpp is
// OpenAI-compatible and shares this table.
const OPENAI_COMPATIBLE = Object.freeze({
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
});

/**
 * Normalize a provider's native stop/finish reason to the neutral enum.
 *
 * @param {'anthropic'|'openai'|'llama'} provider
 * @param {string} rawReason  the provider's native reason string
 * @param {{ hasToolCalls?: boolean }} [opts]
 *   `hasToolCalls` covers the documented OpenAI caveat: the Responses/Chat
 *   APIs sometimes report finish_reason `stop` even when the message carries
 *   tool calls. The caller inspects the message and passes the result here
 *   so the reason resolves to `tool_use`, not `end_turn`.
 * @returns {StopReason}
 */
export function normalizeStopReason(provider, rawReason, opts = {}) {
  const hasToolCalls = opts.hasToolCalls === true;

  if (provider === 'anthropic') {
    const mapped = ANTHROPIC[rawReason];
    if (mapped === undefined) {
      throw new Error(`normalizeStopReason: unknown anthropic stop_reason "${rawReason}"`);
    }
    return mapped;
  }

  if (provider === 'openai' || provider === 'llama') {
    // OpenAI caveat: finish_reason `stop` with tool calls present is really
    // a tool-use turn. Detect via the message, not the finish_reason alone.
    if (rawReason === 'stop' && hasToolCalls) return 'tool_use';
    const mapped = OPENAI_COMPATIBLE[rawReason];
    if (mapped === undefined) {
      throw new Error(`normalizeStopReason: unknown ${provider} finish_reason "${rawReason}"`);
    }
    return mapped;
  }

  throw new Error(`normalizeStopReason: unknown provider "${provider}"`);
}
