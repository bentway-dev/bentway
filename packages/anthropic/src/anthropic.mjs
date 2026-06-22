// Anthropic /v1/messages completion port. The only place in this package
// where Anthropic wire format lives. Three parts:
//
//   - accumulateAnthropicStream(events) — fold a streaming SSE event sequence
//     into the final /v1/messages message payload + textChunks. Pure; unit-
//     testable without I/O.
//   - the payload → PortResult translators (extractText, extractCalls,
//     extractReasoning, mapUsage). Also pure.
//   - complete({ apiKey, baseUrl, body }) — the /v1/messages POST + stream
//     read. Resolves to a neutral PortResult on success; on expected
//     transport failures (non-2xx, AbortError, fetch-level TypeError)
//     resolves to `{ kind:'error', stage:'transport', retryable, status?,
//     message, stopReason:'error' }` instead of throwing.
//
// Imports the global fetch (swap via a host fetch shim in tests) and the
// neutral stop-reason + retryable classifiers from @bentway/core.

import { normalizeStopReason } from '@bentway/core/normalize/stop-reason';
import { isRetryableApiError } from '@bentway/core/normalize/retryable';

/** @typedef {import('./openai.mjs').PortResult} PortResult */

// Request-level timeout (300 s). Extended-thinking turns can run long before
// the first content block; the timeout guards header acquisition only, not
// stream body consumption.
const REQUEST_TIMEOUT_MS = 300_000;

// The stable /v1/messages API version. Both extended-thinking shapes are GA
// on this version — `thinking.type.enabled` and `thinking.type.adaptive`
// (with companion `output_config.effort`). Interleaved thinking (thinking
// blocks between tool calls within one turn) needs the
// `anthropic-beta: interleaved-thinking-2025-05-14` header; a host can add
// it via `body` if needed.
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Fold an Anthropic /v1/messages SSE event sequence into the final message
 * payload. PURE — takes already-parsed event objects (the `data:` JSON of each
 * SSE line), so it is unit-testable without any stream/wire I/O.
 *
 * Event handling:
 *   message_start        → role + model + the input-side usage
 *   content_block_start  → open the block at `index`
 *                          (text | tool_use{input:{}} | thinking | redacted_thinking)
 *   content_block_delta  → text_delta (append text + record a textChunk)
 *                          | input_json_delta (append partial_json fragment)
 *                          | thinking_delta (append thinking)
 *                          | signature_delta (set signature)
 *   content_block_stop   → finalize; tool_use → JSON.parse the accumulated
 *                          partial_json into `input` (EMPTY/ABSENT → {}; the
 *                          no-arg-tool edge — NEVER JSON.parse(''))
 *   message_delta        → set stop_reason + merge the output-side usage
 *   message_stop / ping  → terminate / ignore
 *
 * @param {Iterable<{ type?: string, [k: string]: unknown }>} events
 * @returns {{ role: string, content: object[], stop_reason: string|null,
 *   usage: object, textChunks: string[] }}
 */
