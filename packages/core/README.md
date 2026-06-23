# @bentway/core

Runtime-agnostic execution kernel for LLM agents: turn loop, neutral
transcript, tool-call dispatch, and provider-agnostic stop/retry semantics.

Part of [Bentway](https://github.com/bentway-dev/bentway), a runtime-agnostic
agent execution kernel.

## Install

```
npm install @bentway/core
```

Pair with one or more provider ports:

```
npm install @bentway/anthropic @bentway/openai @bentway/llama
```

## Usage

The package has seven entry points; import only what you need.

```js
import { runTurnLoop } from '@bentway/core/turn-loop';
import * as transcript from '@bentway/core/transcript';
import { executeFunctionCall } from '@bentway/core/tool-exec';
import * as events from '@bentway/core/events';
import { accumulateUsage } from '@bentway/core/usage';
import { normalizeStopReason, STOP_REASONS } from '@bentway/core/normalize/stop-reason';
import { isRetryableApiError } from '@bentway/core/normalize/retryable';

import { streamJsonSink } from '@bentway/stream-json';

const exitCode = await runTurnLoop({
  model: 'claude-opus-4-8',
  prompt: 'do the task',
  runtimeTools: { tools: [], executors: new Map() },
  // The loop emits neutral events (see @bentway/core/events) to `emitter`.
  // Wire a sink to project them to a concrete wire format — here, the
  // stream-json line-delimited JSON projection.
  emitter: streamJsonSink((line) => process.stdout.write(line)),
  provider: 'anthropic',
  // ...plus the host's complete() port, serializeRequest closure,
  // cost-computer, and policy hooks. See AGENTS.md for the full ctx shape.
});
```

The owned `Transcript` is the conversation's single source of truth.
Provider adapters serialize it to a wire shape and parse the response back:

```js
import { serializeForAnthropic, deserializeFromOpenAI } from '@bentway/core/transcript';
```

## License

Apache-2.0
