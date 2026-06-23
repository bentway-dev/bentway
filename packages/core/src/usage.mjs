// Provider-native usage arithmetic owned by the kernel.
//
// `accumulateUsage` sums per-turn token counts (input/output, cached input,
// cache-creation, reasoning) into a running session total. It operates on
// the provider-native shape (`input_tokens`, `output_tokens`,
// `input_tokens_details.cached_tokens`, `input_tokens_details.cache_creation_tokens`,
// `output_tokens_details.reasoning_tokens`) — zero wire-shape concern.
// The rename to stream-json's renamed-field projection lives in
// @bentway/stream-json's `projectUsageForStreamJson`.

export function accumulateUsage(accumulated, turnUsage) {
  const turn = turnUsage || {};
  if (!accumulated || !Object.keys(accumulated).length) {
    return { ...turn };
  }
  return {
    input_tokens: (accumulated.input_tokens || 0) + (turn.input_tokens || 0),
    output_tokens: (accumulated.output_tokens || 0) + (turn.output_tokens || 0),
    input_tokens_details: {
      cached_tokens:
        (accumulated.input_tokens_details?.cached_tokens || 0) +
        (turn.input_tokens_details?.cached_tokens || 0),
      // Fold the write tier next to the read tier. Providers that don't
      // emit cache_creation_tokens accumulate to 0.
      cache_creation_tokens:
        (accumulated.input_tokens_details?.cache_creation_tokens || 0) +
        (turn.input_tokens_details?.cache_creation_tokens || 0),
    },
    output_tokens_details: {
      reasoning_tokens:
        (accumulated.output_tokens_details?.reasoning_tokens || 0) +
        (turn.output_tokens_details?.reasoning_tokens || 0),
    },
  };
}
