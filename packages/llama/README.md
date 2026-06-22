# @bentway/llama

llama.cpp / llama-server completion port for the bentway kernel.

Part of [Bentway](https://github.com/bentway-dev/bentway), a runtime-agnostic
agent execution kernel.

## Install

```
npm install @bentway/llama @bentway/core @bentway/stream-json
```

## Usage

`complete()` POSTs the OpenAI-compatible /v1/chat/completions endpoint
with `stream: true`, accumulates the SSE stream, and resolves to the
neutral `PortResult` shape on success. Non-2xx, stream errors, and
malformed tool-calls all resolve to the neutral error shape rather than
throwing — the turn loop's host-side hooks own the policy.

```js
import { complete } from '@bentway/llama';

const result = await complete({
  host: 'http://localhost:11434',
  model: 'qwen3-coder:30b',
  messages: [{ role: 'user', content: 'do the task' }],
  tools: [],
  temperature: 0.7,
  top_p: 0.8,
  presence_penalty: 1.5,
});

// Inject `complete` into runTurnLoop from @bentway/core, with a
// `serializeRequest` closure that produces this args shape from the
// owned Transcript via `serializeForLlama`.
```

Streaming text is preserved in `result.textChunks`; the loop's
`emitProviderTextStream` hook replays them to keep the projection
provider-neutral.

## License

Apache-2.0
