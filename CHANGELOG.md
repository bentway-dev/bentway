# Changelog

Notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
