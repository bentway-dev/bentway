// llama.cpp / llama-server completion port. POSTs the OpenAI-compatible
// /v1/chat/completions endpoint with `stream: true`, accumulates the SSE
// stream, and resolves to the neutral PortResult on success.
//
// On failures the port resolves to the neutral error shape rather than
// throwing:
//   - non-2xx HTTP         → { kind:'error', stage:'transport',
//                              retryable:false, requestFailed:true, status,
//                              message, stopReason:'chat_request_failed' }
//                              (The turn loop's request-failed hook keys
//                              off `requestFailed`.)
//   - stream-error         → { kind:'error', stage:'completion',
//                              retryable:false, stopReason:'stream_error',
//                              message, textChunks }
//   - malformed_tool_call  → { kind:'error', stage:'completion',
//                              retryable:false, stopReason:'malformed_tool_call',
//                              message, textChunks }
//   - fetch-level failure  → { kind:'error', stage:'transport', retryable,
//                              message, stopReason:'error' }
//
// `stage` discriminates transport (no usable response — retry by resend)
// from completion (response OK but model output unusable — only the
// host's bad-completion hook can redrive). `retryable` is transport-only;
// completion errors are always non-retryable.
//
// Streaming text emission stays at the host: the port records each
// coalesced text flush into `textChunks` (preserving exact boundaries)
// and the host's `emitProviderTextStream` / `emitProviderText` hooks
// replay them. The request timeout guards header acquisition only, not
// stream consumption.
//
// Imports the global fetch and the neutral stop-reason + retryable
// classifiers from @bentway/core.

import { normalizeStopReason } from '@bentway/core/normalize/stop-reason';
import { isRetryableApiError } from '@bentway/core/normalize/retryable';

/** @typedef {import('./openai.mjs').PortResult} PortResult */

// Request-level timeout (300 s). Local llama-server cold starts and long
// prompt-eval passes are slower than hosted APIs.
const REQUEST_TIMEOUT_MS = 300_000;

// Coalescing thresholds for streaming text flushes — a flush lands once
// the time OR size threshold is hit, so very small dribbles don't spam
// the emit stream and big bursts don't sit in a buffer.
const COALESCE_TIME_MS = 500;
const COALESCE_SIZE_CHARS = 500;

function safeTrimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === 'function';
}

async function readJsonPayload(response) {
  if (typeof response?.json === 'function') {
    return response.json().catch(() => undefined);
  }
  if (typeof response?.text === 'function') {
    const text = await response.text().catch(() => '');
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function describeChatFailure(response, payload) {
  if (payload && typeof payload === 'object') {
    const errorText = safeTrimString(payload.error) || safeTrimString(payload.message);
    if (errorText) return `${response.status}: ${errorText}`;
  }
  return `${response.status}`;
}

function normalizeOpenAiToolCalls(rawChoiceDelta) {
  if (!rawChoiceDelta?.tool_calls) return { ok: true, calls: [] };
  const rawToolCalls = rawChoiceDelta.tool_calls;
  if (!Array.isArray(rawToolCalls)) {
    return {
      ok: false,
      message: 'malformed tool call: expected `tool_calls` to be an array',
    };
  }

  const calls = [];
  for (const rawCall of rawToolCalls) {
    if (!rawCall || typeof rawCall !== 'object' || Array.isArray(rawCall)) {
      return {
        ok: false,
        message: 'malformed tool call: each tool call must be an object',
      };
    }
    const fn = rawCall.function;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
      return {
        ok: false,
        message: 'malformed tool call: expected each call to include a `function` object',
      };
    }
    const name = safeTrimString(fn.name);
    if (!name) {
      return {
        ok: false,
        message: 'malformed tool call: expected `function.name` to be a non-empty string',
      };
    }
    let args;
    if (typeof fn.arguments === 'string') {
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        return {
          ok: false,
          message: `malformed tool call: expected \`function.arguments\` to be valid JSON for tool \`${name}\``,
        };
      }
    } else if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) {
      args = fn.arguments;
    } else {
      return {
        ok: false,
        message: `malformed tool call: expected \`function.arguments\` to be a JSON string or object for tool \`${name}\``,
      };
    }

    const callId = safeTrimString(rawCall.id) || `call_${rawCall.index ?? calls.length + 1}`;
    calls.push({
      callId,
      name,
      arguments: args,
      ollamaMessage: {
        id: callId,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    });
  }

  return { ok: true, calls };
}

