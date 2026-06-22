// OpenAI Responses-API completion port. The only place in this package
// where OpenAI wire format lives. POSTs `/responses` and translates the
// parsed payload into the neutral PortResult the turn loop consumes
// directly.
//
// On expected transport failures (non-2xx, AbortError, fetch-level
// TypeError) `complete` resolves to the neutral error shape
// `{ kind:'error', stage:'transport', retryable, status?, message,
//   stopReason:'error' }` rather than throwing. The turn loop reads
// `retryable` to decide whether to back off. Truly unexpected throws
// (post-200 parse bugs) still propagate.
//
// Imports the global fetch and the neutral retryable classifier from
// @bentway/core.

import { isRetryableApiError } from '@bentway/core/normalize/retryable';

/**
 * The neutral success shape every provider port's `complete()` resolves to.
 * The turn loop reads these fields directly.
 *
 *   text       — concatenated assistant text. The per-provider join rule
 *                lives in the port (OpenAI: `parts.join('\n').trim()`;
 *                Anthropic: no separator).
 *   calls      — function calls; `arguments` is the parsed object.
 *   reasoning  — opaque JSON strings (one per provider reasoning block);
 *                the full item is carried verbatim so signed/encrypted
 *                payloads replay byte-identically via
 *                `serializeFor<provider>`.
 *   phase      — optional assistant phase string (OpenAI Responses surfaces
 *                'commentary' / 'final_answer'; other providers omit it).
 *   stopReason — neutral stop_reason (or undefined when the port doesn't
 *                surface one). The turn loop's terminals emit their own
 *                stop_reason strings regardless of this field.
 *   usage      — OpenAI-inclusive shape:
 *                  { input_tokens, output_tokens,
 *                    input_tokens_details?: { cached_tokens?, cache_creation_tokens? } }
 *                `input_tokens_details` is omitted entirely when both cache
 *                tiers are 0.
 *   id         — response id (used by OpenAI's stateful flow as
 *                `previous_response_id`). Undefined for stateless providers.
 *   textChunks — present on streaming providers; used by the
 *                `emitProviderTextStream` / `emitProviderText` hooks to
 *                replay coalesced text flushes before `turn_tokens`.
 *
 * @typedef {{
 *   text: string,
 *   calls: Array<{ callId: string, name: string, arguments: Record<string, unknown> }>,
 *   reasoning: string[],
 *   phase: string | undefined,
 *   stopReason: string | undefined,
 *   usage: { input_tokens?: number, output_tokens?: number, input_tokens_details?: { cached_tokens?: number, cache_creation_tokens?: number }, output_tokens_details?: { reasoning_tokens?: number } },
 *   id?: string,
 *   textChunks?: string[],
 * }} PortResult
 */

// Request-level timeout (120 s). Node's native fetch has no built-in HTTP
// timeout (only a TCP-level socket timeout of ~2 hours); without this, a
// hung API blocks the session indefinitely.
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Concatenate the Responses payload's text into one string. Prefers the
 * top-level `output_text` shortcut when present; otherwise walks the
 * output[] message items, concatenating block.text values with `\n` and
 * trimming.
 *
 * @param {object} payload
 * @returns {string}
 */
function extractText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.length > 0) {
    return payload.output_text;
  }
  if (!Array.isArray(payload?.output)) return '';
  const parts = [];
  for (const item of payload.output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (typeof block?.text === 'string' && block.text.length > 0) {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * Tool calls from a Responses payload. `arguments` is the JSON-parsed
 * object, with a `{ __raw_arguments }` fallback on parse failure so the
 * wire string is preserved and never silently dropped.
 *
 * @param {object} payload
 * @returns {Array<{ callId: string, name: string, arguments: Record<string, unknown> }>}
 */
function extractCalls(payload) {
  if (!Array.isArray(payload?.output)) return [];
  const calls = [];
  for (const item of payload.output) {
    if (item?.type === 'function_call') {
      let args = {};
      try {
        args = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        args = { __raw_arguments: item.arguments };
      }
      calls.push({ callId: item.call_id, name: item.name, arguments: args });
    }
  }
  return calls;
}

/**
 * Reasoning items as opaque JSON strings (one per reasoning output-item).
 * The full item (id + summary + encrypted_content) is carried verbatim;
 * id-only replay 404s on the stateless flow. Empty when the request
 * doesn't ask for `include: ['reasoning.encrypted_content']`.
 *
 * @param {object} payload
 * @returns {string[]}
 */
function extractReasoning(payload) {
  if (!Array.isArray(payload?.output)) return [];
  const items = [];
  for (const item of payload.output) {
    if (item?.type === 'reasoning') items.push(JSON.stringify(item));
  }
  return items;
}

/**
 * Assistant `phase` (`commentary` | `final_answer`) from the message
 * item, or undefined when the model omits it. Never fabricated.
 *
 * @param {object} payload
 * @returns {string | undefined}
 */
function extractPhase(payload) {
  if (!Array.isArray(payload?.output)) return undefined;
  for (const item of payload.output) {
    if (item?.type === 'message' && typeof item.phase === 'string') return item.phase;
  }
  return undefined;
}

/**
 * Translate the raw Responses payload into the neutral PortResult shape.
 *
 * @param {object} payload
 * @returns {PortResult}
 */
function toPortResult(payload) {
  return {
    text: extractText(payload),
    calls: extractCalls(payload),
    reasoning: extractReasoning(payload),
    phase: extractPhase(payload),
    stopReason: undefined,
    usage: payload?.usage ?? {},
    id: payload?.id,
  };
}

/**
 * Perform one OpenAI Responses request and return the neutral PortResult on
 * success, or the neutral transport-error shape on an expected fetch failure
 * (non-2xx, AbortError, fetch-level TypeError).
 *
 * @param {{ apiKey: string, baseUrl: string, body: object }} args
 * @returns {Promise<PortResult | { kind: 'error', stage: 'transport', retryable: boolean, status?: number, message: string, stopReason: string }>}
 */
export async function complete({ apiKey, baseUrl, body }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    try {
      response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Fetch-level failure (network TypeError, AbortError, ByteString header).
      return {
        kind: 'error',
        stage: 'transport',
        retryable: isRetryableApiError(err),
        message: err?.message || String(err),
        stopReason: 'error',
      };
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const status = response.status;
      const message = payload?.error?.message || `OpenAI request failed (${status})`;
      // Synthesize a status-tagged error for the shared classifier (so 429/5xx
      // are retryable; 4xx isn't).
      const classifier = new Error(message);
      classifier.status = status;
      return {
        kind: 'error',
        stage: 'transport',
        retryable: isRetryableApiError(classifier),
        status,
        message,
        stopReason: 'error',
      };
    }
    return toPortResult(payload);
  } finally {
    clearTimeout(timeoutId);
  }
}
