# @bentway/stream-json

Provider-neutral stream-json event projection for LLM agent loops.

Part of [Bentway](https://github.com/bentway-dev/bentway), a runtime-agnostic
agent execution kernel.

## Install

```
npm install @bentway/stream-json
```

## Usage

This package owns the stream-json sink, the line writer, the event
builders, and the usage shape the stream-json projection carries. Each
emitted line is one JSON event.

The canonical use is `streamJsonSink`, wired as the kernel's `emitter`.
The loop emits neutral events (see `@bentway/core/events`) and the sink
renders them to stream-json bytes:

```js
import { streamJsonSink } from '@bentway/stream-json';
import { runTurnLoop } from '@bentway/core/turn-loop';

await runTurnLoop({
  // ...other ctx fields...
  emitter: streamJsonSink((line) => process.stdout.write(line)),
});
```

The default writer is `process.stdout.write`; pass any function that
accepts a string for tests, capture, or custom transports.

For direct emission — e.g. host-side `emitProviderTextStream` /
`emitProviderText` hooks that need to project provider-native chunks —
the builders are exported individually:

```js
import {
  emit,
  buildResultEvent,
  assistantTextEvent,
  toolResultEvent,
} from '@bentway/stream-json';

// At a terminal stop, build the result event:
emit(buildResultEvent({
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  usage: { input_tokens: 100, output_tokens: 50 },
  totalCostUsd: 0.01,
  durationApiMs: 1234,
  numTurns: 1,
  resultText: 'done',
}));
```

The cross-turn usage accumulator (`accumulateUsage`) lives in
[`@bentway/core/usage`](../core) — it's provider-native arithmetic with
zero wire-shape concern.

## License

Apache-2.0
