// The provider-neutral Transcript: the owned source of truth for a session's
// conversation history. Content blocks are a typed union — text | tool_use |
// tool_result | reasoning — authored in a neutral shape that derives from
// no provider's wire format. Each provider adapter serializes this neutral
// shape to its own wire format and parses it back; the stream-json event
// log is a separate projection (see @bentway/stream-json).
//
// This module owns the neutral block/message constructors, immutable
// `appendMessage`, and the OpenAI + llama + Anthropic serialize/deserialize
// boundaries — the only place provider wire format lives. Reasoning blocks
// carry an opaque, provider-tagged payload that is stored and replayed
// verbatim; this module never synthesizes, parses, or mutates one.
//
// Imports nothing host-specific and nothing beyond node:*.

// ─── Block & message constructors ─────────────────────────────────────

/**
 * @param {string} value
 * @param {string} [phase]  OPTIONAL OpenAI Responses assistant `phase`
 *   (commentary | final_answer). Captured from the response item only when the
 *   provider emits it and replayed verbatim; NEVER fabricated. Non-assistant
 *   text and other providers omit it.
 * @returns {{ type: 'text', text: string, phase?: string }}
 */
export function text(value, phase) {
  const block = { type: 'text', text: value };
  if (phase !== undefined) block.phase = phase;
  return block;
}

/** @returns {{ type: 'tool_use', id: string, name: string, input: Record<string, unknown> }} */
export function toolUse(id, name, input) {
  return { type: 'tool_use', id, name, input: input ?? {} };
}

/**
 * @param {string} toolUseId  matches the originating tool_use block's id
 * @param {string | Array<object>} content
 * @param {{ isError?: boolean }} [opts]
 */
export function toolResult(toolUseId, content, opts = {}) {
  const block = { type: 'tool_result', tool_use_id: toolUseId, content };
  if (opts.isError === true) block.is_error = true;
  return block;
}

/**
 * A provider's reasoning artifact for a turn. `provider` is an opaque
 * routing tag (which adapter must consume it) and `payload` is an opaque,
 * replayable string — never interpreted outside its serializer/deserializer.
 *
 * @param {string} provider  adapter tag (e.g. 'openai', 'llama', 'anthropic')
 * @param {string} payload   replayable blob, stored verbatim
 */
export function reasoning(provider, payload) {
  return { type: 'reasoning', provider, payload };
}

/**
 * @param {'system'|'user'|'assistant'} role
 * @param {Array<object>} content  neutral content blocks
 */
export function message(role, content) {
  return { role, content };
}

/** @param {Array<object>} [messages] */
export function createTranscript(messages = []) {
  return { messages: [...messages] };
}

/**
 * Append a message, returning a NEW transcript (the input is never mutated).
 * @param {{ messages: Array<object> }} transcript
 * @param {{ role: string, content: Array<object> }} msg
 */
export function appendMessage(transcript, msg) {
  return { messages: [...transcript.messages, msg] };
}

// ─── Shared helpers ───────────────────────────────────────────────────

/** Flatten neutral tool_result content to a wire string (openai output /
 *  llama tool-message content are both plain strings). */
function toolResultToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && block.type === 'text' ? block.text : JSON.stringify(block)))
      .join('');
  }
  return String(content);
}

// ─── OpenAI Responses-API serialize boundary ──────────────────────────
// Produces the full `input` array each turn. Items:
//   user/system text     → { role, content }
//   assistant text       → { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
//   tool_use             → { type: 'function_call', call_id, name, arguments }
//   tool_result          → { type: 'function_call_output', call_id, output }
//   reasoning ('openai') → the encrypted reasoning item, replayed verbatim
//                          (the payload is the JSON-encoded item)

