// Byte-identity goldens for the turn-loop's emitted stream-json. The
// turn-loop.contract.test.ts suite covers the behavioral contract via
// per-event assertions; this file freezes the EXACT EMIT BYTES for a
// representative slice so any silent drift in the projection lands loud
// on a snapshot diff.
//
// Scenarios picked to span the major terminals + tiers:
//   - end_turn (the happy path)
//   - max_turns (clean cap terminal)
//   - retryable success after 2 transport errors (api_retry frames)
//   - non-retryable fatal (immediate transport fail, NO api_call_end)
//   - tool-turn → end_turn (productive tool-exec flow, num_turns=2)
//
// Regenerating after an intentional emit-shape change:
//   pnpm vitest run -u packages/core/test/turn-loop.goldens.test.ts
// Inspect the diff, commit the updated __snapshots__/*.stream-json.jsonl.
import { describe, it, expect } from 'vitest';
import { makeScriptedLoop, executorsFor } from '../../../test/_harness.js';

describe('turn-loop goldens — byte-identity emit snapshots', () => {
  it('end_turn — text-only happy path', async () => {
    const { run, capture } = makeScriptedLoop([{ text: 'all done', calls: [] }]);
    const exit = await run();
    expect(exit).toBe(0);
    await expect(capture.raw()).toMatchFileSnapshot('./__snapshots__/end-turn.stream-json.jsonl');
  });

  it('max_turns — productive turns hit the cap', async () => {
    const { run, capture } = makeScriptedLoop(
      [
        { text: 'first', calls: [{ callId: 'c1', name: 'Bash', arguments: { cmd: 'echo 1' } }] },
        { text: 'second', calls: [{ callId: 'c2', name: 'Bash', arguments: { cmd: 'echo 2' } }] },
      ],
      {
        effectiveMaxTurns: 2,
        runtimeTools: executorsFor({ Bash: () => 'ok' }),
      },
    );
    const exit = await run();
    expect(exit).toBe(0);
    await expect(capture.raw()).toMatchFileSnapshot('./__snapshots__/max-turns.stream-json.jsonl');
  });

  it('transport retryable — 2 errors then success, 2 api_retry frames', async () => {
    const { run, capture } = makeScriptedLoop([
      { error: { stage: 'transport', retryable: true, status: 502, message: 'bad gateway' } },
      { error: { stage: 'transport', retryable: true, status: 502, message: 'bad gateway' } },
      { text: 'recovered', calls: [] },
    ]);
    const exit = await run();
    expect(exit).toBe(0);
    await expect(capture.raw()).toMatchFileSnapshot('./__snapshots__/transport-retryable-success.stream-json.jsonl');
  });

  it('transport non-retryable — immediate fatal, NO api_call_end', async () => {
    const { run, capture } = makeScriptedLoop([
      { error: { stage: 'transport', retryable: false, status: 401, message: 'unauthorized' } },
    ]);
    const exit = await run();
    expect(exit).toBe(1);
    await expect(capture.raw()).toMatchFileSnapshot('./__snapshots__/transport-non-retryable.stream-json.jsonl');
  });

  it('productive tool-turn → end_turn — tool-exec runs, num_turns=2', async () => {
    const { run, capture } = makeScriptedLoop(
      [
        { text: 'will call tool', calls: [{ callId: 'c1', name: 'Bash', arguments: { cmd: 'ls' } }] },
        { text: 'done', calls: [] },
      ],
      { runtimeTools: executorsFor({ Bash: () => 'fileA\nfileB' }) },
    );
    const exit = await run();
    expect(exit).toBe(0);
    await expect(capture.raw()).toMatchFileSnapshot('./__snapshots__/tool-turn-end.stream-json.jsonl');
  });
});
