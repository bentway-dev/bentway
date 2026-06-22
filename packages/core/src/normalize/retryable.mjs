// Shared transport-error retry classifier used by every port to populate
// the `retryable` field of its neutral error result.
//
// Retryable: AbortError (timeout), HTTP 429 (rate limit), HTTP 5xx
// (server-side errors — includes Anthropic 529 Overloaded), and TypeError
// (network-level fetch failure).
//
// Exception: a `ByteString conversion` TypeError is NOT retryable. It means
// a header value (typically an API key in `Authorization: Bearer <key>`)
// contains a non-Latin1 character — a configuration fault, not a transient
// blip. Retrying would burn the budget on three identical failures.
//
// Imports nothing.

/**
 * Classify a transport-level error as retryable.
 *
 * @param {Error & { name?: string, status?: number, message?: string }} err
 * @returns {boolean}
 */
export function isRetryableApiError(err) {
  if (!err) return false;
  // AbortController timeout/cancel never produced an HTTP response, so
  // this branch stays ahead of any status-code checks.
  if (err.name === 'AbortError') return true;
  if (err instanceof TypeError) {
    // node fetch reports genuine transport failures (DNS, ECONNREFUSED) as
    // TypeError, so treat that class as retryable before HTTP status checks.
    if (/ByteString/i.test(err.message || '')) return false;
    return true; // genuine network-level fetch failure
  }
  const status = err.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  // Also match status codes embedded in error messages from older paths
  if (typeof err.message === 'string' && /\b(429|5\d\d)\b/.test(err.message)) return true;
  return false;
}