/** @returns {Array<object>} the OpenAI Responses `input` array */
export function serializeForOpenAI(transcript) {
  const input = [];
  for (const msg of transcript.messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (msg.role === 'assistant') {
            // `phase` is emitted ONLY when the block carries one (captured from
            // the response). Placed after `content` to mirror the wire shape;
            // dropping it would make preambles read as final answers (early
            // stop) in tool-heavy GPT-5.x flows.
            input.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: block.text }],
              ...(block.phase !== undefined ? { phase: block.phase } : {}),
            });
          } else {
            input.push({ role: msg.role, content: block.text });
          }
          break;
        case 'tool_use':
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
          break;
        case 'tool_result':
          input.push({
            type: 'function_call_output',
            call_id: block.tool_use_id,
            output: toolResultToString(block.content),
          });
          break;
        case 'reasoning':
          // Opaque replay: the payload IS the encrypted reasoning item,
          // carried back verbatim. JSON.parse here is the adapter rehydrating
          // its own wire item.
          input.push(JSON.parse(block.payload));
          break;
        default:
          throw new Error(`serializeForOpenAI: unknown block type "${block.type}"`);
      }
    }
  }
  return input;
}

/** Inverse of serializeForOpenAI. Consecutive assistant-side items
 *  (reasoning/message/function_call) regroup into one assistant message;
 *  consecutive function_call_output items regroup into one user message of
 *  tool_result blocks (the canonical neutral batching). */
export function deserializeFromOpenAI(input) {
  const messages = [];
  let assistant = null;
  let toolResults = null;

  const flushAssistant = () => {
    if (assistant) {
      messages.push(assistant);
      assistant = null;
    }
  };
  const flushToolResults = () => {
    if (toolResults) {
      messages.push(toolResults);
      toolResults = null;
    }
  };
  const openAssistant = () => {
    flushToolResults();
    if (!assistant) assistant = { role: 'assistant', content: [] };
    return assistant;
  };
  const openToolResults = () => {
    flushAssistant();
    if (!toolResults) toolResults = { role: 'user', content: [] };
    return toolResults;
  };

  for (const item of input) {
    if (item.type === 'function_call') {
      openAssistant().content.push(
        toolUse(item.call_id, item.name, JSON.parse(item.arguments)),
      );
    } else if (item.type === 'reasoning') {
      openAssistant().content.push(reasoning('openai', JSON.stringify(item)));
    } else if (item.type === 'message' && item.role === 'assistant') {
      const part = (item.content || []).find((c) => c.type === 'output_text');
      // Preserve `phase` across the round-trip (undefined when the item omits it).
      openAssistant().content.push(text(part ? part.text : '', item.phase));
    } else if (item.type === 'function_call_output') {
      openToolResults().content.push(toolResult(item.call_id, item.output));
    } else if (item.role === 'user' || item.role === 'system') {
      flushAssistant();
      flushToolResults();
      messages.push({ role: item.role, content: [text(item.content)] });
    } else {
      throw new Error(`deserializeFromOpenAI: unrecognized input item ${JSON.stringify(item)}`);
    }
  }
  flushAssistant();
  flushToolResults();
  return { messages };
}

// ─── llama.cpp Chat-Completions serialize boundary ────────────────────
// /v1/chat/completions message array. An assistant turn bundles its text,
// reasoning_content, and tool_calls into ONE message; tool results are
// separate { role: 'tool', tool_call_id, content } messages.

/** @returns {Array<object>} the llama Chat-Completions `messages` array */
export function serializeForLlama(transcript) {
  const messages = [];
  for (const msg of transcript.messages) {
    if (msg.role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      let reasoningContent;
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            textParts.push(block.text);
            break;
          case 'reasoning':
            reasoningContent = block.payload;
            break;
          case 'tool_use':
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
            });
            break;
          default:
            throw new Error(`serializeForLlama: unexpected ${block.type} block in assistant message`);
        }
      }
      const out = { role: 'assistant', content: textParts.join('') };
      if (reasoningContent !== undefined) out.reasoning_content = reasoningContent;
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      messages.push(out);
    } else {
      // user / system: text → role message; tool_result → tool message
      for (const block of msg.content) {
        if (block.type === 'text') {
          messages.push({ role: msg.role, content: block.text });
        } else if (block.type === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultToString(block.content),
          });
        } else {
          throw new Error(`serializeForLlama: unexpected ${block.type} block in ${msg.role} message`);
        }
      }
    }
  }
  return messages;
}

