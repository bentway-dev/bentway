// Contract tests for the turn-loop's checkpoint / resume seams:
//   ctx.initialState     — seed the resumable state instead of building fresh.
//   ctx.onTurnComplete   — fires at the bottom of each productive turn with a
//                          full Checkpoint snapshot.
//
// The triad proves the contract end-to-end:
//   1. seed     — initialState restores transcript + counters; next turn
//                 accumulates ONWARD (cost kill-switch + turn-budget honest).
//   2. round-trip — capture via onTurnComplete, seed a fresh loop, continuation
//                   is coherent (the checkpoint↔resume contract proven in-kernel).
//   3. inert    — neither field set → exactly 0.3.0 behavior (the additions are
//                 pure opt-in; the goldens cover byte-identity).
import { describe, it, expect } from 'vitest';
import type { Checkpoint } from '@bentway/core/turn-loop';
import { makeScriptedLoop, executorsFor } from '../../../test/_harness.js';

describe('turn-loop checkpoint — seed + emit + round-trip', () => {
  it('seed: initialState restores transcript + counters; next turn accumulates onward', async () => {
    // A checkpoint that LOOKS like the bottom of a productive turn: the user
    // prompt + an assistant turn (text + tool_use) + the tool_result user
    // message are all present. Counters reflect "1 turn completed."
    const seedTranscript = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'do the task' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'first turn done' },
            { type: 'tool_use', id: 'c1', name: 'Bash', input: { cmd: 'echo 1' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
      ],
    };
    const seed: Checkpoint = {
      transcript: seedTranscript,
      previousResponseId: 'resp_prior',
      numTurns: 1,
      totalUsage: { input_tokens: 100, output_tokens: 50 },
      lastText: 'first turn done',
      toolCallCount: 1,
      mcpToolCallCount: 0,
      toolResultCount: 1,
      bareBailIntervened: false,
      noToolCallStreak: 0,
    };

    // Peek at what the first request sees — the seeded transcript should reach
    // serializeRequest VERBATIM (no fresh prompt-message appended).
    let requestShadow: { messages: unknown[] } | undefined;
    let requestPreviousResponseId: string | undefined;
    const { run, capture } = makeScriptedLoop(
      // One more turn — text-only end_turn — closes the session.
      [{ text: 'second turn done', calls: [], usage: { input_tokens: 30, output_tokens: 10 } }],
      {
        initialState: seed,
        serializeRequest: (args: {
          shadowTranscript: { messages: unknown[] };
          input: unknown;
          previousResponseId?: string;
        }) => {
          requestShadow = args.shadowTranscript;
          requestPreviousResponseId = args.previousResponseId;
          return args;
        },
      },
    );
    const exit = await run();
    expect(exit).toBe(0);

    // The seeded transcript reached the first request as-is (3 messages — no
    // synthetic prompt user-message prepended/appended).
    expect(requestShadow?.messages).toHaveLength(3);
    expect(requestPreviousResponseId).toBe('resp_prior');

    // The terminal result accumulates ONWARD — not from zero. This is the
    // load-bearing property: a host's cost kill-switch stays cumulative
    // across resume, and the turn budget isn't refreshed.
    const result = capture.resultEvent();
    expect(result).toMatchObject({
      stop_reason: 'end_turn',
      num_turns: 2,                                // seeded 1 + 1 this run
      usage: { input_tokens: 130, output_tokens: 60 }, // 100+30, 50+10
      result: 'second turn done',
    });
  });

  it('round-trip: capture via onTurnComplete, seed a fresh loop, continuation is coherent', async () => {
    // Original session: 2 productive turns + 1 text-only end_turn. Each
    // productive turn fires onTurnComplete; the end_turn terminal does NOT
    // (it returns before reaching the hook).
    const captured: Checkpoint[] = [];
    const original = makeScriptedLoop(
      [
        {
          text: 't1',
          calls: [{ callId: 'c1', name: 'Bash', arguments: { cmd: 'echo 1' } }],
          usage: { input_tokens: 10, output_tokens: 5 },
          id: 'resp_1',
        },
        {
          text: 't2',
          calls: [{ callId: 'c2', name: 'Bash', arguments: { cmd: 'echo 2' } }],
          usage: { input_tokens: 15, output_tokens: 7 },
          id: 'resp_2',
        },
        {
          text: 'done',
          calls: [],
          usage: { input_tokens: 5, output_tokens: 2 },
          id: 'resp_3',
        },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
        onTurnComplete: (cp: Checkpoint) => {
          // Round-trip through JSON to prove the checkpoint is pure data —
          // any closure / class-instance / non-serializable field would die here.
          captured.push(JSON.parse(JSON.stringify(cp)) as Checkpoint);
        },
      },
    );
    expect(await original.run()).toBe(0);

    // Two productive turns → two checkpoints. The end_turn turn fires no hook.
    expect(captured).toHaveLength(2);

    // First checkpoint: 1 turn completed, cumulative usage = turn 1's usage.
    expect(captured[0]).toMatchObject({
      numTurns: 1,
      previousResponseId: 'resp_1',
      totalUsage: { input_tokens: 10, output_tokens: 5 },
      lastText: 't1',
      toolCallCount: 1,
      toolResultCount: 1,
    });

    // Second checkpoint: 2 turns completed, cumulative across both.
    expect(captured[1]).toMatchObject({
      numTurns: 2,
      previousResponseId: 'resp_2',
      totalUsage: { input_tokens: 25, output_tokens: 12 },
      lastText: 't2',
      toolCallCount: 2,
      toolResultCount: 2,
    });

    // Transcript at the second checkpoint: user prompt + 2× (assistant turn +
    // tool_result user message) = 5 messages.
    expect(captured[1].transcript.messages).toHaveLength(5);

    // Resume from the SECOND checkpoint — a fresh loop, fresh scripted port,
    // only the final text-only end_turn step remains.
    const resumed = makeScriptedLoop(
      [{ text: 'done', calls: [], usage: { input_tokens: 5, output_tokens: 2 } }],
      { initialState: captured[1] },
    );
    expect(await resumed.run()).toBe(0);

    // The resumed loop's terminal accumulates from the seeded checkpoint:
    //   num_turns: 2 prior + 1 resumed = 3 — exactly the original's 3-turn result.
    //   usage: 25/12 + 5/2 = 30/14 — exactly the original's cumulative.
    expect(resumed.capture.resultEvent()).toMatchObject({
      stop_reason: 'end_turn',
      result: 'done',
      num_turns: 3,
      usage: { input_tokens: 30, output_tokens: 14 },
    });
  });

  it('inert: neither initialState nor onTurnComplete set → exactly today\'s behavior', async () => {
    // Mirrors the canonical end_turn case from turn-loop.contract.test.ts.
    // With both new fields absent, the loop must behave byte-identically to
    // 0.3.0 — proven separately by the 5 goldens (this case adds an explicit
    // assertion for the inert contract).
    const { run, capture } = makeScriptedLoop([{ text: 'all done', calls: [] }]);
    expect(await run()).toBe(0);
    expect(capture.resultEvent()).toMatchObject({
      type: 'result',
      stop_reason: 'end_turn',
      subtype: 'success',
      result: 'all done',
      num_turns: 1,
    });
  });
});
