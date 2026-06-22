# bentway

> Runtime-agnostic agent execution kernel for LLM apps in TypeScript.

bentway runs the turn loop an LLM agent needs: request a completion, accumulate usage, dispatch tool calls, emit a stream-json event log, repeat until a terminal stop. It does this against Anthropic, OpenAI, or llama.cpp behind one neutral interface, so your agent isn't coupled to whichever provider you started with.

## Install

```bash
npm install @bentway/core @bentway/anthropic @bentway/stream-json
```

Swap or add `@bentway/openai`, `@bentway/llama` to target a different provider. The kernel is the same; only the completion port changes.

## Quick start

```typescript
import { runTurnLoop } from '@bentway/core/turn-loop';
import { complete, makeAnthropicSerializeRequest } from '@bentway/anthropic';

await runTurnLoop({
  prompt: 'Summarize the latest Anthropic release notes.',
  emitter: (line) => process.stdout.write(line),

  complete,
  serializeRequest: makeAnthropicSerializeRequest({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-opus-4-8',
    max_tokens: 4096,
    system: 'You are concise.',
    runtimeTools: { tools: [] },
  }),

  // ...plus model, provider, runtimeTools, retry constants, cost
  // function, and policy hooks. See @bentway/anthropic for a
  // complete copy-paste example.
});
```

Running it produces a line-delimited JSON stream you can pipe anywhere:

```jsonl
{"type":"system","subtype":"api_call_start","turn":1}
{"type":"system","subtype":"api_call_end","turn":1,"durationMs":523}
{"type":"system","subtype":"turn_tokens","turn":1,"prompt_tokens":128,"completion_tokens":42,"cumulative_tokens":170}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}],"stop_reason":"end_turn","usage":{...}}}
{"type":"result","subtype":"success","stop_reason":"end_turn","result":"...","total_cost_usd":0.012,...}
```

## Why bentway

**One interface, three providers.** Anthropic, OpenAI, and llama.cpp each get a small completion port. Anything else stays the same: the loop, the transcript, the stop-reason classifier, the event projection.

**You own the conversation state.** The neutral `Transcript` is the source of truth across turns. Provider adapters serialize it to wire format and parse it back. Nothing from one provider's shape leaks into another's.

**Same observability shape across providers.** Every event the loop emits is in one stream-json line shape. Pipe it to anything that reads JSONL.

**Small, no-dependency surface.** Five npm packages, zero runtime dependencies, hand-cracked `.d.mts` types verified by api-extractor. The whole kernel is under 2,000 lines of source.

**Host owns the policy.** Bare-bail intervention, tool-failure-loop detection, no-progress termination, WIP preservation: all injected. The loop never decides for you.

## Packages

| package | what it owns |
|---|---|
| [`@bentway/core`](packages/core) | turn loop, neutral `Transcript`, tool-call dispatch, stop-reason and retryable classifiers |
| [`@bentway/anthropic`](packages/anthropic) | `/v1/messages` completion port, thinking-config, pricing, request shaper |
| [`@bentway/openai`](packages/openai) | `/v1/responses` completion port, reasoning-model detection, pricing, prompt-cache-key, request shaper |
| [`@bentway/llama`](packages/llama) | OpenAI-compatible `/v1/chat/completions` port for llama.cpp and llama-server |
| [`@bentway/stream-json`](packages/stream-json) | event emitter, builders, usage accumulator, the projection itself |

Each package has its own README with a focused, runnable usage example.

## Contributing

See [AGENTS.md](AGENTS.md) for the contributor contract: house style, gate model, and the rules every change must satisfy before `pnpm test` passes.

## License

[Apache-2.0](LICENSE)
