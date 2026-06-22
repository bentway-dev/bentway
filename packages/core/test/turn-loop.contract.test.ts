// Contract tests for src/turn-loop.mjs — drives the REAL loop through its
// terminals via the mock-port harness, asserting on emitted events + exit code.
// Covers terminals reachable WITHOUT the productive tool-exec path (deferred to
// slice 2: max_turns + the two tool_loop terminals + tool-exec).
import { describe, it, expect } from 'vitest';
import { makeScriptedLoop, executorsFor, transcript } from '../../../test/_harness.js';

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: Block[] };

describe('turn-loop contract — terminals', () => {
  it('end_turn: text-only turn with no tools → exit 0, stop_reason end_turn, result = lastText', async () => {
    const { run, capture } = makeScriptedLoop([{ text: 'all done', calls: [] }]);
    const exit = await run();

    expect(exit).toBe(0);
    const result = capture.resultEvent();
    expect(result).toMatchObject({
      type: 'result',
      stop_reason: 'end_turn',
      subtype: 'success',
      result: 'all done',
      provider: 'openai',
      num_turns: 1,
    });
    // Exactly one terminal result event; diag emitted with end_turn.
    expect(capture.resultEvents()).toHaveLength(1);
    expect(capture.diagEvent()).toMatchObject({ subtype: 'session_diagnostics', stop_reason: 'end_turn' });
  });

  describe('fatal-API (retries exhausted / non-retryable throw)', () => {
    it('non-retryable: throws once → exit 1, stop_reason error, preserve fires (default trigger)', async () => {
      const harness = makeScriptedLoop(
        [{ throw: { status: 400, message: 'bad request' } }],
        { isRetryableApiError: () => false },
      );
      const exit = await harness.run();

      expect(exit).toBe(1);
      expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'error', subtype: 'error', num_turns: 0 });
      // Default fatalApiResultText: "API error after N retries: <msg>".
      expect(harness.capture.resultEvent()!.result).toContain('API error after 2 retries');
      // openai default fatalApiPreserveTrigger = 'api_error' → preserve fires.
      expect(harness.preserveCalls).toHaveLength(1);
      expect(harness.preserveCalls[0]).toMatchObject({ trigger: 'api_error', provider: 'openai' });
      // Port was hit exactly once (non-retryable → no retries).
      expect(harness.port.completeCallCount).toBe(1);
    });

    it('retryable: exhausts MAX_API_RETRIES → exit 1, port hit MAX+1 times', async () => {
      const harness = makeScriptedLoop(
        [{ throw: { status: 503 } }, { throw: { status: 503 } }, { throw: { status: 503 } }],
        { isRetryableApiError: () => true, MAX_API_RETRIES: 2, RETRY_BASE_DELAY_MS: 0 },
      );
      const exit = await harness.run();

      expect(exit).toBe(1);
      expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'error', subtype: 'error' });
      expect(harness.port.completeCallCount).toBe(3); // attempts 0,1,2 (MAX_API_RETRIES=2)
      // api_retry emitted for the two backoffs before the final rethrow.
      expect(harness.capture.events().filter((e) => e.subtype === 'api_retry')).toHaveLength(2);
    });

    it('no preserve when fatalApiPreserveTrigger is falsy', async () => {
      const harness = makeScriptedLoop(
        [{ throw: { status: 400 } }],
        { isRetryableApiError: () => false, fatalApiPreserveTrigger: null },
      );
      expect(await harness.run()).toBe(1);
      expect(harness.preserveCalls).toHaveLength(0);
    });

    // ── Neutral transport-error coverage ──────────────────────────────────
    // The port resolves to `{ kind:'error', stage:'transport', retryable, ... }`
    // rather than throwing. These cases exercise the early-error route the
    // loop takes when that shape arrives.

    it('transport retryable: 3 errors then success → exit 0, exactly 3 api_retry events', async () => {
      const harness = makeScriptedLoop(
        [
          { error: { stage: 'transport', retryable: true, status: 503, message: 'svc unavailable' } },
          { error: { stage: 'transport', retryable: true, status: 503, message: 'svc unavailable' } },
          { error: { stage: 'transport', retryable: true, status: 503, message: 'svc unavailable' } },
          { text: 'recovered', calls: [] },
        ],
        { MAX_API_RETRIES: 3, RETRY_BASE_DELAY_MS: 0 },
      );
      const exit = await harness.run();

      expect(exit).toBe(0);
      expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'end_turn', result: 'recovered' });
      expect(harness.port.completeCallCount).toBe(4);
      const retries = harness.capture.events().filter((e) => e.subtype === 'api_retry');
      expect(retries).toHaveLength(3);
      // Each api_retry carries the matching attempt number (1, 2, 3) and the err message.
      expect(retries.map((e) => e.attempt)).toEqual([1, 2, 3]);
      expect(retries[0]).toMatchObject({ maxRetries: 3, error: 'svc unavailable' });
    });

    it('transport retryable exhausted: MAX_API_RETRIES errors → fatal, exit 1, fatalAttempts=MAX+1', async () => {
      const harness = makeScriptedLoop(
        [
          { error: { stage: 'transport', retryable: true, status: 500, message: 'svc 500' } },
          { error: { stage: 'transport', retryable: true, status: 500, message: 'svc 500' } },
          { error: { stage: 'transport', retryable: true, status: 500, message: 'svc 500' } },
        ],
        {
          MAX_API_RETRIES: 2,
          RETRY_BASE_DELAY_MS: 0,
          // Capture the attempts arg fed to fatalApiResultText to assert
          // fatalAttempts == MAX_API_RETRIES + 1 (3) at the unified-fatal site.
          fatalApiResultText: ({ err, maxRetries, attempts }: { err: Error; maxRetries: number; attempts: number }) =>
            `failed after ${attempts}/${maxRetries + 1} attempts (${err.message})`,
        },
      );
      const exit = await harness.run();

      expect(exit).toBe(1);
      expect(harness.port.completeCallCount).toBe(3);
      expect(harness.capture.events().filter((e) => e.subtype === 'api_retry')).toHaveLength(2);
      expect(harness.capture.resultEvent()).toMatchObject({
        stop_reason: 'error',
        subtype: 'error',
        num_turns: 0, // PRE-increment at the EARLY fatal handler
        result: 'failed after 3/3 attempts (svc 500)',
      });
    });

    it('transport non-retryable: 1 error → immediate fatal, no api_retry, exit 1', async () => {
      const harness = makeScriptedLoop(
        [{ error: { stage: 'transport', retryable: false, status: 400, message: 'bad request' } }],
        { MAX_API_RETRIES: 3, RETRY_BASE_DELAY_MS: 0 },
      );
      const exit = await harness.run();

      expect(exit).toBe(1);
      expect(harness.port.completeCallCount).toBe(1);
      expect(harness.capture.events().filter((e) => e.subtype === 'api_retry')).toHaveLength(0);
      expect(harness.capture.resultEvent()).toMatchObject({
        stop_reason: 'error',
        subtype: 'error',
        num_turns: 0,
      });
      expect(harness.capture.resultEvent()!.result).toContain('bad request');
    });

    it('transport non-retryable: NO api_call_end emitted (matches connection-fail golden)', async () => {
      const harness = makeScriptedLoop(
        [{ error: { stage: 'transport', retryable: false, message: 'ECONNREFUSED' } }],
        { MAX_API_RETRIES: 2, RETRY_BASE_DELAY_MS: 0 },
      );
      await harness.run();
      // Fetch-level transport errors (no requestFailed flag) skip api_call_end:
      // the loop never saw HTTP response headers, so it can't emit a turn-end
      // event for a turn that never connected.
      expect(harness.capture.events().filter((e) => e.subtype === 'api_call_end')).toHaveLength(0);
      // api_call_start still fires (the loop emitted it before the request).
      expect(harness.capture.events().filter((e) => e.subtype === 'api_call_start')).toHaveLength(1);
    });
  });

  it('requestFailed: ok:false payload + injected hook → its exit/stop, num_turns PRE-increment, preserve iff trigger', async () => {
    const harness = makeScriptedLoop(
      [{ okFalse: { requestFailed: true, message: 'boom' } }],
      {
        maybeBuildRequestFailedResult: () => ({
          resultText: 'request failed',
          stopReason: 'chat_request_failed',
          subtype: 'error',
          exitCode: 1,
          preserveTrigger: 'chat_request_failed',
          preserveCommitSubject: 'WIP: ctx budget',
        }),
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(1);
    expect(harness.capture.resultEvent()).toMatchObject({
      stop_reason: 'chat_request_failed',
      subtype: 'error',
      result: 'request failed',
      num_turns: 0, // PRE-increment: the seam fires before numTurns += 1
    });
    expect(harness.preserveCalls).toHaveLength(1);
    expect(harness.preserveCalls[0]).toMatchObject({ trigger: 'chat_request_failed', commitSubject: 'WIP: ctx budget' });
  });

  it('badCompletion fatal: injected hook → kind:fatal → its exit/stop, num_turns POST-increment, no preserve', async () => {
    const harness = makeScriptedLoop(
      [{ text: '', calls: [] }],
      {
        maybeBuildBadCompletionRetry: () => ({
          kind: 'fatal',
          resultText: 'stream error',
          stopReason: 'malformed_tool_call',
          subtype: 'error',
          exitCode: 1,
        }),
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(1);
    expect(harness.capture.resultEvent()).toMatchObject({
      stop_reason: 'malformed_tool_call',
      subtype: 'error',
      result: 'stream error',
      num_turns: 1, // POST-increment: the #1 seam fires after numTurns += 1
    });
    expect(harness.preserveCalls).toHaveLength(0);
  });

  it('no-tool-call terminate: calls=[] + injected hook → kind:terminate → its exit/stop', async () => {
    const harness = makeScriptedLoop(
      [{ text: 'SESSION_RESULT: COMPLETED', calls: [] }],
      {
        maybeBuildNoToolCallResult: ({ text }: { text: string }) => ({
          kind: 'terminate',
          resultText: text,
          stopReason: 'end_turn',
          subtype: 'success',
          exitCode: 0,
        }),
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
    expect(harness.capture.resultEvent()).toMatchObject({
      stop_reason: 'end_turn',
      subtype: 'success',
      result: 'SESSION_RESULT: COMPLETED',
      num_turns: 1,
    });
  });
});

describe('turn-loop contract — continue behaviors (loop then terminate)', () => {
  it('badCompletion kind:retry on turn 1, then end_turn on turn 2', async () => {
    let calls = 0;
    const harness = makeScriptedLoop(
      [{ text: '', calls: [], id: 'r1' }, { text: 'done', calls: [], id: 'r2' }],
      {
        maybeBuildBadCompletionRetry: () => {
          calls += 1;
          return calls === 1
            ? { kind: 'retry', input: [], shadowBlocks: [transcript.text('correction')] }
            : undefined;
        },
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
    // Looped past the retry: exactly one (end_turn) result, at turn 2.
    expect(harness.capture.resultEvents()).toHaveLength(1);
    expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'end_turn', result: 'done', num_turns: 2 });
    expect(harness.port.completeCallCount).toBe(2);
  });

  it('no-tool-call kind:nudge on turn 1 (shadowBlocks appended), then end_turn on turn 2', async () => {
    let calls = 0;
    const NUDGE = 'you called no tools — act now';
    const harness = makeScriptedLoop(
      [{ text: 'thinking...', calls: [] }, { text: 'done', calls: [] }],
      {
        maybeBuildNoToolCallResult: () => {
          calls += 1;
          return calls === 1
            ? { kind: 'nudge', nextStreak: 1, input: [], shadowBlocks: [transcript.text(NUDGE)] }
            : undefined;
        },
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
    expect(harness.capture.resultEvents()).toHaveLength(1);
    expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'end_turn', result: 'done', num_turns: 2 });

    // The nudge's shadowBlocks were appended as a user message to the shadow.
    const shadow = harness.finalShadow();
    const userTexts = (shadow?.messages ?? [])
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text);
    expect(userTexts).toContain(NUDGE);
  });
});

describe('turn-loop contract — productive tool-exec path', () => {
  it('productive tool-turn → end_turn: executor runs, result batched into shadow, events emitted, num_turns 2', async () => {
    let calledWith: unknown;
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: { command: 'ls' } }] },
        { text: 'done', calls: [] },
      ],
      { runtimeTools: executorsFor({ Bash: (args) => { calledWith = args; return 'file1\nfile2'; } }) },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
    expect(calledWith).toEqual({ command: 'ls' }); // executor got the call's arguments
    expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'end_turn', result: 'done', num_turns: 2 });

    // Per-call emits: assistantToolUseEvent + toolResultEvent + tool_latency.
    const ev = harness.capture.events();
    const toolUse = ev.find((e) => e.type === 'assistant' && (e.message as { content?: Block[] })?.content?.[0]?.type === 'tool_use');
    expect(toolUse).toMatchObject({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' } });
    expect(ev.find((e) => e.type === 'user' && (e.message as { content?: Block[] })?.content?.[0]?.type === 'tool_result'))
      .toMatchObject({ message: { content: [{ type: 'tool_result', tool_use_id: 'c1' }] } });
    expect(ev.filter((e) => e.subtype === 'tool_latency')).toHaveLength(1);

    // Tool result appended to the shadow as ONE batched user message (:800-803).
    const shadow = harness.finalShadow()!;
    const toolResultMsgs = (shadow.messages as Msg[]).filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'));
    expect(toolResultMsgs).toHaveLength(1);
    expect(toolResultMsgs[0].content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'file1\nfile2' }]);
  });

  it('max_turns: effectiveMaxTurns productive turns → exit 0, stop_reason max_turns, subtype info, result = lastText', async () => {
    const harness = makeScriptedLoop(
      [
        { text: 'working', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] }, // turn 1: tool call → continue
        { text: 'irrelevant', calls: [{ callId: 'c2', name: 'Bash', arguments: {} }] }, // turn 2: max_turns fires before processing
      ],
      { effectiveMaxTurns: 2, runtimeTools: executorsFor({ Bash: () => 'ok' }) },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
    expect(harness.capture.resultEvent()).toMatchObject({
      stop_reason: 'max_turns',
      subtype: 'info', // maxTurnsSubtype default (L13: was 'success'; flipped to 'info' for provider-uniform semantics)
      result: 'working', // lastText (from turn 1); maxTurnsResultText absent
      num_turns: 2,
    });
    expect(harness.capture.diagEvent()).toMatchObject({ stop_reason: 'max_turns' });
  });

  it('tool_loop (test-failure): injected hook returns a string on a tool-turn → exit 1, tool_loop / error', async () => {
    const harness = makeScriptedLoop(
      [{ text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] }],
      {
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
        maybeBuildTestFailureLoopResult: () => 'repeated failing command — unresponsive',
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(1);
    expect(harness.capture.resultEvent()).toMatchObject({
      stop_reason: 'tool_loop',
      subtype: 'error',
      result: 'repeated failing command — unresponsive',
      num_turns: 1,
    });
  });

  it('tool_loop (no-progress): injected hook returns a string on a tool-turn → exit 1, tool_loop / error', async () => {
    const harness = makeScriptedLoop(
      [{ text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] }],
      {
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
        maybeBuildNoProgressToolLoopResult: () => 'no forward progress',
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(1);
    expect(harness.capture.resultEvent()).toMatchObject({
      stop_reason: 'tool_loop',
      subtype: 'error',
      result: 'no forward progress',
    });
  });

  it('tool-error sub-path: a throwing executor records the error into the shadow result; loop continues to end_turn', async () => {
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: { command: 'boom' } }] },
        { text: 'recovered', calls: [] },
      ],
      // No maybeBuildToolErrorResult → record-and-continue (not a terminal).
      { runtimeTools: executorsFor({ Bash: () => { throw new Error('exec failed'); } }) },
    );
    const exit = await harness.run();

    expect(exit).toBe(0); // continued past the error to turn 2
    expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'end_turn', result: 'recovered', num_turns: 2 });

    // The error message — not a normal output — is what landed in the shadow tool_result.
    const shadow = harness.finalShadow()!;
    const toolResultBlock = (shadow.messages as Msg[])
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.tool_use_id === 'c1');
    expect(toolResultBlock).toMatchObject({ content: 'exec failed', is_error: true });

    // The emitted tool_result event carried the is_error flag.
    const errResult = harness.capture.events().find((e) => e.type === 'user' && (e.message as { content?: Block[] })?.content?.[0]?.is_error === true);
    expect(errResult).toBeDefined();
  });

  it('observePostToolExec: called with {calls,outputs,numTurns} after the batched append; shadowBlocks appended; input → turn 2 request', async () => {
    const SENTINEL_INPUT = [{ type: 'function_call_output', call_id: 'c1', output: 'observed' }];
    const WARNING = 'OBSERVER_WARNING';
    let observerArgs: { calls?: unknown[]; outputs?: unknown[]; numTurns?: number } | undefined;
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'out' }),
        observePostToolExec: (args: { calls: unknown[]; outputs: unknown[]; numTurns: number }) => {
          observerArgs = args;
          return { shadowBlocks: [transcript.text(WARNING)], input: SENTINEL_INPUT };
        },
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
    // Called with the productive-turn triple; numTurns is post-increment (1).
    expect(observerArgs?.numTurns).toBe(1);
    expect(observerArgs?.calls).toMatchObject([{ callId: 'c1', name: 'Bash' }]);
    expect(observerArgs?.outputs).toEqual([{ type: 'function_call_output', call_id: 'c1', output: 'out' }]);

    // Its shadowBlocks were appended AFTER the batched tool-result user message.
    const shadow = harness.finalShadow()!;
    const userMsgs = (shadow.messages as Msg[]).filter((m) => m.role === 'user');
    const trIdx = userMsgs.findIndex((m) => m.content.some((b) => b.type === 'tool_result'));
    const warnIdx = userMsgs.findIndex((m) => m.content.some((b) => b.type === 'text' && b.text === WARNING));
    expect(trIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThan(trIdx);

    // Its `input` became turn 2's request input (postToolObserverInput ?? outputs → :901 → :279).
    expect(harness.requestInputs[1]).toBe(SENTINEL_INPUT);
  });

  it('maybeBuildEditTestFailIntervention: truthy on turn 1 short-circuits tool-exec (executor never runs), then end_turn', async () => {
    let executorRan = false;
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: { command: 'flaky' } }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => { executorRan = true; return 'should not run'; } }),
        maybeBuildEditTestFailIntervention: () => 'STOP: repeated edit→test→fail',
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
    expect(executorRan).toBe(false); // short-circuits before the tool-exec loop (:688 → continue)
    expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'end_turn', result: 'done', num_turns: 2 });

    // The synthetic intervention was appended to the shadow as a tool_result, and
    // became turn 2's request input as function_call_output deltas.
    const shadow = harness.finalShadow()!;
    const trBlock = (shadow.messages as Msg[]).flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.tool_use_id === 'c1');
    expect(trBlock).toMatchObject({ content: 'STOP: repeated edit→test→fail' });
    expect(harness.requestInputs[1]).toEqual([{ type: 'function_call_output', call_id: 'c1', output: 'STOP: repeated edit→test→fail' }]);
  });
});