/** Inverse of serializeForLlama. Consecutive tool messages regroup into one
 *  user message of tool_result blocks (canonical neutral batching). */
export function deserializeFromLlama(input) {
  const messages = [];
  let toolResults = null;
  const flushToolResults = () => {
    if (toolResults) {
      messages.push(toolResults);
      toolResults = null;
    }
  };

  for (const msg of input) {
    if (msg.role === 'tool') {
      if (!toolResults) toolResults = { role: 'user', content: [] };
      toolResults.content.push(toolResult(msg.tool_call_id, msg.content));
      continue;
    }
    flushToolResults();
    if (msg.role === 'assistant') {
      const content = [];
      if (msg.reasoning_content !== undefined) {
        content.push(reasoning('llama', msg.reasoning_content));
      }
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        content.push(text(msg.content));
      }
      for (const tc of msg.tool_calls || []) {
        content.push(toolUse(tc.id, tc.function.name, JSON.parse(tc.function.arguments)));
      }
      messages.push({ role: 'assistant', content });
    } else {
      // system / user text
      messages.push({ role: msg.role, content: [text(msg.content)] });
    }
  }
  flushToolResults();
  return { messages };
}

// ─── Anthropic /v1/messages serialize boundary ────────────────────────
// Produces the `messages` array. Roles are user | assistant only — the
// system prompt and tool declarations are top-level request params the host
// adds in its `serializeRequest`. The wrapper request body is therefore
// `{ model, max_tokens, system, tools, messages: serializeForAnthropic(t) }`.
//
// Content-block mapping:
//   text        → { type: 'text', text }
//   tool_use    → { type: 'tool_use', id, name, input }
//                 (input is the object, not a JSON string — Anthropic differs
//                 from OpenAI here)
//   tool_result → { type: 'tool_result', tool_use_id, content, is_error? }
//   reasoning   → JSON.parse(block.payload) verbatim (the payload IS the
//                 Anthropic thinking / redacted_thinking item, signature and
//                 all)
//
// THE CRITICAL RULE: within an assistant message, reasoning (thinking /
// redacted_thinking) block(s) MUST come first in the content array, or
// /v1/messages returns a 400 signature-verification error. This serializer
// hoists reasoning to the front defensively so order is guaranteed
// regardless of how the neutral message was assembled.

/** @returns {Array<object>} the Anthropic /v1/messages `messages` array */
export function serializeForAnthropic(transcript) {
  const messages = [];
  for (const msg of transcript.messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      throw new Error(
        `serializeForAnthropic: unexpected message role "${msg.role}" — /v1/messages takes only `
        + 'user/assistant; the system prompt is a top-level param supplied host-side',
      );
    }
    if (msg.role === 'assistant') {
      // Reasoning hoisted FIRST (the signature rule); text/tool_use keep their
      // captured relative order after it.
      const reasoningBlocks = [];
      const rest = [];
      for (const block of msg.content) {
        switch (block.type) {
          case 'reasoning':
            reasoningBlocks.push(JSON.parse(block.payload));
            break;
          case 'text':
            rest.push({ type: 'text', text: block.text });
            break;
          case 'tool_use':
            rest.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
            break;
          default:
            throw new Error(`serializeForAnthropic: unexpected ${block.type} block in assistant message`);
        }
      }
      messages.push({ role: 'assistant', content: [...reasoningBlocks, ...rest] });
    } else {
      const content = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_result') {
          content.push({
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: toolResultToString(block.content),
            ...(block.is_error === true ? { is_error: true } : {}),
          });
        } else {
          throw new Error(`serializeForAnthropic: unexpected ${block.type} block in user message`);
        }
      }
      messages.push({ role: 'user', content });
    }
  }
  return messages;
}