// Neutral error-shape constructors for the two completion-side failure
// modes. The inner SSE-line parser uses a smaller `{ ok:false, stopReason,
// message }` flag; the outer accumulator translates to these neutral
// shapes at every return-to-caller site.
function streamErrorResult(message, textChunks) {
  return {
    kind: 'error',
    stage: 'completion',
    retryable: false,
    stopReason: 'stream_error',
    message,
    textChunks,
  };
}
function malformedToolCallResult(message, textChunks) {
  return {
    kind: 'error',
    stage: 'completion',
    retryable: false,
    stopReason: 'malformed_tool_call',
    message,
    textChunks,
  };
}

/**
 * Consume a streaming /v1/chat/completions response, accumulating
 * assistant text + by-index tool calls + usage, and return either the
 * neutral PortResult on success or the neutral error shape on a
 * stream/tool-call failure.
 *
 * Coalesced text flushes are recorded into `textChunks` (preserving
 * exact flush boundaries) rather than emitted — the host's text-stream
 * hook replays them.
 *
 * On the success shape: `stopReason` is the neutral value via
 * `normalizeStopReason('llama', finishReason, { hasToolCalls })` — so
 * `finish_reason='stop'` with tool calls present resolves to `'tool_use'`,
 * `'stop'` → `'end_turn'`, `'length'` → `'max_tokens'`, etc.
 *
 * On the error shape: `stopReason` carries the failure tag (`'stream_error'`
 * or `'malformed_tool_call'`) the host's bad-completion hook dispatches on.
 *
 * @param {Response} response a 2xx streaming fetch Response
 * @returns {Promise<PortResult | { kind: 'error', stage: 'completion', retryable: false, stopReason: string, message: string, textChunks: string[] }>}
 */
