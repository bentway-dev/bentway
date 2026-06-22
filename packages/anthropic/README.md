# @bentway/anthropic

Anthropic /v1/messages completion port for the bentway kernel.

Part of [Bentway](https://github.com/bentway-dev/bentway), a runtime-agnostic
agent execution kernel.

## Install

```
npm install @bentway/anthropic @bentway/core @bentway/stream-json
```

## Usage

`complete()` POSTs the /v1/messages endpoint, accumulates the SSE stream,
and resolves to the neutral `PortResult` shape the turn loop reads
directly. Expected transport failures resolve to the neutral error shape
instead of throwing.

```js
import {
  complete,
  selectThinkingConfig,
  makeAnthropicSerializeRequest,
  computeAnthropicTotalCostUsd,
} from '@bentway/anthropic';

const { thinking, output_config } = selectThinkingConfig({
  model: 'claude-opus-4-8',
  max_tokens: 4096,
});

const serializeRequest = makeAnthropicSerializeRequest({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-opus-4-8',
  max_tokens: 4096,
  system: 'You are helpful.',
  runtimeTools: { tools: [] },
  thinking,
  output_config,
});

// Inject `complete` and `serializeRequest` into runTurnLoop from
// @bentway/core, plus `computeAnthropicTotalCostUsd` as the cost function.
```

The package also exports `accumulateAnthropicStream` (the pure SSE folder)
and `convertRuntimeToolsToAnthropicTools` for downstream reuse and testing.

## License

Apache-2.0
