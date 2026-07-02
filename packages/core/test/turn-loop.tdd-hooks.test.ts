// Integration tests for the TDD-enforcement hook seams added in 0.5.0:
//   - maybeBuildPreToolIntervention(calls, toolLoopState) — pre-execution gate
//   - recordPostToolExec(calls, outputs, toolLoopState) — post-execution observer
//
// These tests verify the turn loop CALLS the hooks at the right time with the
// right arguments, and that the pre-hook's return value correctly blocks or
// allows tool execution. The hooks themselves are host-implemented (tested in
// understory-agents/policy-adapter-tdd.test.ts); here we test the seam.

import { describe, it, expect } from 'vitest';
import { makeScriptedLoop, executorsFor, transcript } from '../../../test/_harness.js';

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: Block[] };

describe('maybeBuildPreToolIntervention — pre-execution gate', () => {
  it('blocks tool execution when hook returns a string (executor never runs)', async () => {
    let executorRan = false;
    const BLOCK_MSG = 'TDD PHASE BLOCK: write the test first';
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Write', arguments: { file_path: 'src/impl.ts', content: '...' } }] },
        { text: 'ok', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Write: () => { executorRan = true; return 'written'; } }),
        maybeBuildPreToolIntervention: () => BLOCK_MSG,
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
    expect(executorRan).toBe(false);
    expect(harness.capture.resultEvent()).toMatchObject({ stop_reason: 'end_turn', result: 'ok' });
  });

  it('injects the intervention string as tool result for every call in the batch', async () => {
    const BLOCK_MSG = 'TDD: write test before implementation';
    const harness = makeScriptedLoop(
      [
        {
          text: '',
          calls: [
            { callId: 'c1', name: 'Write', arguments: { file_path: 'src/a.ts' } },
            { callId: 'c2', name: 'Write', arguments: { file_path: 'src/b.ts' } },
          ],
        },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Write: () => 'ok' }),
        maybeBuildPreToolIntervention: () => BLOCK_MSG,
      },
    );
    await harness.run();

    // The intervention message replaces ALL tool results in the shadow transcript
    const shadow = harness.finalShadow()!;
    const toolResults = (shadow.messages as Msg[])
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toMatchObject({ tool_use_id: 'c1', content: BLOCK_MSG });
    expect(toolResults[1]).toMatchObject({ tool_use_id: 'c2', content: BLOCK_MSG });
  });

  it('allows tool execution when hook returns falsy', async () => {
    let executorRan = false;
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Write', arguments: { file_path: 'src/foo.test.ts' } }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Write: () => { executorRan = true; return 'written'; } }),
        maybeBuildPreToolIntervention: () => null,
      },
    );
    await harness.run();

    expect(executorRan).toBe(true);
  });

  it('receives calls and toolLoopState as arguments', async () => {
    let receivedCalls: unknown;
    let receivedState: unknown;
    const STATE = { tddPhase: 'idle', tddEnabled: true };
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: { command: 'echo hi' } }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'hi' }),
        toolLoopState: STATE,
        maybeBuildPreToolIntervention: (calls: unknown, state: unknown) => {
          receivedCalls = calls;
          receivedState = state;
          return null;
        },
      },
    );
    await harness.run();

    expect(receivedCalls).toMatchObject([{ callId: 'c1', name: 'Bash' }]);
    expect(receivedState).toBe(STATE);
  });

  it('runs AFTER maybeBuildEditTestFailIntervention (both non-blocking → tools execute)', async () => {
    const callOrder: string[] = [];
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
        maybeBuildEditTestFailIntervention: () => { callOrder.push('edit-test-fail'); return undefined; },
        maybeBuildPreToolIntervention: () => { callOrder.push('pre-tool'); return null; },
      },
    );
    await harness.run();

    expect(callOrder).toEqual(['edit-test-fail', 'pre-tool']);
  });

  it('is NOT called when maybeBuildEditTestFailIntervention blocks (short-circuits first)', async () => {
    let preToolCalled = false;
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
        maybeBuildEditTestFailIntervention: () => 'BLOCKED by edit-test-fail',
        maybeBuildPreToolIntervention: () => { preToolCalled = true; return null; },
      },
    );
    await harness.run();

    expect(preToolCalled).toBe(false);
  });

  it('is a no-op when omitted from ctx (typeof-guarded)', async () => {
    let executorRan = false;
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Write', arguments: {} }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Write: () => { executorRan = true; return 'ok'; } }),
        // maybeBuildPreToolIntervention intentionally omitted
      },
    );
    await harness.run();

    expect(executorRan).toBe(true);
  });
});

describe('recordPostToolExec — post-execution observer', () => {
  it('is called with (calls, outputs, toolLoopState) after tool execution', async () => {
    let receivedCalls: unknown;
    let receivedOutputs: unknown;
    let receivedState: unknown;
    const STATE = { tddPhase: 'red', tddEnabled: true, tddEvidence: [] };
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: { command: 'npm test' } }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'FAIL: expected 3 to be 5' }),
        toolLoopState: STATE,
        recordPostToolExec: (calls: unknown, outputs: unknown, state: unknown) => {
          receivedCalls = calls;
          receivedOutputs = outputs;
          receivedState = state;
        },
      },
    );
    await harness.run();

    expect(receivedCalls).toMatchObject([{ callId: 'c1', name: 'Bash' }]);
    expect(receivedOutputs).toMatchObject([{ call_id: 'c1', output: 'FAIL: expected 3 to be 5' }]);
    expect(receivedState).toBe(STATE);
  });

  it('is called AFTER recordBashTestFailures', async () => {
    const callOrder: string[] = [];
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
        recordBashTestFailures: () => { callOrder.push('recordBash'); },
        recordPostToolExec: () => { callOrder.push('postToolExec'); },
      },
    );
    await harness.run();

    expect(callOrder).toEqual(['recordBash', 'postToolExec']);
  });

  it('can mutate toolLoopState (state is shared reference)', async () => {
    const STATE = { marker: 'before' };
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
        toolLoopState: STATE,
        recordPostToolExec: (_calls: unknown, _outputs: unknown, state: Record<string, string>) => {
          state.marker = 'after';
        },
      },
    );
    await harness.run();

    expect(STATE.marker).toBe('after');
  });

  it('is a no-op when omitted from ctx (typeof-guarded)', async () => {
    // Just verify the loop completes without error when the hook is absent
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Bash', arguments: {} }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
        // recordPostToolExec intentionally omitted
      },
    );
    const exit = await harness.run();

    expect(exit).toBe(0);
  });

  it('is NOT called when pre-tool intervention blocks (no tool execution happened)', async () => {
    let postToolCalled = false;
    const harness = makeScriptedLoop(
      [
        { text: '', calls: [{ callId: 'c1', name: 'Write', arguments: {} }] },
        { text: 'done', calls: [] },
      ],
      {
        runtimeTools: executorsFor({ Write: () => 'ok' }),
        maybeBuildPreToolIntervention: () => 'BLOCKED',
        recordPostToolExec: () => { postToolCalled = true; },
      },
    );
    await harness.run();

    expect(postToolCalled).toBe(false);
  });
});