export function accumulateAnthropicStream(events) {
  let role = 'assistant';
  let model = '';
  let stopReason = null;
  let usage = {};
  const blocks = [];          // by content-block index
  const partialJson = [];     // by index — accumulated tool_use input_json fragments
  const textChunks = [];

  for (const event of events) {
    switch (event?.type) {
      case 'message_start': {
        const m = event.message ?? {};
        role = m.role ?? 'assistant';
        model = m.model ?? '';
        if (m.usage) usage = { ...usage, ...m.usage }; // input_tokens, cache_* counts
        break;
      }
      case 'content_block_start': {
        const idx = event.index;
        const cb = event.content_block ?? {};
        if (cb.type === 'text') {
          blocks[idx] = { type: 'text', text: cb.text ?? '' };
        } else if (cb.type === 'tool_use') {
          blocks[idx] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
          partialJson[idx] = '';
        } else if (cb.type === 'thinking') {
          blocks[idx] = { type: 'thinking', thinking: cb.thinking ?? '', signature: cb.signature ?? '' };
        } else if (cb.type === 'redacted_thinking') {
          blocks[idx] = { type: 'redacted_thinking', data: cb.data ?? '' };
        } else {
          blocks[idx] = { ...cb }; // unknown block type — carry verbatim
        }
        break;
      }
      case 'content_block_delta': {
        const idx = event.index;
        const d = event.delta ?? {};
        const block = blocks[idx];
        if (!block) break;
        if (d.type === 'text_delta') {
          const t = d.text ?? '';
          block.text += t;
          textChunks.push(t);
        } else if (d.type === 'input_json_delta') {
          partialJson[idx] = (partialJson[idx] ?? '') + (d.partial_json ?? '');
        } else if (d.type === 'thinking_delta') {
          block.thinking += d.thinking ?? '';
        } else if (d.type === 'signature_delta') {
          block.signature = d.signature ?? '';
        }
        break;
      }
      case 'content_block_stop': {
        const idx = event.index;
        const block = blocks[idx];
        if (block?.type === 'tool_use') {
          const raw = partialJson[idx];
          // EMPTY/ABSENT partial_json → no-arg tool → {} (never JSON.parse('')).
          block.input = raw ? JSON.parse(raw) : {};
        }
        break;
      }
      case 'message_delta': {
        const d = event.delta ?? {};
        if (d.stop_reason !== undefined && d.stop_reason !== null) stopReason = d.stop_reason;
        if (event.usage) usage = { ...usage, ...event.usage }; // output_tokens (final)
        break;
      }
      case 'message_stop':
      case 'ping':
      default:
        break;
    }
  }

  // Drop index holes (defensive — providers send contiguous indices) preserving order.
  const content = blocks.filter((b) => b !== undefined);
  return { role, content, model, stop_reason: stopReason, usage, textChunks };
}

/** Read an Anthropic SSE Response into the array of parsed `data:` event objects. */
async function readSseEvents(response) {
  const events = [];
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== 'function') return events;
  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return; // ignore `event:` lines (type is in the data JSON)
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr) return;
    try { events.push(JSON.parse(jsonStr)); } catch { /* skip malformed line */ }
  };
  for await (const chunk of response.body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);
  return events;
}

