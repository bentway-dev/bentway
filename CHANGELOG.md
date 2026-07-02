# Changelog

Notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] — 2026-07-02

Re-release of 0.5.0 with all packages versioned consistently. The 0.5.0 publish only bumped `@bentway/core`; the other four packages failed to publish at 0.4.0 (already published). No code changes from 0.5.0.

## [0.5.0] — 2026-07-02

### Added
- `ctx.maybeBuildPreToolIntervention(calls, toolLoopState)` in `@bentway/core/turn-loop`: optional pre-tool-execution policy seam. Consulted after the existing `maybeBuildEditTestFailIntervention` guard but before any tool call executes. Returns a string intervention message to block execution (same shape as `maybeBuildEditTestFailIntervention`), or falsy to proceed. typeof-guarded — omitting the hook is a no-op. Enables the host to inject additional pre-execution gates (e.g. TDD phase enforcement) without overloading or wrapping existing hooks.
- `ctx.recordPostToolExec(calls, outputs, toolLoopState)` in `@bentway/core/turn-loop`: optional post-tool-execution recording seam. Called after `recordBashTestFailures`. Mutates `toolLoopState` in place; no return value consumed. typeof-guarded — omitting the hook is a no-op. Enables the host to inject additional post-execution observers (e.g. TDD phase state tracking) without wrapping `recordBashTestFailures`.

No breaking changes. With neither field set, behavior is identical to 0.4.0.

## [0.4.0] — 2026-06-23

### Added
- `ctx.initialState` in `@bentway/core/turn-loop`: optional seeded `Checkpoint` that restores the loop's transcript and cross-turn state (`numTurns`, `totalUsage`, `previousResponseId`, the cumulative counters, the intervention flags) so a fresh process can continue a prior session at the next turn boundary. Omitted → behavior is identical to 0.3.0 (the loop builds its transcript fresh from `prompt`).
- `ctx.onTurnComplete?(checkpoint)` in `@bentway/core/turn-loop`: optional turn-boundary observer invoked at the bottom of each productive turn with the full `Checkpoint`. The host owns persistence cadence and storage; the loop only emits.
- `Checkpoint` type exported from `@bentway/core/turn-loop`: the typed contract a host persists and restores against — pure data, JSON-round-trippable.

No breaking changes. With neither field set, the 5 stream-json byte-identity goldens are unchanged.

## [0.3.0] — 2026-06-22

### Added
- `customEvent({ subtype, ...fields })` in `@bentway/core/events`: a neutral passthrough for host- or consumer-specific events that are not part of the typed kernel vocabulary. The stream-json sink renders it to `{ type: 'system', subtype, ...fields }` — field-order-preserving for byte-identical line emission.

### Changed
- **BREAKING (behavioral):** `streamJsonSink` now throws on an unrecognized event tag instead of silently dropping it. Hosts that previously emitted stream-json line objects directly through the sink must wrap them with `customEvent({ subtype, ...fields })`. The thrown error names the offending tag and points the adopter at `customEvent`.

## [0.2.0] — 2026-06-22

### Changed
- **BREAKING (direct loop consumers):** `@bentway/core`'s turn loop now emits neutral, format-agnostic events instead of stream-json objects. `@bentway/stream-json` is now a sink: wrap a line-writer with `streamJsonSink(writer)` and pass that as the loop's `emitter`.
- Dependency arrow inverted — `@bentway/core` now depends on nothing; `@bentway/stream-json` depends on `@bentway/core`. New entry points: `@bentway/core/events`, `@bentway/core/usage` (`accumulateUsage` relocated here). `streamJsonSink` added to `@bentway/stream-json`.
- No output changes: rendered stream-json is byte-identical (goldens unchanged).

## [0.1.0] — 2026-06-22

### Added
- Initial public release of the Bentway runtime-agnostic agent execution kernel.
- `@bentway/core` — turn loop, neutral transcript, tool-call dispatch, provider-agnostic stop/retry semantics.
- `@bentway/anthropic`, `@bentway/openai`, `@bentway/llama` — provider completion ports.
- `@bentway/stream-json` — provider-neutral stream-json event projection.
