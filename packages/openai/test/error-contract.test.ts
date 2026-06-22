// Transport-error contract for @bentway/openai's `complete`. Stubs the
// global `fetch` to exercise the non-2xx + fetch-level-throw branches and
// assert the neutral error shape.
import { describe, it, expect } from 'vitest';
import { complete } from '@bentway/openai';
import {
  installFetchStub,
  expectRetryableOnJsonStatus,
  expectNonRetryableOnJsonStatus,
  expectRetryableOnFetchTypeError,
} from '../../../test/_contract.js';

describe('@bentway/openai complete — transport-error shape', () => {
  const { setFetch } = installFetchStub();
  const args = { apiKey: 'k', baseUrl: 'http://o', body: { input: [] } };

  it('500 → retryable transport error with body message', async () => {
    await expectRetryableOnJsonStatus({ complete, args, setFetch }, { status: 500, bodyMessage: 'svc fail' });
  });

  it('502, 503, 504 → retryable', async () => {
    for (const status of [502, 503, 504]) {
      await expectRetryableOnJsonStatus({ complete, args, setFetch }, { status });
    }
  });

  it('429 → retryable', async () => {
    await expectRetryableOnJsonStatus({ complete, args, setFetch }, { status: 429 });
  });

  it('400, 401, 403 → NOT retryable', async () => {
    for (const status of [400, 401, 403]) {
      await expectNonRetryableOnJsonStatus({ complete, args, setFetch }, { status });
    }
  });

  it('fetch-level TypeError → retryable transport error (no status)', async () => {
    await expectRetryableOnFetchTypeError({ complete, args, setFetch });
  });

  it('AbortError simulation → retryable transport error', async () => {
    setFetch(async () => {
      const err = new Error('aborted');
      (err as Error & { name: string }).name = 'AbortError';
      throw err;
    });
    const r = (await complete(args)) as { retryable: boolean; stopReason: string };
    expect(r.retryable).toBe(true);
    expect(r.stopReason).toBe('error');
  });
});
