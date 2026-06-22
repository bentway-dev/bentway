// Shared transport-error contract helpers.
//
// The neutral error shape `{ kind:'error', stage, retryable, ... }` is the
// contract every provider port resolves to on expected failures. The
// assertion primitives below capture the JSON-HTTP scenarios that the
// `openai` and `anthropic` ports share so each port's own test file can
// call them with its own `complete` + args, without depending on the
// other ports' workspace packages.
//
// Port-specific scenarios (llama's `requestFailed` semantics, completion-
// stage failures, the success-path probe) live in each port's own test
// file — they have no analogue in the other ports and don't belong here.
import { beforeEach, afterEach, expect } from 'vitest';

export type NeutralErrorShape = {
  kind: 'error';
  stage: 'transport' | 'completion';
  retryable: boolean;
  status?: number;
  requestFailed?: boolean;
  message: string;
  stopReason: string;
  textChunks?: string[];
};

export type FetchHandler = (url: string | URL, init?: RequestInit) => Promise<Response>;
export type SetFetch = (handler: FetchHandler) => void;

/**
 * Install a per-test fetch stub. Call inside a `describe` block once;
 * returns the `setFetch` function each `it` uses to inject its handler.
 * The original `globalThis.fetch` is restored in `afterEach`.
 */
export function installFetchStub(): { setFetch: SetFetch } {
  const originalFetch = globalThis.fetch;
  let stubFetch: FetchHandler | null = null;
  beforeEach(() => { stubFetch = null; });
  afterEach(() => { globalThis.fetch = originalFetch; stubFetch = null; });
  const setFetch: SetFetch = (handler) => {
    stubFetch = handler;
    globalThis.fetch = (...args) => stubFetch!(...args as Parameters<FetchHandler>);
  };
  return { setFetch };
}

/** Build a JSON Response with the given status + body. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: `Status ${status}`,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── JSON-HTTP port scenarios ───────────────────────────────────────────
//
// Used by ports whose `complete()` POSTs JSON and surfaces non-2xx as a
// classic retryable/non-retryable transport error (openai, anthropic).
// llama's contract diverges and lives in its own test file.

export type JsonPortCtx<Args> = {
  complete: (args: Args) => Promise<unknown>;
  args: Args;
  setFetch: SetFetch;
};

/**
 * Assert a status code yields a retryable transport error. If
 * `bodyMessage` is provided, the response body carries
 * `{ error: { message: bodyMessage } }` and the error message is checked
 * for equality.
 */
export async function expectRetryableOnJsonStatus<Args>(
  ctx: JsonPortCtx<Args>,
  opts: { status: number; bodyMessage?: string },
): Promise<NeutralErrorShape> {
  ctx.setFetch(async () =>
    jsonResponse(opts.status, opts.bodyMessage ? { error: { message: opts.bodyMessage } } : {}),
  );
  const r = (await ctx.complete(ctx.args)) as NeutralErrorShape;
  expect(r).toMatchObject({
    kind: 'error',
    stage: 'transport',
    retryable: true,
    status: opts.status,
    stopReason: 'error',
  });
  if (opts.bodyMessage) expect(r.message).toBe(opts.bodyMessage);
  return r;
}

/** Assert a status code yields a non-retryable transport error. */
export async function expectNonRetryableOnJsonStatus<Args>(
  ctx: JsonPortCtx<Args>,
  opts: { status: number },
): Promise<NeutralErrorShape> {
  ctx.setFetch(async () => jsonResponse(opts.status, {}));
  const r = (await ctx.complete(ctx.args)) as NeutralErrorShape;
  expect(r.kind).toBe('error');
  expect(r.retryable).toBe(false);
  expect(r.status).toBe(opts.status);
  return r;
}

/**
 * Assert a fetch-level TypeError (network failure) yields a retryable
 * transport error with no status code. `expectedMessage` defaults to
 * `"fetch failed"` and is asserted via equality.
 */
export async function expectRetryableOnFetchTypeError<Args>(
  ctx: JsonPortCtx<Args>,
  opts: { expectedMessage?: string } = {},
): Promise<NeutralErrorShape> {
  const msg = opts.expectedMessage ?? 'fetch failed';
  ctx.setFetch(async () => { throw new TypeError(msg); });
  const r = (await ctx.complete(ctx.args)) as NeutralErrorShape;
  expect(r).toMatchObject({
    kind: 'error',
    stage: 'transport',
    retryable: true,
    stopReason: 'error',
  });
  expect(r.status).toBeUndefined();
  expect(r.message).toBe(msg);
  return r;
}
