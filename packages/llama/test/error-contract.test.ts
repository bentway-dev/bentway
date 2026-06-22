// Transport-error contract for @bentway/llama's `complete`.
//
// Llama's contract diverges from the JSON-HTTP shape of openai/anthropic:
// non-2xx surfaces as `{ requestFailed: true, retryable: false }` (the
// host's request-failed hook owns the policy), and there are two
// completion-stage failure modes (stream_error, malformed_tool_call) that
// have no analogue in the other ports. So these scenarios live here, not
// in the shared `_contract.ts` helper.
import { describe, it, expect } from 'vitest';
import { complete } from '@bentway/llama';
import { installFetchStub, jsonResponse } from '../../../test/_contract.js';

type ErrorShape = {
  kind: 'error';
  stage: 'transport' | 'completion';
  retryable: boolean;
  status?: number;
  requestFailed?: boolean;
  message: string;
  stopReason: string;
  textChunks?: string[];
};

// Minimal SSE [DONE] stream — used only by the success-path probe.
function sseDoneStream(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('@bentway/llama complete — transport-error shape', () => {
  const { setFetch } = installFetchStub();
  const args = {
    host: 'http://llama:11434',
    model: 'qwen3-coder:30b',
    messages: [],
    tools: [],
    temperature: 0.7,
    top_p: 0.8,
    presence_penalty: 1.5,
  };

  it('non-2xx → requestFailed:true, retryable:false', async () => {
    setFetch(async () => jsonResponse(500, { error: 'context window exceeded' }));
    const r = (await complete(args)) as ErrorShape;
    expect(r).toMatchObject({
      kind: 'error',
      stage: 'transport',
      retryable: false,
      requestFailed: true,
      status: 500,
      stopReason: 'chat_request_failed',
    });
    expect(r.message).toContain('500');
  });

  it('non-2xx 503 → still retryable:false (requestFailed flag overrides 5xx)', async () => {
    setFetch(async () => jsonResponse(503, { error: 'unavailable' }));
    const r = (await complete(args)) as ErrorShape;
    expect(r.retryable).toBe(false);
    expect(r.requestFailed).toBe(true);
    expect(r.status).toBe(503);
  });

  it('fetch-level generic Error → transport, NOT requestFailed, NOT retryable', async () => {
    setFetch(async () => { throw new Error('ECONNREFUSED 10.0.0.5:11434'); });
    const r = (await complete(args)) as ErrorShape;
    expect(r).toMatchObject({ kind: 'error', stage: 'transport', stopReason: 'error' });
    expect(r.requestFailed).toBeUndefined();
    expect(r.retryable).toBe(false); // a generic Error is not retryable
  });

  it('fetch-level TypeError (network) → transport, retryable, NOT requestFailed', async () => {
    setFetch(async () => { throw new TypeError('fetch failed'); });
    const r = (await complete(args)) as ErrorShape;
    expect(r.retryable).toBe(true);
    expect(r.requestFailed).toBeUndefined();
  });

  it('stream-error (no [DONE]) → stage:completion, retryable:false, stopReason:stream_error', async () => {
    // Empty SSE body — closes before any [DONE] sentinel.
    setFetch(async () => {
      const body = new ReadableStream({ start(c) { c.close(); } });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const r = (await complete(args)) as ErrorShape;
    expect(r).toMatchObject({
      kind: 'error',
      stage: 'completion',
      retryable: false,
      stopReason: 'stream_error',
    });
    expect(r.message).toContain('DONE');
    expect(r.textChunks).toEqual([]);
  });

  it('malformed tool call → stage:completion, retryable:false, stopReason:malformed_tool_call', async () => {
    // Stream with a tool_call missing `function.name`, followed by [DONE].
    setFetch(async () => {
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { arguments: '{}' } }] } }] })}\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n`,
        'data: [DONE]\n',
      ];
      const body = new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const r = (await complete(args)) as ErrorShape;
    expect(r).toMatchObject({
      kind: 'error',
      stage: 'completion',
      retryable: false,
      stopReason: 'malformed_tool_call',
    });
    expect(r.textChunks).toEqual([]);
  });

  // Sanity: the success path still works.
  it('empty [DONE] stream → success (neutral PortResult), not error', async () => {
    setFetch(async () => sseDoneStream());
    const r = await complete(args);
    expect((r as { kind?: string }).kind).toBeUndefined();
    expect((r as { text: string }).text).toBe('');
  });
});
