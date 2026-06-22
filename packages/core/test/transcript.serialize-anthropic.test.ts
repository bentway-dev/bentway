// Unit tests for `serializeForAnthropic` — the neutral Transcript →
// /v1/messages `messages` content mapping. The load-bearing correctness
// cases: reasoning-block replay ordering (thinking / redacted_thinking
// must come first in an assistant message or /v1/messages 400s on
// signature verification), and verbatim round-trip of the opaque
// reasoning payload (signature intact).
import { describe, it, expect } from 'vitest';
import * as transcript from '@bentway/core/transcript';

const {
  createTranscript, appendMessage, message, text, toolUse, toolResult, reasoning,
  serializeForAnthropic,
} = transcript as {
  createTranscript: (m?: unknown[]) => { messages: unknown[] };
  appendMessage: (t: unknown, m: unknown) => { messages: unknown[] };
  message: (role: string, content: unknown[]) => unknown;
  text: (value: string, phase?: string) => unknown;
  toolUse: (id: string, name: string, input: Record<string, unknown>) => unknown;
  toolResult: (toolUseId: string, content: string, opts?: { isError?: boolean }) => unknown;
  reasoning: (provider: string, payload: string) => unknown;
  serializeForAnthropic: (t: unknown) => Array<{ role: string; content: Array<Record<string, unknown>> }>;
};

function tx(...messages: unknown[]) {
  let t = createTranscript();
  for (const m of messages) t = appendMessage(t, m);
  return t;
}

describe('serializeForAnthropic', () => {
  it('1. reasoning-first ordering (the signature guard): hoists reasoning to the front of assistant content', () => {
    const think = JSON.stringify({ type: 'thinking', thinking: 'plan', signature: 'sig123' });
    // Built deliberately OUT of order: [text, reasoning, tool_use].
    const t = tx(
      message('assistant', [
        text('let me check'),
        reasoning('anthropic', think),
        toolUse('tu1', 'Bash', { command: 'ls' }),
      ]),
    );
    const messages = serializeForAnthropic(t);

    expect(messages).toHaveLength(1);
    const content = messages[0].content;
    // Reasoning is FIRST; text + tool_use keep their captured relative order after it.
    expect(content[0]).toMatchObject({ type: 'thinking', signature: 'sig123' });
    expect(content[1]).toMatchObject({ type: 'text', text: 'let me check' });
    expect(content[2]).toMatchObject({ type: 'tool_use', name: 'Bash' });
  });

  it('2. reasoning round-trip verbatim: thinking (with signature) and redacted_thinking replay exactly', () => {
    const thinking = { type: 'thinking', thinking: 'deep thought', signature: 'abc.def.ghi' };
    const redacted = { type: 'redacted_thinking', data: 'EncRyPtEdBlOb==' };
    const t = tx(
      message('assistant', [
        reasoning('anthropic', JSON.stringify(thinking)),
        reasoning('anthropic', JSON.stringify(redacted)),
        text('done'),
      ]),
    );
    const content = serializeForAnthropic(t)[0].content;

    // Verbatim — signature + data intact, no kernel interpretation.
    expect(content[0]).toEqual(thinking);
    expect(content[1]).toEqual(redacted);
    expect(content[2]).toEqual({ type: 'text', text: 'done' });
  });

  it('3. block mapping: text / tool_use / tool_result shapes; tool_result is_error carried', () => {
    const t = tx(
      message('assistant', [
        text('using a tool'),
        toolUse('tu1', 'Read', { path: '/x' }),
      ]),
      message('user', [
        toolResult('tu1', 'file contents'),
        toolResult('tu2', 'it failed', { isError: true }),
      ]),
    );
    const messages = serializeForAnthropic(t);

    // assistant: text + tool_use (input is the OBJECT, not a JSON string).
    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'using a tool' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/x' } },
      ],
    });
    // user: tool_result blocks; is_error only present when true.
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' },
        { type: 'tool_result', tool_use_id: 'tu2', content: 'it failed', is_error: true },
      ],
    });
  });

  it('4. multi-turn sequence: user → assistant(reasoning+tool_use) → tool_result → assistant(text)', () => {
    const think = JSON.stringify({ type: 'thinking', thinking: 't', signature: 's' });
    const t = tx(
      message('user', [text('do the task')]),
      message('assistant', [reasoning('anthropic', think), toolUse('tu1', 'Bash', { command: 'echo hi' })]),
      message('user', [toolResult('tu1', 'hi')]),
      message('assistant', [text('all done')]),
    );
    const messages = serializeForAnthropic(t);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[0].content).toEqual([{ type: 'text', text: 'do the task' }]);
    expect(messages[1].content[0]).toMatchObject({ type: 'thinking', signature: 's' });
    expect(messages[1].content[1]).toMatchObject({ type: 'tool_use', name: 'Bash' });
    expect(messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'tu1', content: 'hi' }]);
    expect(messages[3].content).toEqual([{ type: 'text', text: 'all done' }]);
  });

  it('5. system + tools are NOT embedded — the fn returns only the user/assistant messages[] (host adds them top-level)', () => {
    const t = tx(
      message('user', [text('hello')]),
      message('assistant', [text('hi')]),
    );
    const messages = serializeForAnthropic(t);

    // The return IS the messages array (not a `{ system, tools, messages }`
    // object) — system + tools are top-level params the host's
    // `serializeRequest` closure adds when building the body.
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(messages.some((m) => m.role === 'system')).toBe(false);
    expect(messages.some((m) => 'system' in m || 'tools' in m)).toBe(false);

    // A system-role message is rejected (system is a top-level param, host-supplied).
    const withSystem = tx(message('system', [text('you are helpful')]), message('user', [text('hi')]));
    expect(() => serializeForAnthropic(withSystem)).toThrow(/system/i);
  });
});
