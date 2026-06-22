// Unit tests for `accumulateAnthropicStream` — the SSE folder that turns
// a sequence of /v1/messages events into the reconstructed message
// payload. The load-bearing edges: input_json split across deltas, the
// empty-input_json no-arg-tool case (never JSON.parse('')), reasoning-
// block + signature capture, multi-block index/order preservation, and
// usage merge.
import { describe, it, expect } from 'vitest';
import { accumulateAnthropicStream } from '@bentway/anthropic';

const start = (usage: Record<string, number> = {}) =>
  ({ type: 'message_start', message: { role: 'assistant', model: 'claude-x', usage } });
const blockStart = (index: number, content_block: Record<string, unknown>) =>
  ({ type: 'content_block_start', index, content_block });
const delta = (index: number, d: Record<string, unknown>) =>
  ({ type: 'content_block_delta', index, delta: d });
const blockStop = (index: number) => ({ type: 'content_block_stop', index });
const msgDelta = (stop_reason: string, usage: Record<string, number> = {}) =>
  ({ type: 'message_delta', delta: { stop_reason }, usage });
const stop = () => ({ type: 'message_stop' });

describe('accumulateAnthropicStream', () => {
  it('text-only: text deltas concatenate; textChunks recorded; usage merges input(start)+output(delta)', () => {
    const out = accumulateAnthropicStream([
      start({ input_tokens: 10 }),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'Hello ' }),
      delta(0, { type: 'text_delta', text: 'world' }),
      blockStop(0),
      msgDelta('end_turn', { output_tokens: 5 }),
      stop(),
    ]);
    expect(out.role).toBe('assistant');
    expect(out.content).toEqual([{ type: 'text', text: 'Hello world' }]);
    expect(out.stop_reason).toBe('end_turn');
    expect(out.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
    expect(out.textChunks).toEqual(['Hello ', 'world']);
  });

  it('tool_use: input_json split across ≥2 deltas → parsed into the input object', () => {
    const out = accumulateAnthropicStream([
      start(),
      blockStart(0, { type: 'tool_use', id: 'tu1', name: 'Bash' }),
      delta(0, { type: 'input_json_delta', partial_json: '{"command":' }),
      delta(0, { type: 'input_json_delta', partial_json: '"ls -la"}' }),
      blockStop(0),
      msgDelta('tool_use', { output_tokens: 8 }),
    ]);
    expect(out.content).toEqual([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la' } }]);
    expect(out.stop_reason).toBe('tool_use');
  });

  it('tool_use with NO input_json → input = {} (the no-arg-tool edge; never JSON.parse(""))', () => {
    const out = accumulateAnthropicStream([
      start(),
      blockStart(0, { type: 'tool_use', id: 'tu2', name: 'ListFiles' }),
      blockStop(0),
      msgDelta('tool_use'),
    ]);
    expect(out.content).toEqual([{ type: 'tool_use', id: 'tu2', name: 'ListFiles', input: {} }]);
  });

  it('thinking + signature_delta → { type:thinking, thinking, signature }', () => {
    const out = accumulateAnthropicStream([
      start(),
      blockStart(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'let me ' }),
      delta(0, { type: 'thinking_delta', thinking: 'think' }),
      delta(0, { type: 'signature_delta', signature: 'sigABC.def' }),
      blockStop(0),
      msgDelta('end_turn'),
    ]);
    expect(out.content).toEqual([{ type: 'thinking', thinking: 'let me think', signature: 'sigABC.def' }]);
  });

  it('multi-block: thinking(0) + text(1) + tool_use(2) preserves order & per-index accumulation', () => {
    const out = accumulateAnthropicStream([
      start({ input_tokens: 50 }),
      blockStart(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'plan' }),
      delta(0, { type: 'signature_delta', signature: 'sig1' }),
      blockStop(0),
      blockStart(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: 'doing it' }),
      blockStop(1),
      blockStart(2, { type: 'tool_use', id: 'tu', name: 'Foo' }),
      delta(2, { type: 'input_json_delta', partial_json: '{"x":1}' }),
      blockStop(2),
      msgDelta('tool_use', { output_tokens: 12 }),
      stop(),
    ]);
    expect(out.content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig1' },
      { type: 'text', text: 'doing it' },
      { type: 'tool_use', id: 'tu', name: 'Foo', input: { x: 1 } },
    ]);
    expect(out.usage).toMatchObject({ input_tokens: 50, output_tokens: 12 });
    expect(out.textChunks).toEqual(['doing it']);
  });

  it('redacted_thinking block is carried verbatim', () => {
    const out = accumulateAnthropicStream([
      start(),
      blockStart(0, { type: 'redacted_thinking', data: 'EncBlob==' }),
      blockStop(0),
      msgDelta('end_turn'),
    ]);
    expect(out.content).toEqual([{ type: 'redacted_thinking', data: 'EncBlob==' }]);
  });

  it('usage merge: cache fields from message_start survive; output_tokens from message_delta', () => {
    const out = accumulateAnthropicStream([
      start({ input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'hi' }),
      blockStop(0),
      msgDelta('end_turn', { output_tokens: 9 }),
    ]);
    expect(out.usage).toEqual({
      input_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
      output_tokens: 9,
    });
  });
});
