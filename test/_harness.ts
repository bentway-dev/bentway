// Test harness for driving `runTurnLoop` with zero wire I/O.
//
// `runTurnLoop` is a reducer over its injected ctx. Every provider port's
// `complete()` resolves to the neutral PortResult shape — `{ text, calls,
// reasoning, phase, stopReason, usage, id?, textChunks? }` — and the loop
// reads those fields directly. So the harness scripts per-turn outcomes
// by returning that neutral shape verbatim, with no provider wire format
// involved.
//
// Tests assert on emitted events (via a capturing emitter) and the loop's
// numeric return (the exit code).
//
// The loop emits neutral events (see @bentway/core/events); the host wires
// a sink. The harness wires the REAL @bentway/stream-json `streamJsonSink`
// so the captured bytes the goldens compare are production bytes.

import { runTurnLoop } from '@bentway/core/turn-loop';
import * as transcript from '@bentway/core/transcript';
import { streamJsonSink } from '@bentway/stream-json';

export { transcript };

// ── Scripted completion ────────────────────────────────────────────────────
// One step per provider request. A step is either a success result (the neutral
// PortResult shape returned verbatim), a neutral-error result (the neutral
// `{kind:'error', stage, retryable, ...}` shape — what the ports now resolve to
// on transport / completion failures), or a `throw` (an UNEXPECTED throw — port
// bug; still propagates to the loop's catch fatal path). The legacy `okFalse`
// step is kept as a thin alias that materializes the neutral error shape with
// stage='transport', retryable=false (the equivalent of ollama's former
// `{ok:false, requestFailed}`), so existing tests for the seam B / seam C hooks
// continue to drive the same hook bodies.

export type SuccessStep = {
  text?: string;
  calls?: Array<{ callId: string; name: string; arguments: Record<string, unknown> }>;
  reasoning?: string[];
  phase?: string;
  stopReason?: string;
  usage?: Record<string, number>;
  id?: string;
  textChunks?: string[];
};
export type ErrorStep = {
  error: {
    stage: 'transport' | 'completion';
    retryable?: boolean;
    status?: number;
    message?: string;
    stopReason?: string;
    requestFailed?: boolean;
    textChunks?: string[];
  };
};
export type ThrowStep = { throw: { status?: number; message?: string } };
export type OkFalseStep = { okFalse: Record<string, unknown> };
export type Step = SuccessStep | ErrorStep | ThrowStep | OkFalseStep;

type Payload = Record<string, unknown>;

function neutralSuccess(step: SuccessStep, turn: number): Payload {
  return {
    text: step.text ?? '',
    calls: step.calls ?? [],
    reasoning: step.reasoning ?? [],
    phase: step.phase,
    stopReason: step.stopReason,
    usage: step.usage ?? {},
    id: step.id ?? `resp_${turn}`,
    ...(step.textChunks !== undefined ? { textChunks: step.textChunks } : {}),
  };
}

function neutralError(spec: ErrorStep['error']): Payload {
  return {
    kind: 'error',
    stage: spec.stage,
    retryable: spec.retryable ?? false,
    message: spec.message ?? 'scripted error',
    stopReason: spec.stopReason ?? (spec.stage === 'transport' ? 'error' : 'stream_error'),
    ...(spec.status !== undefined ? { status: spec.status } : {}),
    ...(spec.requestFailed !== undefined ? { requestFailed: spec.requestFailed } : {}),
    ...(spec.textChunks !== undefined ? { textChunks: spec.textChunks } : {}),
  };
}

/**
 * Build a `complete` stub from a per-turn script. Steps are consumed in order;
 * running past the end throws (a test bug, not a loop terminal).
 */
export function scriptedPort(script: Step[]) {
  let turn = 0;
  const completeCalls: number[] = [];

  const complete = async (_args: unknown): Promise<Payload> => {
    const step = script[turn];
    completeCalls.push(turn);
    turn += 1;
    if (!step) throw new Error(`scriptedPort: ran out of steps at turn ${turn}`);
    if ('throw' in step) {
      // Translation for back-compat: the harness's legacy `throw` step used to
      // drive the loop's old try/catch fatal. Since the error-normalize the port
      // returns the neutral transport-error shape instead. Translate to the
      // neutral shape so existing tests still exercise the EARLY transport-error
      // path. The status is preserved so the retryable flag (set per-test via
      // `isRetryableApiError` override OR scripted as `error: { retryable }`)
      // matches the original intent.
      // Tests that override `isRetryableApiError: () => false/true` can set
      // retryable here via that override path — but the loop no longer reads it
      // from ctx, so a test that wants retryable must scriptedly mark the step
      // as such. Default: derive from status (status === 503 → retryable; else
      // false). This matches every existing test's intent.
      const status = step.throw.status;
      const retryable = status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
      return {
        kind: 'error',
        stage: 'transport',
        retryable,
        message: step.throw.message ?? 'scripted api error',
        stopReason: 'error',
        ...(status !== undefined ? { status } : {}),
      };
    }
    if ('error' in step) {
      return neutralError(step.error);
    }
    if ('okFalse' in step) {
      // Legacy okFalse → translate to neutral error shape. requestFailed flag
      // is preserved so seam B (maybeBuildRequestFailedResult) keys off it the
      // same way; stopReason and message are passed through.
      const spec = step.okFalse;
      return {
        kind: 'error',
        stage: 'transport',
        retryable: false,
        message: (spec.message as string) ?? 'scripted okFalse',
        stopReason: (spec.stopReason as string) ?? 'chat_request_failed',
        ...(spec.requestFailed !== undefined ? { requestFailed: spec.requestFailed } : {}),
      };
    }
    return neutralSuccess(step, turn);
  };

  return { complete, get completeCallCount() { return completeCalls.length; } };
}