async function accumulateChatStream(response) {
  const textChunks = [];

  if (!isAsyncIterable(response?.body)) {
    return streamErrorResult('dropped stream: response body was missing', textChunks);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;
  let finishReason = null;
  let assistantText = '';
  let accumulatedToolCalls = [];
  let usage = {};
  let emittedTextProgress = false;
  let pendingText = '';
  let lastEmitTime = Date.now();

  function flushPendingText() {
    if (pendingText) {
      textChunks.push(pendingText);
      emittedTextProgress = true;
      pendingText = '';
      lastEmitTime = Date.now();
    }
  }

  function processSSELine(line) {
    if (line === 'data: [DONE]') {
      flushPendingText();
      sawDone = true;
      return { ok: true };
    }

    if (!line.startsWith('data: ')) return { ok: true };

    const jsonStr = line.slice(6);
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return {
        ok: false,
        stopReason: 'stream_error',
        message: `malformed SSE stream: invalid JSON chunk \`${jsonStr.slice(0, 120)}\``,
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        stopReason: 'stream_error',
        message: 'malformed SSE stream: each chunk must be a JSON object',
      };
    }

    // Extract usage from any chunk — including the separate usage-only chunk
    // that llama-server sends after the finish_reason chunk (choices: []).
    if (parsed.usage) {
      usage = {
        input_tokens: parsed.usage.prompt_tokens ?? 0,
        output_tokens: parsed.usage.completion_tokens ?? 0,
      };
    }

    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    if (!choice) return { ok: true };

    const delta = choice.delta ?? {};
    const chunkText = typeof delta.content === 'string' ? delta.content : '';
    if (chunkText) {
      assistantText += chunkText;
      if (!choice.finish_reason) {
        pendingText += chunkText;
        if (Date.now() - lastEmitTime >= COALESCE_TIME_MS || pendingText.length >= COALESCE_SIZE_CHARS) {
          flushPendingText();
        }
      }
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? accumulatedToolCalls.length;
        if (!accumulatedToolCalls[idx]) {
          accumulatedToolCalls[idx] = {
            id: tc.id || '',
            index: idx,
            type: 'function',
            function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' },
          };
        } else {
          if (tc.id) accumulatedToolCalls[idx].id = tc.id;
          if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
    }

    if (choice.finish_reason) {
      flushPendingText();
      finishReason = choice.finish_reason;
    }

    return { ok: true };
  }

  for await (const chunk of response.body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
      if (!line) continue;
      const result = processSSELine(line);
      if (!result.ok) return streamErrorResult(result.message, textChunks);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const result = processSSELine(buffer.trim());
    if (!result.ok) return streamErrorResult(result.message, textChunks);
  }
  flushPendingText();

  if (!sawDone) {
    return streamErrorResult(
      'dropped stream: response ended before a `data: [DONE]` sentinel arrived',
      textChunks,
    );
  }

  const toolCallDelta = accumulatedToolCalls.length > 0
    ? { tool_calls: accumulatedToolCalls }
    : {};
  const normalizedCalls = normalizeOpenAiToolCalls(toolCallDelta);
  if (!normalizedCalls.ok) {
    return malformedToolCallResult(normalizedCalls.message, textChunks);
  }

  // `hasToolCalls` is passed so the OpenAI-compatible caveat applies:
  // finish_reason='stop' with tool calls present resolves to 'tool_use'.
  const hasToolCalls = normalizedCalls.calls.length > 0;
  const rawFinishReason = finishReason ?? 'stop';
  let stopReason;
  try {
    stopReason = normalizeStopReason('llama', rawFinishReason, { hasToolCalls });
  } catch {
    // Unknown finish_reason — surface the raw value so the host can
    // diagnose rather than crashing the port.
    stopReason = rawFinishReason;
  }

  return {
    text: assistantText,
    calls: normalizedCalls.calls,
    reasoning: [],
    phase: undefined,
    stopReason,
    usage,
    textChunks,
    // `emittedTextProgress` lets the host's text-stream hook skip the
    // post-`turn_tokens` fallback emit when the coalesced flushes already
    // covered the assistant text.
    emittedTextProgress,
  };
}

/**
 * Perform one streaming /v1/chat/completions request and return the
 * neutral PortResult on success, or the neutral error shape on a
 * non-2xx / stream / malformed-tool-call failure.
 *
 * @param {{ host: string, model: string, messages: object[], tools: object[],
 *           temperature: number, top_p: number, presence_penalty: number }} args
 * @returns {Promise<PortResult | { kind: 'error', stage: 'transport' | 'completion', retryable: boolean, status?: number, requestFailed?: boolean, stopReason: string, message: string, textChunks?: string[] }>}
 */
export async function complete({ host, model, messages, tools, temperature, top_p, presence_penalty }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    try {
      response = await fetch(`${host.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages,
          tools,
          temperature,
          top_p,
          presence_penalty,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Fetch-level failure (ECONNREFUSED, AbortError, network TypeError).
      // `requestFailed` is intentionally NOT set so this flows through the
      // turn loop's unified transport-error path rather than the host's
      // request-failed hook.
      return {
        kind: 'error',
        stage: 'transport',
        retryable: isRetryableApiError(err),
        message: err?.message || String(err),
        stopReason: 'error',
      };
    }
  } finally {
    // The timeout guards header acquisition only, not stream consumption.
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const payload = await readJsonPayload(response);
    const message = describeChatFailure(response, payload);
    // Non-2xx surfaces as a request-failed error with `retryable: false` —
    // the host's request-failed hook owns the policy (typically a single-
    // shot terminal). Retryable transient failures arrive as fetch-level
    // throws and flow through the unified transport-error path above.
    return {
      kind: 'error',
      stage: 'transport',
      retryable: false,
      requestFailed: true,
      status: response.status,
      message,
      stopReason: 'chat_request_failed',
    };
  }

  return accumulateChatStream(response);
}
