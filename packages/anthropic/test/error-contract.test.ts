// Transport-error contract for @bentway/anthropic's `complete`. Stubs the
// global `fetch` to exercise the non-2xx + fetch-level-throw branches and
// assert the neutral error shape.
//
// Includes a 529-Overloaded regression guard: 529 is retryable because it
// falls within the shared classifier's 5xx range, so no Anthropic-specific
// OR is needed in the port.
import { describe, it } from 'vitest';
import { complete } from '@bentway/anthropic';
import {
  installFetchStub,
  expectRetryableOnJsonStatus,
  expectNonRetryableOnJsonStatus,
  expectRetryableOnFetchTypeError,
} from '../../../test/_contract.js';

describe('@bentway/anthropic complete — transport-error shape', () => {
  const { setFetch } = installFetchStub();
  const args = { apiKey: 'k', baseUrl: 'http://a', body: { messages: [] } };

  it('529 (Overloaded) → retryable (falls within the 5xx classifier range)', async () => {
    await expectRetryableOnJsonStatus({ complete, args, setFetch }, { status: 529, bodyMessage: 'overloaded' });
  });

  it('500 → retryable', async () => {
    await expectRetryableOnJsonStatus({ complete, args, setFetch }, { status: 500 });
  });

  it('429 → retryable', async () => {
    await expectRetryableOnJsonStatus({ complete, args, setFetch }, { status: 429 });
  });

  it('400 → NOT retryable', async () => {
    await expectNonRetryableOnJsonStatus({ complete, args, setFetch }, { status: 400 });
  });

  it('fetch-level TypeError → retryable transport error', async () => {
    await expectRetryableOnFetchTypeError({ complete, args, setFetch }, { expectedMessage: 'network down' });
  });
});
