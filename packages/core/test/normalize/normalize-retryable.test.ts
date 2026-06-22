// Unit coverage for `isRetryableApiError`, the shared transport-error
// classifier each port consults before resolving the neutral
// transport-error shape.
import { describe, it, expect } from 'vitest';
import { isRetryableApiError } from '@bentway/core/normalize/retryable';

const cls = isRetryableApiError as (err: unknown) => boolean;

describe('isRetryableApiError', () => {
  it('classifies AbortError as retryable (timeouts)', () => {
    expect(cls({ name: 'AbortError' })).toBe(true);
  });

  it('classifies a fetch-level TypeError as retryable (network failure)', () => {
    expect(cls(new TypeError('fetch failed'))).toBe(true);
  });

  it('does NOT classify a ByteString TypeError as retryable (header config fault)', () => {
    expect(cls(new TypeError('ByteString is not convertible to a Uint8Array'))).toBe(false);
  });

  it('classifies HTTP 429 (rate limit) as retryable', () => {
    expect(cls({ status: 429 })).toBe(true);
  });

  it('classifies the 5xx range as retryable (500, 503, 504)', () => {
    expect(cls({ status: 500 })).toBe(true);
    expect(cls({ status: 503 })).toBe(true);
    expect(cls({ status: 504 })).toBe(true);
  });

  it('classifies HTTP 529 as retryable (Anthropic Overloaded falls in the 5xx range)', () => {
    expect(cls({ status: 529 })).toBe(true);
  });

  it('does NOT classify 4xx (400, 401, 403, 404) as retryable', () => {
    expect(cls({ status: 400 })).toBe(false);
    expect(cls({ status: 401 })).toBe(false);
    expect(cls({ status: 403 })).toBe(false);
    expect(cls({ status: 404 })).toBe(false);
  });

  it('parses status codes embedded in error messages', () => {
    expect(cls(new Error('OpenAI request failed (500)'))).toBe(true);
    expect(cls(new Error('OpenAI request failed (429)'))).toBe(true);
    expect(cls(new Error('OpenAI request failed (400)'))).toBe(false);
  });

  it('does NOT classify a generic Error as retryable', () => {
    expect(cls(new Error('ECONNREFUSED 10.0.0.5:11434'))).toBe(false);
    expect(cls(new Error('something else'))).toBe(false);
  });

  it('handles undefined / null defensively', () => {
    expect(cls(undefined)).toBe(false);
    expect(cls(null)).toBe(false);
  });
});
