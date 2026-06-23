// Neutral event vocabulary emitted by the turn loop.
//
// Tagged-union factories. Each event carries only what the loop knows in
// semantic camelCase fields. No wire-shape concerns — no `type`/`subtype`
// discriminators, no snake_case rename, no field-order contract. Rendering
// (to stream-json or any other wire format) is a separate concern that
// lives in the sink (see @bentway/stream-json's `streamJsonSink`).
//
// The `tag` discriminator is what the sink switches on. The `events` module
// is the kernel's public event vocabulary; an external adopter can drive
// the loop and write their own sink against these tags.

export const apiCallStart = ({ turn }) =>
  ({ tag: 'apiCallStart', turn });

export const apiCallEnd = ({ turn, durationMs }) =>
  ({ tag: 'apiCallEnd', turn, durationMs });

export const apiRetry = ({ attempt, maxRetries, delayMs, error }) =>
  ({ tag: 'apiRetry', attempt, maxRetries, delayMs, error });

export const turnTokens = ({ turn, promptTokens, completionTokens, cumulativeTokens }) =>
  ({ tag: 'turnTokens', turn, promptTokens, completionTokens, cumulativeTokens });

export const assistantText = ({ text, usage, stopReason }) =>
  ({ tag: 'assistantText', text, usage, stopReason });

export const assistantToolUse = ({ call, usage }) =>
  ({ tag: 'assistantToolUse', call, usage });

export const toolResult = ({ callId, output, isError }) =>
  ({ tag: 'toolResult', callId, output, isError });

// `extras` carries provider-shaped diagnosticsExtras() output verbatim;
// the sink spreads it between max_tool_latency_ms and stuck_loop_trips
// for byte-stable session_diagnostics field order.
export const toolLatency = ({ tool, durationMs, outputBytes, isError }) =>
  ({ tag: 'toolLatency', tool, durationMs, outputBytes, isError });

export const sessionDiagnostics = ({
  totalTurns,
  totalTokens,
  inputTokens,
  outputTokens,
  toolHistogram,
  maxToolLatencyMs,
  extras,
  stuckLoopTrips,
  stopReason,
  durationApiMs,
}) => ({
  tag: 'sessionDiagnostics',
  totalTurns,
  totalTokens,
  inputTokens,
  outputTokens,
  toolHistogram,
  maxToolLatencyMs,
  extras,
  stuckLoopTrips,
  stopReason,
  durationApiMs,
});

export const result = (fields) =>
  ({ tag: 'result', ...fields });

/**
 * Host-custom passthrough event. Carries an opaque `subtype` plus arbitrary
 * fields; a sink renders it however that format represents a custom/system
 * event (the stream-json sink renders it to `{ type: 'system', subtype,
 * ...fields }`). Use this for host- or consumer-specific events that are not
 * part of the typed kernel vocabulary.
 *
 * @param {{ subtype: string } & Record<string, unknown>} arg
 * @returns {{ tag: 'customEvent', subtype: string, fields: Record<string, unknown> }}
 */
export const customEvent = ({ subtype, ...fields }) =>
  ({ tag: 'customEvent', subtype, fields });