/** Coerce a possibly-missing/NaN numeric field to a finite number. */
function num(value) {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Concat assistant text. Anthropic uses no separator between text blocks
 * (unlike OpenAI, which joins on `\n`).
 *
 * @param {{ content?: Array<{ type?: string, text?: string }> }} payload
 * @returns {string}
 */
function extractText(payload) {
  if (!Array.isArray(payload?.content)) return '';
  const parts = [];
  for (const block of payload.content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * Tool calls. `arguments` is `block.input` as-is (already a JSON object) —
 * do NOT JSON.parse it. This deliberately differs from the OpenAI port,
 * whose `function_call.arguments` is a JSON string the port parses.
 *
 * @param {{ content?: Array<{ type?: string, id?: string, name?: string, input?: Record<string, unknown> }> }} payload
 * @returns {Array<{ callId: string, name: string, arguments: Record<string, unknown> }>}
 */
function extractCalls(payload) {
  if (!Array.isArray(payload?.content)) return [];
  const calls = [];
  for (const block of payload.content) {
    if (block?.type === 'tool_use') {
      calls.push({ callId: block.id, name: block.name, arguments: block.input ?? {} });
    }
  }
  return calls;
}

/**
 * Reasoning items as opaque JSON strings (one per thinking /
 * redacted_thinking block). The whole block — including `signature`
 * (thinking) and `data` (redacted_thinking) — is carried verbatim.
 * `serializeForAnthropic` JSON.parses it back at the front of assistant
 * content, so the signature survives the /v1/messages round-trip
 * (signed-thinking replay).
 *
 * @param {{ content?: Array<{ type?: string }> }} payload
 * @returns {string[]}
 */
function extractReasoning(payload) {
  if (!Array.isArray(payload?.content)) return [];
  const items = [];
  for (const block of payload.content) {
    if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      items.push(JSON.stringify(block));
    }
  }
  return items;
}

/**
 * Map Anthropic /v1/messages `usage` onto the OpenAI-inclusive convention
 * the stream-json projection consumes. Anthropic reports:
 *   input_tokens                — non-cached prompt tokens (excludes both cache counts)
 *   cache_read_input_tokens     — prompt tokens served from the cache (read/hit)
 *   cache_creation_input_tokens — prompt tokens written into the cache this turn
 *   output_tokens               — generated tokens (thinking folded in)
 * The projection expects `input_tokens` to be the total prompt (cache-
 * inclusive) and `input_tokens_details.{cached_tokens, cache_creation_tokens}`
 * to carry the read+write subsets, so:
 *   input_tokens (inclusive)                   = input + cache_read + cache_creation
 *   input_tokens_details.cached_tokens         = cache_read_input_tokens
 *   input_tokens_details.cache_creation_tokens = cache_creation_input_tokens
 *
 * Absent-when-zero: when both cache tiers are 0, omit `input_tokens_details`
 * entirely (don't emit `{}`). A read-only turn omits `cache_creation_tokens`;
 * a write-only turn omits `cached_tokens`.
 *
 * @param {{ input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }} [usage]
 * @returns {{ input_tokens: number, output_tokens: number, input_tokens_details?: { cached_tokens?: number, cache_creation_tokens?: number } }}
 */
function mapUsage(usage = {}) {
  const u = usage || {};
  const base = num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreation = num(u.cache_creation_input_tokens);

  const mapped = {
    input_tokens: base + cacheRead + cacheCreation,
    output_tokens: num(u.output_tokens),
  };
  if (cacheRead > 0 || cacheCreation > 0) {
    mapped.input_tokens_details = {
      ...(cacheRead > 0 ? { cached_tokens: cacheRead } : {}),
      ...(cacheCreation > 0 ? { cache_creation_tokens: cacheCreation } : {}),
    };
  }
  return mapped;
}

/**
 * Translate the accumulated Anthropic message payload into the neutral
 * PortResult. `usage` is mapped to the OpenAI-inclusive convention so the
 * stream-json projection consumes a single shape. `stopReason` is normalized
 * to the neutral enum (or surfaced as the raw wire string if the value is
 * unknown to the classifier).
 *
 * @param {ReturnType<typeof accumulateAnthropicStream>} accumulated
 * @returns {PortResult}
 */
function toPortResult(accumulated) {
  const rawStop = accumulated?.stop_reason;
  let stopReason;
  if (typeof rawStop === 'string' && rawStop.length > 0) {
    try {
      stopReason = normalizeStopReason('anthropic', rawStop);
    } catch {
      // Unknown wire stop_reason — surface the raw string so the host's
      // no-tool-call dispatcher can diagnose rather than the port crashing.
      stopReason = rawStop;
    }
  }
  return {
    text: extractText(accumulated),
    calls: extractCalls(accumulated),
    reasoning: extractReasoning(accumulated),
    phase: undefined,
    stopReason,
    usage: mapUsage(accumulated?.usage),
    textChunks: accumulated?.textChunks ?? [],
  };
}

/**
 * Perform one Anthropic /v1/messages request and return the neutral
 * PortResult on success, or the neutral transport-error shape on an
 * expected fetch failure (non-2xx, AbortError, fetch-level TypeError).
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
      response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
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

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const status = response.status;
      const message = payload?.error?.message || `Anthropic request failed (${status})`;
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

    const events = await readSseEvents(response);
    return toPortResult(accumulateAnthropicStream(events));
  } finally {
    clearTimeout(timeoutId);
  }
}
