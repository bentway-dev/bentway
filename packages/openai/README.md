# @bentway/openai

OpenAI Responses-API completion port for the bentway kernel.

Part of [Bentway](https://github.com/bentway-dev/bentway), a runtime-agnostic
agent execution kernel.

## Install

```
npm install @bentway/openai @bentway/core @bentway/stream-json
```

## Usage

`complete()` POSTs the /v1/responses endpoint and resolves to the neutral
`PortResult` shape the turn loop reads directly. Expected transport
failures resolve to the neutral error shape instead of throwing.

```js
import {
  complete,
  isReasoningModel,
  buildPromptCacheKey,
  makeOpenAiSerializeRequest,
  computeTotalCostUsd,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  MAX_API_RETRIES,
} from '@bentway/openai';

const reasoningConfig = isReasoningModel('gpt-5.5')
  ? { reasoning: { effort: 'medium' } }
  : {};

const serializeRequest = makeOpenAiSerializeRequest({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: DEFAULT_BASE_URL,
  model: 'gpt-5.5',
  instructions: 'You are helpful.',
  reasoningConfig,
  promptCacheKey: buildPromptCacheKey(),
  stateless: false,
  tools: [],
});

// Inject `complete` and `serializeRequest` into runTurnLoop from
// @bentway/core, plus `computeTotalCostUsd` as the cost function.
```

## License

Apache-2.0
