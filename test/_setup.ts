// Frozen clock for the test suite.
//
// Several emitted events carry Date.now() deltas (`duration_api_ms`,
// `durationMs`). Freezing Date.now() to a constant zeroes every delta so the
// emitted stream is deterministic. Imports nothing host-specific.
import { beforeEach, afterEach, vi } from 'vitest';

export const FROZEN_NOW = 1_700_000_000_000;

let dateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dateSpy = vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
});

afterEach(() => {
  dateSpy.mockRestore();
});
