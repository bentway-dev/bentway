// The stream-json event projection: a line-delimited JSON event log for an
// agent session. Consumers (dashboards, auditors, transcript replays) read
// this stream; the conversation's source of truth is the neutral Transcript
// in @bentway/core/transcript.
//
// This module owns: the line writer (`emit`), the assistant/user/tool/result
// event builders, the usage shape the events carry, and the sink factory
// (`streamJsonSink`) that consumes @bentway/core's neutral events and
// renders them to the line-delimited JSON wire format.
//
// Provider usage shape: events carry an OpenAI-INCLUSIVE convention
// (`input_tokens` includes cached input tokens; cache hits surface as
// `cache_read_input_tokens`). `projectUsageForStreamJson` is the boundary
// where provider-native usage maps into this shape; each port feeds it that
// way so the emitted stream is single-shape regardless of provider.
//
// Imports nothing host-specific and nothing beyond node:*. The `emit`
// helper takes its writer as a parameter; no globals.

// Cap on a single tool result's projected length. Beyond this, the result
// is truncated with a trailing "...[truncated N chars]" marker so a runaway
// tool output can't blow up the emitted stream.
const MAX_TOOL_OUTPUT_CHARS = 12_000;

function truncate(text, limit = MAX_TOOL_OUTPUT_CHARS) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

/** Format a tool result (string or structured) for the stream-json projection. */
export function summarizeToolResult(result) {
  if (!result) return '(no output)';
  if (typeof result === 'string') return truncate(result);
  return truncate(JSON.stringify(result));
}

/** Write one stream-json event line to the emitter (newline-terminated). */
export function emit(obj, emitter = process.stdout.write.bind(process.stdout)) {
  emitter(`${JSON.stringify(obj)}\n`);
}

/**
 * Project a provider usage report into the stream-json event fields:
 * { inputTokens, outputTokens, cachedInputTokens,
 *   cacheCreationInputTokens, reasoningTokens }.
 */
export function projectUsageForStreamJson(usage) {
  const inputTokens = Number.isFinite(usage?.input_tokens) ? usage.input_tokens : 0;
  const outputTokens = Number.isFinite(usage?.output_tokens) ? usage.output_tokens : 0;
  const inputDetails = usage?.input_tokens_details ?? {};
  const cachedInputTokens = Number.isFinite(inputDetails?.cached_tokens)
    ? inputDetails.cached_tokens
    : 0;
  // Cache-WRITE tier (Anthropic's cache_creation_input_tokens). Providers
  // that don't report a write tier project as 0.
  const cacheCreationInputTokens = Number.isFinite(inputDetails?.cache_creation_tokens)
    ? inputDetails.cache_creation_tokens
    : 0;
  const reasoningTokens = Number.isFinite(usage?.output_tokens_details?.reasoning_tokens)
    ? usage.output_tokens_details.reasoning_tokens
    : 0;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
  };
}

export function buildResultEvent({
  model,
  requestedModel = undefined,
  provider = 'openai',
  usage,
  totalCostUsd,
  costSemantics = 'metered',
  durationApiMs,
  numTurns,
  resultText,
  stopReason = 'end_turn',
  subtype = 'success',
  systemPromptBytes = 0,
  toolCapability = undefined,
  mcpServerCount = 0,
  mcpServerBreakdown = [],
  toolCallCount = 0,
  mcpToolCallCount = 0,
  toolResultCount = 0,
}) {
  const normalized = projectUsageForStreamJson(usage);
  const effectiveRequestedModel = requestedModel ?? (provider === 'ollama' ? undefined : model);
  const mismatchLine = effectiveRequestedModel && effectiveRequestedModel !== model
    ? `Runtime identity mismatch: requested model \`${effectiveRequestedModel}\`, used \`${model}\`.`
    : '';
  const resultWithRuntimeIdentity = [resultText, mismatchLine].filter(Boolean).join('\n');
  return {
    type: 'result',
    subtype,
    stop_reason: stopReason,
    result: resultWithRuntimeIdentity,
    ...(costSemantics === 'metered' ? { total_cost_usd: totalCostUsd ?? 0 } : {}),
    usage: {
      input_tokens: normalized.inputTokens,
      output_tokens: normalized.outputTokens,
      cache_creation_input_tokens: normalized.cacheCreationInputTokens,
      cache_read_input_tokens: normalized.cachedInputTokens,
    },
    ...(normalized.reasoningTokens > 0 ? {
      output_tokens_details: { reasoning_tokens: normalized.reasoningTokens },
    } : {}),
    provider,
    provider_used: provider,
    model_used: model,
    ...(effectiveRequestedModel ? { model_requested: effectiveRequestedModel } : {}),
    modelUsage: { [model]: { input_tokens: normalized.inputTokens, output_tokens: normalized.outputTokens } },
    ...(costSemantics === 'local_unmetered' ? { cost_semantics: costSemantics } : {}),
    duration_api_ms: durationApiMs,
    num_turns: numTurns,
    system_prompt_bytes: systemPromptBytes,
    ...(toolCapability ? { tool_capability: toolCapability } : {}),
    mcp_server_count: mcpServerCount,
    mcp_server_breakdown: mcpServerBreakdown.map((server) => ({
      server: server.server,
      tool_count: server.toolCount,
      schema_bytes: server.schemaBytes,
      schema_token_estimate: server.schemaTokenEstimate,
    })),
    tool_call_count: toolCallCount,
    mcp_tool_call_count: mcpToolCallCount,
    tool_result_count: toolResultCount,
  };
}