// ── Event capture ──────────────────────────────────────────────────────────

export type CapturedEvent = Record<string, unknown>;
export type NeutralEvent = { tag: string; [k: string]: unknown };

export function makeCapture() {
  const lines: string[] = [];
  const neutral: NeutralEvent[] = [];
  // Tap neutral events as they pass through, then render to bytes via the
  // REAL stream-json sink so goldens compare production wire bytes.
  const lineCollector = (line: string) => { lines.push(line); };
  const render = streamJsonSink(lineCollector);
  const emitter = (event: NeutralEvent) => {
    neutral.push(event);
    render(event);
  };
  const events = (): CapturedEvent[] => lines.map((l) => JSON.parse(l) as CapturedEvent);
  return {
    emitter,
    raw: () => lines.join(''),
    events,
    neutralEvents: () => neutral,
    resultEvents: () => events().filter((e) => e.type === 'result'),
    resultEvent: () => events().find((e) => e.type === 'result'),
    diagEvent: () => events().find((e) => e.subtype === 'session_diagnostics'),
  };
}

// ── Loop ctx ────────────────────────────────────────────────────────────────
// Faithful minimal defaults for every REQUIRED (unconditionally-called) ctx
// field; the typeof-guarded provider-flow seams are LEFT ABSENT (no-op) and a
// test injects only the ones it drives. See src/turn-loop.mjs:60-205.

export type LoopOverrides = Record<string, unknown>;

/** Build a runtimeTools.executors Map from a `{ name: handler }` record. */
export function executorsFor(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  return { tools: [] as unknown[], executors: new Map(Object.entries(handlers)) };
}

export function makeLoopCtx(overrides: LoopOverrides = {}) {
  const capture = makeCapture();
  const preserveCalls: Array<Record<string, unknown>> = [];
  const shadowSnapshots: unknown[] = [];
  // The `input` arg handed to serializeRequest each turn (the next-turn
  // request delta). Lets a test assert what reached turn N's request —
  // e.g. that `observePostToolExec`'s `input` became turn 2's request input.
  const requestInputs: unknown[] = [];

  const ctx: Record<string, unknown> = {
    // Per-session config + immutable inputs.
    model: 'test-model',
    prompt: 'do the task',
    runtimeTools: { tools: [], executors: new Map() },
    emitter: capture.emitter,
    provider: 'openai',
    resultEventExtras: {},
    effectiveMaxTurns: undefined,
    systemPromptBytes: 0,
    mcpServerCount: 0,
    mcpServerBreakdown: [],
    toolLoopState: {},
    MAX_API_RETRIES: 2,
    RETRY_BASE_DELAY_MS: 0, // no real sleeps in retry tests

    // Port + request seam. serializeRequest is mock-trivial — the scripted
    // `complete` ignores its output (no real wire body is built) — but it records
    // the per-turn `input` for request-input assertions. The default `complete`
    // returns a minimal neutral PortResult (empty text, no calls / reasoning, no
    // usage) so a test that doesn't override it doesn't crash on field reads.
    complete: async () => ({ text: '', calls: [], reasoning: [], usage: {} }),
    serializeRequest: (args: { input?: unknown }) => { requestInputs.push(args?.input); return args; },

    // Cost is host-injected. Default 0 so the test doesn't need to wire pricing.
    computeTotalCostUsd: () => 0,

    // Policy hooks — all falsy/no-op (no intervention) by default. These are
    // called UNCONDITIONALLY (not typeof-guarded), so they must exist.
    maybeBuildBareBailIntervention: () => undefined,
    maybeBuildEditTestFailIntervention: () => undefined,
    recordBashTestFailures: () => {},
    maybeBuildTestFailureLoopResult: () => undefined,
    maybeBuildNoProgressToolLoopResult: () => undefined,

    // WIP preservation — record-only spy.
    preserveDirtyWorkToIsolatedRef: async (args: Record<string, unknown>) => {
      preserveCalls.push(args);
    },
    // Final-shadow observer — capture for shadow assertions.
    onShadowTranscript: (t: unknown) => { shadowSnapshots.push(t); },

    // NOTE: the typeof-guarded provider-flow seams (maybeBuildRequestFailedResult,
    // maybeBuildBadCompletionRetry, maybeBuildNoToolCallResult, emitProviderText,
    // emitProviderTextStream, maybeBuildToolErrorResult, observePostToolExec,
    // recordToolInvocation, diagnosticsExtras) are deliberately ABSENT here — they
    // no-op when omitted; a test injects only what it drives.

    ...overrides,
  };

  return {
    ctx,
    capture,
    preserveCalls,
    requestInputs,
    run: () => runTurnLoop(ctx) as Promise<number>,
    finalShadow: () => shadowSnapshots[shadowSnapshots.length - 1] as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> } | undefined,
  };
}

/** Compose makeLoopCtx with a scripted port in one call. */
export function makeScriptedLoop(script: Step[], overrides: LoopOverrides = {}) {
  const port = scriptedPort(script);
  const harness = makeLoopCtx({
    complete: port.complete,
    ...overrides,
  });
  return { ...harness, port };
}
