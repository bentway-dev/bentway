# @bentway/stream-json

Provider-neutral stream-json event projection for LLM agent loops.

Part of [Bentway](https://github.com/bentway-dev/bentway), a runtime-agnostic
agent execution kernel.

## Install

```
npm install @bentway/stream-json
```

## Usage

This package owns the line writer, event builders, and the usage shape the
stream-json projection carries. Each emitted line is one JSON event.

```js
import {
  emit,
  buildResultEvent,
  assistantTextEvent,
  toolResultEvent,
  accumulateUsage,
} from '@bentway/stream-json';

// Each turn:
emit({ type: 'system', subtype: 'api_call_start', turn: 1 });

// Provider usage rolls into a running total in the OpenAI-inclusive shape:
const total = accumulateUsage({}, { input_tokens: 100, output_tokens: 50 });

// At a terminal stop, build the result event:
emit(buildResultEvent({
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  usage: total,
  totalCostUsd: 0.01,
  durationApiMs: 1234,
  numTurns: 1,
  resultText: 'done',
}));
```

The default `emit` writer is `process.stdout.write`; pass any writer that
accepts a string for tests, capture, or custom transports.

## License

Apache-2.0
