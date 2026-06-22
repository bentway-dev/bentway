import { serializeForAnthropic } from '@bentway/core/transcript';

/**
 * Convert a runtimeTools handle into the Anthropic /v1/messages `tools`
 * array: `[{ name, description, input_schema }]`. The runtimeTools shape
 * is `{ name, description, parameters }`; Anthropic's `input_schema` is
 * the JSON Schema directly (no `{ function: … }` envelope).
 *
 * Liberal in its input: accepts a runtimeTools object (`{ tools }`) or a
 * bare tools array. Nameless entries are dropped (the API rejects them).
 *
 * @param {{ tools?: object[] } | object[]} runtimeTools
 * @returns {Array<{ name: string, description?: string, input_schema: object }>}
 */
export function convertRuntimeToolsToAnthropicTools(runtimeTools) {
  const list = Array.isArray(runtimeTools) ? runtimeTools : (runtimeTools?.tools ?? []);
  return list
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name.length > 0)
    .map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    }));
}

/**
 * Build the Anthropic `serializeRequest` closure — the request-shape seam
 * injected into `runTurnLoop`. Captures per-session config and returns
 * `({ shadowTranscript }) → { apiKey, baseUrl, body }` where the body is
 * the /v1/messages request.
 *
 * Anthropic is stateless: `messages` carries the FULL transcript each
 * turn, so `previousResponseId` and `input` are unused. `system` is the
 * session system prompt (a top-level request param, not a transcript
 * message).
 *
 * Prompt caching: a static-prefix `cache_control: { type: 'ephemeral' }`
 * marker is stamped on the system prompt and on the last tool (one
 * breakpoint covers all preceding tools), plus a moving breakpoint on
 * the last content block of the last message. Three breakpoints total
 * (cap of 4); a fourth could be added as a leapfrog history breakpoint.
 *
 * The optional `thinking` and `output_config` args come from
 * `selectThinkingConfig()`. Pass both or omit both — see thinking-config.mjs
 * for the per-model contract.
 *
 * `temperature` and `tool_choice` are intentionally left unset so the API
 * defaults apply (extended-thinking rejects non-default temperature, and
 * Opus 4.6+ has deprecated the temperature knob).
 *
 * @param {{ apiKey: string, baseUrl: string, model: string, max_tokens: number,
 *   system?: string, runtimeTools: { tools?: object[] },
 *   thinking?: object, output_config?: object }} cfg
 * @returns {(args: { shadowTranscript: object }) => { apiKey: string, baseUrl: string, body: object }}
 */
export function makeAnthropicSerializeRequest({ apiKey, baseUrl, model, max_tokens, system, runtimeTools, thinking, output_config }) {
  const tools = convertRuntimeToolsToAnthropicTools(runtimeTools);
  // Static-prefix caching:
  //   - system: promote string → [{ type:'text', text, cache_control:{type:'ephemeral'} }].
  //     Anthropic accepts system as a string or an array of text blocks;
  //     the array form carries cache_control. Absent system → no systemParam.
  //   - tools: stamp cache_control on the LAST tool (one breakpoint covers
  //     all preceding tools in canonical order).
  // Default ephemeral TTL (5 min).
  const systemParam = system
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : undefined;
  const cachedTools = tools.length > 0
    ? tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))
    : tools;
  return ({ shadowTranscript }) => {
    // serializeForAnthropic produces transcript messages without any
    // cache_control — caching is the host's policy choice, applied here.
    const messages = serializeForAnthropic(shadowTranscript);
    // Moving breakpoint on the last content block of the last message —
    // the longest stable prefix per turn. The Transcript is append-only,
    // so turn N's tail becomes the cached prefix on turn N+1. Clones the
    // message and block before stamping so no shared structure is mutated.
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (Array.isArray(last.content) && last.content.length > 0) {
        const i = last.content.length - 1;
        const stamped = { ...last.content[i], cache_control: { type: 'ephemeral' } };
        messages[messages.length - 1] = { ...last, content: [...last.content.slice(0, i), stamped] };
      }
    }
    return {
      apiKey,
      baseUrl,
      body: {
        model,
        max_tokens,
        ...(systemParam ? { system: systemParam } : {}),
        messages,
        ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
        ...(thinking ? { thinking } : {}),
        ...(output_config ? { output_config } : {}),
        stream: true,
      },
    };
  };
}