export function assistantToolUseEvent(call, usage) {
  const normalized = projectUsageForStreamJson(usage);
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: call.name, input: call.arguments || {} }],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: normalized.inputTokens,
        output_tokens: normalized.outputTokens,
        cache_creation_input_tokens: normalized.cacheCreationInputTokens,
        cache_read_input_tokens: normalized.cachedInputTokens,
      },
    },
  };
}

export function assistantTextEvent(text, usage, stopReason = 'end_turn') {
  const normalized = projectUsageForStreamJson(usage);
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
      usage: {
        input_tokens: normalized.inputTokens,
        output_tokens: normalized.outputTokens,
        cache_creation_input_tokens: normalized.cacheCreationInputTokens,
        cache_read_input_tokens: normalized.cachedInputTokens,
      },
    },
  };
}

export function toolResultEvent({ callId, output, isError = false }) {
  return {
    type: 'user',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: callId,
        content: summarizeToolResult(output),
        is_error: isError,
      }],
    },
  };
}

/**
 * Build a sink that consumes @bentway/core's neutral events (see
 * @bentway/core/events) and writes line-delimited stream-json bytes to
 * `writer`. The host wires this as `runTurnLoop`'s `emitter` ctx field.
 *
 * Each event tag renders to the exact bytes the loop emitted before the
 * core→stream-json inversion — same field names, same field order. The
 * @bentway/core goldens enforce this byte-identity.
 *
 * @param {(line: string) => unknown} [writer]
 */
export function streamJsonSink(writer = process.stdout.write.bind(process.stdout)) {
  return function onEvent(event) {
    switch (event.tag) {
      case 'apiCallStart':
        return emit({
          type: 'system',
          subtype: 'api_call_start',
          turn: event.turn,
        }, writer);
      case 'apiCallEnd':
        return emit({
          type: 'system',
          subtype: 'api_call_end',
          turn: event.turn,
          durationMs: event.durationMs,
        }, writer);
      case 'apiRetry':
        return emit({
          type: 'system',
          subtype: 'api_retry',
          attempt: event.attempt,
          maxRetries: event.maxRetries,
          delayMs: event.delayMs,
          error: event.error,
        }, writer);
      case 'turnTokens':
        return emit({
          type: 'system',
          subtype: 'turn_tokens',
          turn: event.turn,
          prompt_tokens: event.promptTokens,
          completion_tokens: event.completionTokens,
          cumulative_tokens: event.cumulativeTokens,
        }, writer);
      case 'toolLatency':
        return emit({
          type: 'system',
          subtype: 'tool_latency',
          tool: event.tool,
          duration_ms: event.durationMs,
          output_bytes: event.outputBytes,
          ...(event.isError ? { is_error: true } : {}),
        }, writer);
      case 'sessionDiagnostics':
        return emit({
          type: 'system',
          subtype: 'session_diagnostics',
          total_turns: event.totalTurns,
          total_tokens: event.totalTokens,
          input_tokens: event.inputTokens,
          output_tokens: event.outputTokens,
          tool_histogram: event.toolHistogram,
          max_tool_latency_ms: event.maxToolLatencyMs,
          // Extras land between max_tool_latency_ms and stuck_loop_trips so
          // the overall field order stays stable across hosts.
          ...(event.extras ?? {}),
          stuck_loop_trips: event.stuckLoopTrips,
          stop_reason: event.stopReason,
          duration_api_ms: event.durationApiMs,
        }, writer);
      case 'assistantText':
        return emit(assistantTextEvent(event.text, event.usage, event.stopReason), writer);
      case 'assistantToolUse':
        return emit(assistantToolUseEvent(event.call, event.usage), writer);
      case 'toolResult':
        return emit(toolResultEvent({
          callId: event.callId,
          output: event.output,
          isError: event.isError ?? false,
        }), writer);
      case 'result':
        return emit(buildResultEvent(event), writer);
    }
  };
}
