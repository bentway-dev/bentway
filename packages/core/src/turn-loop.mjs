// The turn loop: drive a session of completion requests to a terminal stop
// and emit a neutral event log along the way. The loop is provider- and
// format-neutral; every provider- or host-specific behavior enters via the
// injected `ctx` (see `runTurnLoop` below). The `emitter` ctx field is a
// sink consuming neutral events from `./events.mjs`; the host wires a
// renderer (e.g. `@bentway/stream-json`'s `streamJsonSink`) to project
// those events to a concrete wire format.
//
// What the loop does each turn:
//   1. emit `api_call_start`
//   2. invoke the injected `complete()` port (with retry/backoff on retryable
//      transport errors)
//   3. emit `api_call_end` and `turn_tokens`
//   4. record the assistant turn into the owned Transcript
//   5. consult host policy hooks; on a terminal decision emit a `result` event
//      and return an exit code (0 = clean stop, 1 = abort/fatal)
//   6. otherwise execute any tool calls, append their outputs to the
//      Transcript, and loop
//
// What the loop never does:
//   - import provider fetch code (the port owns that)
//   - assemble request bodies (the host's `serializeRequest` owns that)
//   - parse provider-native completion shapes (the port returns the neutral
//     PortResult — `{ text, calls, reasoning, phase, stopReason, usage,
//     id?, textChunks? }` — and the loop reads those fields directly)
//   - own prompt or intervention text (those live in host policy hooks)
//
// Imports only @bentway/core/*. The loop emits neutral events (see
// ./events.mjs) to the injected `emitter`; rendering to any wire format
// (stream-json, etc.) lives in a host-wired sink.

import * as events from './events.mjs';
import { accumulateUsage } from './usage.mjs';
import { executeFunctionCall } from './tool-exec.mjs';
import * as transcript from './transcript.mjs';

/**
 * Resumable session state at a turn boundary — pure data, JSON-round-trippable.
 *
 * Emitted by `ctx.onTurnComplete` at the bottom of each productive turn and
 * passed back via `ctx.initialState` to resume a loop in a fresh process.
 *
 * Captured at the clean boundary AFTER the assistant + tool_result messages
 * for the just-completed turn have been appended to the Transcript and
 * `numTurns` / `totalUsage` / counters reflect that turn — so a checkpoint
 * means "completed N turns; next turn is N+1." Restoring `totalUsage` keeps
 * a host's cost kill-switch cumulative across the resume boundary; restoring
 * `numTurns` keeps the turn-limit honest (no fresh budget on resume).
 * `previousResponseId` is restored best-effort — provider-side response
 * chaining is process-local, so a stale/absent id degrades to whatever
 * fallback the host's `serializeRequest` does (typically full transcript
 * re-serialization); the loop never errors on it.
 *
 * @typedef {object} Checkpoint
 * @property {{ messages: Array<object> }} transcript      The neutral Transcript.
 * @property {string} [previousResponseId]                  Provider response-chaining id (e.g. OpenAI Responses).
 * @property {number} numTurns                              Turns completed before the checkpoint.
 * @property {Record<string, number>} totalUsage            Cumulative token usage.
 * @property {string} lastText                              Last assistant text seen (max_turns result fallback).
 * @property {number} toolCallCount                         Cumulative tool_use count.
 * @property {number} mcpToolCallCount                      Cumulative MCP tool_use count.
 * @property {number} toolResultCount                       Cumulative tool_result count.
 * @property {boolean} bareBailIntervened                   Bare-bail one-shot flag.
 * @property {number} noToolCallStreak                      No-tool-call streak counter.
 */

/**
 * Drive the turn loop to a terminal stop and return the session exit code.
 *
 * Returns 0 on a clean terminal (end_turn / max_turns) and 1 on a fatal or
 * aborting terminal (API error / tool loop). All provider- and host-specific
 * behavior is injected via `ctx`; see the destructured fields below.
 */
export async function runTurnLoop(ctx) {
  const {
    // Session config + immutable inputs.
    model,
    prompt,
    runtimeTools,
    emitter,
    // Stamped into every emitted `result` event; also forwarded to the WIP-
    // preservation hook. `resultEventExtras` carries provider-shaped knobs
    // accepted by `events.result(…)` ({ costSemantics?, toolCapability?,
    // requestedModel? }); spread into each call so the loop owns no
    // provider-specific literals. Defaults to `{}`.
    provider,
    resultEventExtras = {},
    effectiveMaxTurns,
    systemPromptBytes,
    mcpServerCount,
    mcpServerBreakdown,
    toolLoopState,
    // Retry tuning (host-supplied; the loop carries no constants of its own).
    MAX_API_RETRIES,
    RETRY_BASE_DELAY_MS,
    // Provider completion port. Resolves to a neutral PortResult on success
    // and to `{ kind:'error', stage:'transport'|'completion', retryable, ... }`
    // on expected failures. Unexpected throws (port bugs) propagate to the
    // outer catch.
    complete: createResponse,
    // Request-shape seam. Given the per-turn inputs (`shadowTranscript`,
    // `input`, `previousResponseId`) returns exactly what `complete()`
    // consumes — typically `{ apiKey, baseUrl, body }`. The loop never
    // assembles a provider body.
    serializeRequest,
    // Fatal-API terminal parametrization. All default to a generic shape so
    // a host that omits them gets sensible output.
    //   - fatalApiResultText({ err, maxRetries, attempts }) — the result text
    //     after retries exhaust. Default: `API error after ${maxRetries}
    //     retries: <message>`.
    //   - fatalApiPreserveTrigger — truthy → invoke `preserveDirtyWorkToIsolatedRef`
    //     with this trigger string. Falsy → skip preservation. Default: 'api_error'.
    //   - maxTurnsResultText() — result text on the max-turns terminal.
    //     Default: `lastText || result.text || ''`.
    //   - maxTurnsSubtype — subtype on the max-turns terminal. Default: 'info'
    //     (a turn-capped session is informational, not an error).
    fatalApiResultText,
    fatalApiPreserveTrigger = 'api_error',
    maxTurnsResultText,
    maxTurnsSubtype = 'info',
    // Host callbacks: cost computation + policy hooks + WIP preservation.
    computeTotalCostUsd,
    maybeBuildBareBailIntervention,
    maybeBuildEditTestFailIntervention,
    recordBashTestFailures,
    maybeBuildTestFailureLoopResult,
    maybeBuildNoProgressToolLoopResult,
    // No-tool-call policy seam. Consulted when `calls.length === 0` to decide
    // whether a text-only turn should nudge-and-continue or terminate.
    // Omitted hook → fall through to the end_turn terminal.
    //
    // Decision interface:
    //   { kind: 'nudge', nextStreak: number, input, shadowBlocks?: Block[] }
    //     → set the streak counter; re-request with `input`.
    //   { kind: 'terminate', resultText, stopReason, subtype, exitCode }
    //     → emit the terminal result and return `exitCode`.
    //   falsy → fall through to the end_turn terminal.
    maybeBuildNoToolCallResult,
    // Provider loop-flow seams. Each is typeof-guarded at its call site so an
    // omitted hook is a literal no-op. Per-seam state (retry counters,
    // one-shot flags) lives in the host's injected closure; the loop carries
    // none of it.
    //
    //   maybeBuildBadCompletionRetry({ payload, numTurns })
    //     Consulted post-increment but BEFORE usage accounting + turn_tokens
    //     (a malformed `retry`/`continue` must skip both). Returns:
    //       { kind:'retry', input, shadowBlocks }     — dual-append + re-request
    //       { kind:'fatal', resultText, stopReason,
    //          subtype, exitCode,
    //          preserveTrigger?, preserveCommitSubject? } — emit terminal + return
    //       falsy                                       — fall through
    //
    //   emitProviderTextStream({ payload, emitter })
    //     Pre-`turn_tokens` streamed-text replay (e.g. for providers that
    //     emit text in chunks before the final completion event).
    //
    //   maybeBuildToolErrorResult({ call, message })
    //     Consulted inside the tool-exec catch after the error is recorded.
    //     Returns a terminal `{ resultText, stopReason, subtype, exitCode }`
    //     or falsy to record-and-continue.
    //
    //   observePostToolExec({ calls, outputs, numTurns })
    //     Consulted after the batched tool-result Transcript append. Returns
    //     `{ input?, shadowBlocks? }` to dual-append; the loop falls through
    //     to its guards (no continue).
    //
    //   emitProviderText({ payload, emitter, text })
    //     Replaces the loop's single text emit when the provider needs
    //     incremental emission. Omitted → the loop emits
    //     `events.assistantText({ text, usage: payload.usage })`.
    //
    //   maybeBuildPreToolIntervention(calls, toolLoopState)
    //     Pre-tool-execution policy seam. Consulted BEFORE executing any
    //     tool call this turn (after the existing edit-test-fail guard).
    //     Returns a string intervention message to block execution (same
    //     shape as maybeBuildEditTestFailIntervention), or falsy to proceed.
    //     Used by the host to inject additional pre-execution gates (e.g.
    //     TDD phase enforcement) without overloading existing hooks.
    maybeBuildPreToolIntervention,
    //
    //   recordPostToolExec(calls, outputs, toolLoopState)
    //     Post-tool-execution recording seam. Called after
    //     recordBashTestFailures. Mutates toolLoopState in place; no return
    //     value consumed. Used by the host to inject additional post-exec
    //     observers (e.g. TDD phase state tracking) without wrapping
    //     recordBashTestFailures.
    recordPostToolExec,
    maybeBuildBadCompletionRetry,
    // Pre-numTurns++ request-failed terminal seam. Consulted after
    // `api_call_end` but BEFORE incrementing `numTurns`, so the emitted
    // result's `num_turns` is PRE-increment. Returns
    // `{ resultText, stopReason, subtype, exitCode, preserveTrigger?,
    //   preserveCommitSubject? }` or falsy. Omitted hook → unified fatal path
    // handles transport errors.
    maybeBuildRequestFailedResult,
    emitProviderTextStream,
    maybeBuildToolErrorResult,
    observePostToolExec,
    emitProviderText,
    // Diagnostics parametrization.
    //   recordToolInvocation(toolHist, name, durationMs)
    //     Mutates the tool histogram. Omitted → plain-number count.
    //   diagnosticsExtras()
    //     Returns extra `session_diagnostics` fields spread between
    //     `max_tool_latency_ms` and `stuck_loop_trips`. Omitted → none.
    recordToolInvocation,
    diagnosticsExtras,
    preserveDirtyWorkToIsolatedRef,
    // Optional observation seam. Invoked with the final Transcript when the
    // loop exits (any terminal path). Used by tests; no-op in production.
    onShadowTranscript,
    // ── Checkpoint / resume seams ─────────────────────────────────────────
    // `initialState` (typeof Checkpoint or omitted) — when present, seed the
    // loop's resumable state from it instead of building fresh from `prompt`.
    // The seeded `transcript` replaces the initial user-prompt message; the
    // restored counters (`numTurns`, `totalUsage`, `toolCallCount` etc.) keep
    // turn-budget and cost-kill-switch decisions cumulative across the resume
    // boundary. `previousResponseId` is restored best-effort — stale/absent
    // is not an error (the host's `serializeRequest` falls back to whatever
    // re-serialization shape it prefers).
    //
    // `onTurnComplete?(checkpoint)` — invoked at the bottom of each
    // productive turn iteration (the clean boundary — Transcript consistent,
    // assistant + tool_result messages appended for this turn). Passes the
    // full Checkpoint; the host owns persistence cadence and storage.
    initialState,
    /** @type {((c: Checkpoint) => void) | undefined} */
    onTurnComplete,
  } = ctx;

  let previousResponseId;
  let input = prompt;
  // Owned Transcript. Fresh: seeded with the initial user prompt. Resumed:
  // restored from `initialState.transcript` — the seeded shape replaces the
  // first user message (which is already inside the seeded transcript). Built
  // in parallel with each turn; never read to drive the request (the host's
  // `serializeRequest` chooses whether to consume it).
  let shadowTranscript;
  let numTurns;
  let totalUsage;
  let lastDurationMs = 0;
  let lastText;
  let toolCallCount;
  let mcpToolCallCount;
  let toolResultCount;
  let bareBailIntervened;
  // Cross-turn counter used only by the no-tool-call policy seam.
  let noToolCallStreak;
  if (initialState) {
    shadowTranscript = initialState.transcript;
    previousResponseId = initialState.previousResponseId;
    numTurns = initialState.numTurns ?? 0;
    totalUsage = initialState.totalUsage ?? {};
    lastText = initialState.lastText ?? '';
    toolCallCount = initialState.toolCallCount ?? 0;
    mcpToolCallCount = initialState.mcpToolCallCount ?? 0;
    toolResultCount = initialState.toolResultCount ?? 0;
    bareBailIntervened = initialState.bareBailIntervened ?? false;
    noToolCallStreak = initialState.noToolCallStreak ?? 0;
  } else {
    shadowTranscript = transcript.appendMessage(
      transcript.createTranscript(),
      transcript.message('user', [transcript.text(prompt)]),
    );
    numTurns = 0;
    totalUsage = {};
    lastText = '';
    toolCallCount = 0;
    mcpToolCallCount = 0;
    toolResultCount = 0;
    bareBailIntervened = false;
    noToolCallStreak = 0;
  }

  const _diag = { toolHist: {}, maxToolMs: 0, loops: 0, done: false };
  function emitDiag(stopReason) {
    if (_diag.done) return;
    _diag.done = true;
    emitter(events.sessionDiagnostics({
      totalTurns: numTurns,
      totalTokens: (totalUsage.input_tokens || 0) + (totalUsage.output_tokens || 0),
      inputTokens: totalUsage.input_tokens || 0,
      outputTokens: totalUsage.output_tokens || 0,
      toolHistogram: _diag.toolHist,
      maxToolLatencyMs: _diag.maxToolMs,
      // Extras carry diagnosticsExtras()'s output verbatim; the sink spreads
      // them between max_tool_latency_ms and stuck_loop_trips for byte-stable
      // session_diagnostics field order.
      extras: typeof diagnosticsExtras === 'function' ? diagnosticsExtras() : undefined,
      stuckLoopTrips: _diag.loops,
      stopReason,
      durationApiMs: lastDurationMs,
    }));
  }

  try {
  while (true) {
    const startedAt = Date.now();

    // Emit api_call_start so a watching executor sees activity even during
    // long reasoning turns (otherwise an idle-timeout could trip).
    emitter(events.apiCallStart({ turn: numTurns + 1 }));

    let result;
    // fatalAttempts: attempt count at exhaustion, fed to fatalApiResultText.
    // unexpectedThrow: a truly unexpected throw (port bug) — expected
    // transport failures resolve to the neutral error shape and flow through
    // the early handler below.
    let fatalAttempts = 0;
    let unexpectedThrow;
    try {
      // Retry loop. The port resolves to a neutral
      // `{ kind:'error', stage:'transport', retryable, ... }` on expected
      // failures, so the retry decision keys off `retryable` without an
      // inner try/catch.
      for (let attempt = 0; ; attempt++) {
        result = await createResponse(serializeRequest({
          shadowTranscript,
          input,
          previousResponseId,
        }));
        // Retryable transport error with budget remaining → back off + redo.
        if (
          result?.kind === 'error'
          && result.stage === 'transport'
          && result.retryable
          && attempt < MAX_API_RETRIES
        ) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(4, attempt);
          emitter(events.apiRetry({
            attempt: attempt + 1,
            maxRetries: MAX_API_RETRIES,
            delayMs: delay,
            error: result.message || 'api error',
          }));
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        fatalAttempts = attempt + 1;
        break;
      }
    } catch (err) {
      // Unexpected throw — no retry; the unified fatal below emits the terminal.
      unexpectedThrow = err;
      fatalAttempts = 1;
    }

    // EARLY error terminal (pre-numTurns++) — transport-stage failures + the
    // unexpected-throw safety net. `num_turns` is pre-increment; `durationApiMs`
    // is `lastDurationMs + (Date.now() - startedAt)` (includes the partial turn).
    if (unexpectedThrow || (result?.kind === 'error' && result.stage === 'transport')) {
      // api_call_end fires only when the port got an HTTP response back
      // (signalled by the `requestFailed` flag). Fetch-level throws and
      // unexpected throws skip it.
      if (!unexpectedThrow && result?.requestFailed) {
        emitter(events.apiCallEnd({ turn: numTurns + 1, durationMs: Date.now() - startedAt }));
      }
      // Optional host hook to claim the transport error before the unified
      // fatal path runs. Reads `payload.kind === 'error' && payload.requestFailed`.
      if (!unexpectedThrow && typeof maybeBuildRequestFailedResult === 'function') {
        const requestFailed = maybeBuildRequestFailedResult({ payload: result });
        if (requestFailed) {
          const totalCostUsd = computeTotalCostUsd(model, totalUsage);
          emitDiag(requestFailed.stopReason);
          emitter(events.result({
            model,
            provider,
            ...resultEventExtras,
            usage: totalUsage,
            totalCostUsd,
            durationApiMs: lastDurationMs + (Date.now() - startedAt),
            numTurns,
            resultText: requestFailed.resultText,
            stopReason: requestFailed.stopReason,
            subtype: requestFailed.subtype,
            systemPromptBytes,
            mcpServerCount,
            mcpServerBreakdown,
            toolCallCount,
            mcpToolCallCount,
            toolResultCount,
          }));
          if (requestFailed.preserveTrigger) {
            await preserveDirtyWorkToIsolatedRef({
              commitSubject: requestFailed.preserveCommitSubject ?? 'WIP: runtime preservation',
              trigger: requestFailed.preserveTrigger,
              provider,
              emitEvent: emitter,
            });
          }
          return requestFailed.exitCode;
        }
      }

      // Unified fatal terminal — retries exhausted, non-retryable transport
      // errors no host hook claimed, and unexpected throws. Wrap the neutral
      // error's message into an Error so a host hook reading `err.message`
      // works unchanged.
      const errRef = unexpectedThrow ?? new Error(result.message || 'api error');
      const stopReasonForResult = unexpectedThrow ? 'error' : (result.stopReason || 'error');
      const totalCostUsd = computeTotalCostUsd(model, totalUsage);
      emitDiag(stopReasonForResult);
      emitter(events.result({
        model,
        provider,
        ...resultEventExtras,
        usage: totalUsage,
        totalCostUsd,
        durationApiMs: lastDurationMs + (Date.now() - startedAt),
        numTurns,
        resultText: typeof fatalApiResultText === 'function'
          ? fatalApiResultText({ err: errRef, maxRetries: MAX_API_RETRIES, attempts: fatalAttempts })
          : `API error after ${MAX_API_RETRIES} retries: ${errRef.message || String(errRef)}`,
        stopReason: stopReasonForResult,
        subtype: 'error',
        systemPromptBytes,
        mcpServerCount,
        mcpServerBreakdown,
        toolCallCount,
        mcpToolCallCount,
        toolResultCount,
      }));
      // Preserve only when a trigger is set. The default ('api_error')
      // preserves; a host can pass null to suppress preservation.
      if (fatalApiPreserveTrigger) {
        await preserveDirtyWorkToIsolatedRef({
          commitSubject: 'WIP: api error — runtime preservation',
          trigger: fatalApiPreserveTrigger,
          provider,
          emitEvent: emitter,
        });
      }
      return 1;
    }

    emitter(events.apiCallEnd({ turn: numTurns + 1, durationMs: Date.now() - startedAt }));

    previousResponseId = result.id;
    numTurns += 1;

    // Replay any provider streamed-text chunks here — after the increment,
    // before usage accounting + turn_tokens — so streamed text lands before
    // turn_tokens in the emit stream.
    if (typeof emitProviderTextStream === 'function') {
      emitProviderTextStream({ payload: result, emitter });
    }

    // Max-turns terminal. Checked post-increment but BEFORE the bad-completion
    // seam AND before usage accounting + turn_tokens, so a max turn that also
    // carried a malformed completion still terminates as max_turns. The result
    // text and subtype are parametrized (see ctx fields).
    if (effectiveMaxTurns && numTurns >= effectiveMaxTurns) {
      const totalCostUsd = computeTotalCostUsd(model, totalUsage);
      emitDiag('max_turns');
      emitter(events.result({
        model,
        provider,
        ...resultEventExtras,
        usage: totalUsage,
        totalCostUsd,
        durationApiMs: lastDurationMs,
        numTurns,
        resultText: typeof maxTurnsResultText === 'function'
          ? maxTurnsResultText()
          : (lastText || result.text || ''),
        stopReason: 'max_turns',
        subtype: maxTurnsSubtype,
        systemPromptBytes,
        mcpServerCount,
        mcpServerBreakdown,
        toolCallCount,
        mcpToolCallCount,
        toolResultCount,
      }));
      return 0;
    }

    // Bad-completion seam: a provider may report a malformed or rejected
    // completion (e.g. a malformed tool-call shape). Consulted post-increment
    // but BEFORE usage accounting + turn_tokens, so a 'retry'/'continue'
    // skips both accumulateUsage and turn_tokens for the malformed turn.
    // `numTurns` (post-increment) is passed so the hook can emit its own
    // retry telemetry with the right turn number.
    if (typeof maybeBuildBadCompletionRetry === 'function') {
      const badCompletion = maybeBuildBadCompletionRetry({ payload: result, numTurns });
      if (badCompletion && badCompletion.kind === 'retry') {
        input = badCompletion.input;
        if (badCompletion.shadowBlocks && badCompletion.shadowBlocks.length > 0) {
          shadowTranscript = transcript.appendMessage(
            shadowTranscript,
            transcript.message('user', badCompletion.shadowBlocks),
          );
        }
        continue;
      }
      if (badCompletion && badCompletion.kind === 'fatal') {
        const totalCostUsd = computeTotalCostUsd(model, totalUsage);
        emitDiag(badCompletion.stopReason);
        emitter(events.result({
          model,
          provider,
          ...resultEventExtras,
          usage: totalUsage,
          totalCostUsd,
          durationApiMs: lastDurationMs,
          numTurns,
          resultText: badCompletion.resultText,
          stopReason: badCompletion.stopReason,
          subtype: badCompletion.subtype,
          systemPromptBytes,
          mcpServerCount,
          mcpServerBreakdown,
          toolCallCount,
          mcpToolCallCount,
          toolResultCount,
        }));
        // Preserve dirty work on fatal bad-completion paths when a trigger
        // is set.
        if (badCompletion.preserveTrigger) {
          await preserveDirtyWorkToIsolatedRef({
            commitSubject: badCompletion.preserveCommitSubject ?? 'WIP: runtime preservation',
            trigger: badCompletion.preserveTrigger,
            provider,
            emitEvent: emitter,
          });
        }
        return badCompletion.exitCode;
      }
      // falsy decision → fall through unchanged.
    }

    totalUsage = accumulateUsage(totalUsage, result.usage);
    lastDurationMs += Date.now() - startedAt;

    emitter(events.turnTokens({
      turn: numTurns,
      promptTokens: result.usage?.input_tokens || 0,
      completionTokens: result.usage?.output_tokens || 0,
      cumulativeTokens: (totalUsage.input_tokens || 0) + (totalUsage.output_tokens || 0),
    }));

    // Text emission. `lastText` tracking is provider-neutral; the emission
    // itself is injectable. Omitted → emit a single assistantText event here.
    const text = result.text;
    if (text) lastText = text;
    if (typeof emitProviderText === 'function') {
      emitProviderText({ payload: result, emitter, text });
    } else if (text) {
      emitter(events.assistantText({ text, usage: result.usage }));
    }

    const calls = result.calls;

    // Record this assistant turn into the owned Transcript. Block order:
    // reasoning items immediately before the assistant message they belong
    // to, then the tool_use calls (whose outputs land in the next user
    // message). Reasoning payloads are opaque JSON strings the loop never
    // interprets.
    {
      const assistantBlocks = [];
      for (const reasoningPayload of result.reasoning) {
        assistantBlocks.push(transcript.reasoning(provider, reasoningPayload));
      }
      // `phase` is attached only when the provider carried it — never
      // fabricated.
      if (text) assistantBlocks.push(transcript.text(text, result.phase));
      for (const call of calls) {
        assistantBlocks.push(transcript.toolUse(call.callId, call.name, call.arguments));
      }
      if (assistantBlocks.length > 0) {
        shadowTranscript = transcript.appendMessage(
          shadowTranscript,
          transcript.message('assistant', assistantBlocks),
        );
      }
    }

    // Bare-bail intervention: an injected policy hook decides whether the
    // model falsely bailed and, if so, returns the corrective `input` to
    // re-request with. Detection and corrective prompt text live host-side;
    // the loop only applies the result.
    const bareBail = maybeBuildBareBailIntervention({
      text,
      prompt,
      calls,
      alreadyIntervened: bareBailIntervened,
    });
    if (bareBail) {
      bareBailIntervened = true;
      input = bareBail.input;
      // Mirror the corrective delta into the Transcript. The hook returns
      // either function_call_output items (tool-result replacements) or a
      // bare { role:'user', content } message; map each to its block type.
      shadowTranscript = transcript.appendMessage(
        shadowTranscript,
        transcript.message(
          'user',
          bareBail.input.map((item) =>
            item.type === 'function_call_output'
              ? transcript.toolResult(item.call_id, item.output)
              : transcript.text(item.content),
          ),
        ),
      );
      continue;
    }

    if (calls.length === 0) {
      // No-tool-call policy seam. An injected hook may decide a text-only
      // turn should nudge-and-continue or terminate. Omitted → fall through
      // to the end_turn terminal below.
      if (typeof maybeBuildNoToolCallResult === 'function') {
        // `payload` is passed so a hook can read completion fields the loop
        // doesn't surface (e.g. a provider-specific done reason).
        const decision = maybeBuildNoToolCallResult({ text: lastText, streak: noToolCallStreak, payload: result });
        if (decision && decision.kind === 'nudge') {
          noToolCallStreak = decision.nextStreak;
          input = decision.input;
          // Optional Transcript dual-append so the nudge's user message
          // reaches the next request.
          if (decision.shadowBlocks && decision.shadowBlocks.length > 0) {
            shadowTranscript = transcript.appendMessage(
              shadowTranscript,
              transcript.message('user', decision.shadowBlocks),
            );
          }
          continue;
        }
        if (decision && decision.kind === 'terminate') {
          const totalCostUsd = computeTotalCostUsd(model, totalUsage);
          emitDiag(decision.stopReason);
          emitter(events.result({
            model,
            provider,
            ...resultEventExtras,
            usage: totalUsage,
            totalCostUsd,
            durationApiMs: lastDurationMs,
            numTurns,
            resultText: decision.resultText,
            stopReason: decision.stopReason,
            subtype: decision.subtype,
            systemPromptBytes,
            mcpServerCount,
            mcpServerBreakdown,
            toolCallCount,
            mcpToolCallCount,
            toolResultCount,
          }));
          return decision.exitCode;
        }
        // falsy decision → fall through to the end_turn terminal below.
      }
      const totalCostUsd = computeTotalCostUsd(model, totalUsage);
      emitDiag('end_turn');
      emitter(events.result({
        model,
        provider,
        ...resultEventExtras,
        usage: totalUsage,
        totalCostUsd,
        durationApiMs: lastDurationMs,
        numTurns,
        resultText: lastText,
        systemPromptBytes,
        mcpServerCount,
        mcpServerBreakdown,
        toolCallCount,
        mcpToolCallCount,
        toolResultCount,
      }));
      return 0;
    }

    // Productive turn (calls.length > 0): reset the no-tool-call streak.
    noToolCallStreak = 0;

    // Tool-loop guard: an injected policy may pre-empt tool execution and
    // return an intervention output to use for every call this turn. If so,
    // the loop emits no tool_use / tool_result events for those calls — the
    // intervention text is fed back as the tool output and the loop continues.
    const intervention = maybeBuildEditTestFailIntervention(calls, toolLoopState);
    if (intervention) {
      input = calls.map((call) => ({
        type: 'function_call_output',
        call_id: call.callId,
        output: intervention,
      }));
      shadowTranscript = transcript.appendMessage(
        shadowTranscript,
        transcript.message(
          'user',
          calls.map((call) => transcript.toolResult(call.callId, intervention)),
        ),
      );
      continue;
    }

    // Pre-tool-execution policy seam: an optional host-injected gate that
    // runs after the edit-test-fail guard. Same blocking shape — returns a
    // string intervention to short-circuit all tool calls, or falsy to
    // proceed. typeof-guarded so omitting the hook is a no-op.
    if (typeof maybeBuildPreToolIntervention === 'function') {
      const preToolIntervention = maybeBuildPreToolIntervention(calls, toolLoopState);
      if (preToolIntervention) {
        input = calls.map((call) => ({
          type: 'function_call_output',
          call_id: call.callId,
          output: preToolIntervention,
        }));
        shadowTranscript = transcript.appendMessage(
          shadowTranscript,
          transcript.message(
            'user',
            calls.map((call) => transcript.toolResult(call.callId, preToolIntervention)),
          ),
        );
        continue;
      }
    }

    const outputs = [];
    const shadowToolResults = []; // tool_result blocks for the Transcript
    let allToolResultsErrored = true;
    let usageEmittedThisTurn = !!text;
    for (const call of calls) {
      toolCallCount += 1;
      if (typeof call.name === 'string' && call.name.startsWith('mcp__')) mcpToolCallCount += 1;
      emitter(events.assistantToolUse({ call, usage: usageEmittedThisTurn ? undefined : result.usage }));
      usageEmittedThisTurn = true;
      const _t0 = Date.now();
      try {
        const output = await executeFunctionCall(call, runtimeTools.executors);
        const _dt = Date.now() - _t0;
        const serialized = typeof output === 'string' ? output : JSON.stringify(output);
        toolResultCount += 1;
        emitter(events.toolResult({ callId: call.callId, output }));
        emitter(events.toolLatency({ tool: call.name, durationMs: _dt, outputBytes: serialized.length }));
        if (typeof recordToolInvocation === 'function') {
          recordToolInvocation(_diag.toolHist, call.name, _dt);
        } else {
          _diag.toolHist[call.name] = (_diag.toolHist[call.name] || 0) + 1;
        }
        if (_dt > _diag.maxToolMs) _diag.maxToolMs = _dt;
        allToolResultsErrored = false;
        outputs.push({
          type: 'function_call_output',
          call_id: call.callId,
          output: serialized,
        });
        shadowToolResults.push(transcript.toolResult(call.callId, serialized));
      } catch (error) {
        const _dt = Date.now() - _t0;
        const message = error instanceof Error ? error.message : String(error);
        toolResultCount += 1;
        emitter(events.toolResult({ callId: call.callId, output: message, isError: true }));
        emitter(events.toolLatency({ tool: call.name, durationMs: _dt, outputBytes: message.length, isError: true }));
        if (typeof recordToolInvocation === 'function') {
          recordToolInvocation(_diag.toolHist, call.name, _dt);
        } else {
          _diag.toolHist[call.name] = (_diag.toolHist[call.name] || 0) + 1;
        }
        if (_dt > _diag.maxToolMs) _diag.maxToolMs = _dt;
        outputs.push({
          type: 'function_call_output',
          call_id: call.callId,
          output: message,
        });
        shadowToolResults.push(transcript.toolResult(call.callId, message, { isError: true }));
        // Tool-error policy seam: after the error is recorded, an injected
        // hook may declare this failing call terminal. Omitted → record-and-
        // continue.
        if (typeof maybeBuildToolErrorResult === 'function') {
          const toolErrorResult = maybeBuildToolErrorResult({ call, message });
          if (toolErrorResult) {
            const totalCostUsd = computeTotalCostUsd(model, totalUsage);
            emitDiag(toolErrorResult.stopReason);
            emitter(events.result({
              model,
              provider,
              ...resultEventExtras,
              usage: totalUsage,
              totalCostUsd,
              durationApiMs: lastDurationMs,
              numTurns,
              resultText: toolErrorResult.resultText,
              stopReason: toolErrorResult.stopReason,
              subtype: toolErrorResult.subtype,
              systemPromptBytes,
              mcpServerCount,
              mcpServerBreakdown,
              toolCallCount,
              mcpToolCallCount,
              toolResultCount,
            }));
            return toolErrorResult.exitCode;
          }
        }
      }
    }

    // Batched tool results for this turn become one user message in the
    // Transcript (the canonical batching shape).
    shadowTranscript = transcript.appendMessage(
      shadowTranscript,
      transcript.message('user', shadowToolResults),
    );

    // Post-tool-exec observer: after the batched tool-result user message
    // is appended, an injected observer may append warning user message(s).
    // It returns `{ input?, shadowBlocks? }`; `input` defers the
    // unconditional `input = outputs` assignment at the end of this loop
    // body so it isn't clobbered, and `shadowBlocks` append immediately.
    let postToolObserverInput = null;
    if (typeof observePostToolExec === 'function') {
      const observation = observePostToolExec({ calls, outputs, numTurns });
      if (observation) {
        if (observation.input) postToolObserverInput = observation.input;
        if (observation.shadowBlocks && observation.shadowBlocks.length > 0) {
          shadowTranscript = transcript.appendMessage(
            shadowTranscript,
            transcript.message('user', observation.shadowBlocks),
          );
        }
      }
    }

    // Tool-loop guard, post-execution: track Bash command success/failure.
    recordBashTestFailures(calls, outputs, toolLoopState);

    // Post-tool-execution recording seam: an optional host-injected observer
    // called after recordBashTestFailures. Mutates toolLoopState; no return
    // value consumed. typeof-guarded so omitting the hook is a no-op.
    if (typeof recordPostToolExec === 'function') {
      recordPostToolExec(calls, outputs, toolLoopState);
    }

    // Terminal: if interventions are exhausted and a command hits threshold
    // again, the model is unresponsive — exit with tool_loop.
    const testFailureLoopResult = maybeBuildTestFailureLoopResult(calls, toolLoopState);
    if (testFailureLoopResult) {
      const totalCostUsd = computeTotalCostUsd(model, totalUsage);
      _diag.loops += 1;
      emitDiag('tool_loop');
      emitter(events.result({
        model,
        provider,
        ...resultEventExtras,
        usage: totalUsage,
        totalCostUsd,
        durationApiMs: lastDurationMs,
        numTurns,
        resultText: testFailureLoopResult,
        stopReason: 'tool_loop',
        subtype: 'error',
        systemPromptBytes,
        mcpServerCount,
        mcpServerBreakdown,
        toolCallCount,
        mcpToolCallCount,
        toolResultCount,
      }));
      return 1;
    }

    const noProgressLoopResult = maybeBuildNoProgressToolLoopResult({
      calls,
      text,
      allToolResultsErrored,
      state: toolLoopState,
    });
    if (noProgressLoopResult) {
      const totalCostUsd = computeTotalCostUsd(model, totalUsage);
      _diag.loops += 1;
      emitDiag('tool_loop');
      emitter(events.result({
        model,
        provider,
        ...resultEventExtras,
        usage: totalUsage,
        totalCostUsd,
        durationApiMs: lastDurationMs,
        numTurns,
        resultText: noProgressLoopResult,
        stopReason: 'tool_loop',
        subtype: 'error',
        systemPromptBytes,
        mcpServerCount,
        mcpServerBreakdown,
        toolCallCount,
        mcpToolCallCount,
        toolResultCount,
      }));
      return 1;
    }

    // Next-turn input: the tool outputs, plus any post-tool observer delta.
    input = postToolObserverInput ?? outputs;

    // Turn-boundary checkpoint seam. The clean boundary: assistant turn +
    // tool_result user message are both appended to the Transcript, counters
    // and cumulative usage reflect this turn, and no tool call is pending.
    // Fires only on productive turns (calls.length > 0); terminal paths
    // (end_turn / max_turns / fatal) emit their own `result` and return
    // before reaching here. No-op when the hook is absent.
    if (typeof onTurnComplete === 'function') {
      onTurnComplete({
        transcript: shadowTranscript,
        previousResponseId,
        numTurns,
        totalUsage,
        lastText,
        toolCallCount,
        mcpToolCallCount,
        toolResultCount,
        bareBailIntervened,
        noToolCallStreak,
      });
    }
  }
  } finally {
    // Hand the final Transcript to the optional observer on every exit
    // path. No-op when unset.
    if (typeof onShadowTranscript === 'function') onShadowTranscript(shadowTranscript);
  }
}
