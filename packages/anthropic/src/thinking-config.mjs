// Per-model extended-thinking config registry.
//
// Anthropic exposes three thinking shapes on the /v1/messages API:
//
//   'enabled'  → body.thinking = { type: 'enabled', budget_tokens: N }
//                Caller-budgeted; supported by Sonnet 4.x.
//   'adaptive' → body.thinking = { type: 'adaptive' }
//              + body.output_config = { effort: 'low'|'medium'|'high'|'xhigh'|'max' }
//                Model auto-sizes; required by Opus 4.x (Opus rejects the
//                'enabled' shape with a 400).
//   'disabled' → omit body.thinking entirely
//                For families without extended thinking (e.g. Haiku 4.5).
//
// An unknown model resolves to 'disabled' (safe default — the session
// works, just without thinking). Add an entry below when extending the
// registry; mismatches surface as 400s from the API.
const ANTHROPIC_THINKING_SHAPES = Object.freeze({
  'claude-sonnet-4-6': Object.freeze({ shape: 'enabled' }),
  'claude-opus-4-7':   Object.freeze({ shape: 'adaptive', effort: 'high' }),
  'claude-opus-4-8':   Object.freeze({ shape: 'adaptive', effort: 'high' }),
  'claude-haiku-4-5':  Object.freeze({ shape: 'disabled' }),
});

const VALID_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const VALID_DISPLAYS = Object.freeze(['summarized', 'omitted']);

/**
 * Select the request's `thinking` (+ optional `output_config`) configuration
 * for a given model. Pure — derives the result from the model, max_tokens,
 * and env. Returns an object meant to be merged into the request body;
 * `{}` means "omit both fields entirely".
 *
 * Dated model ids (`claude-opus-4-8-20260101`, etc.) are normalized to the
 * bare id before the registry lookup. Unknown models default to disabled.
 *
 * Env overrides:
 *   - `ANTHROPIC_THINKING_BUDGET_TOKENS=0`  hard-disables thinking across
 *     all shapes (operator escape hatch).
 *   - `ANTHROPIC_THINKING_BUDGET_TOKENS=<N>` overrides the default budget
 *     for enabled-shape; ignored for adaptive-shape (no budget).
 *   - `ANTHROPIC_THINKING_EFFORT=low|medium|high|xhigh|max` overrides the
 *     registry default effort for adaptive-shape; ignored for enabled-shape.
 *   - `ANTHROPIC_THINKING_DISPLAY=omitted` redacts thinking text in the
 *     response (signature is preserved for multi-turn continuity). Adaptive
 *     only; the field is omitted from the body when unset so the API's
 *     'summarized' default applies.
 *
 * @param {{ model: string, max_tokens: number, env?: NodeJS.ProcessEnv }} args
 * @returns {{ thinking?: object, output_config?: object }}
 */
export function selectThinkingConfig({ model, max_tokens, env = process.env }) {
  const baseModel = typeof model === 'string' ? model.replace(/-\d{8}$/, '') : model;
  const entry = ANTHROPIC_THINKING_SHAPES[baseModel] ?? { shape: 'disabled' };

  // Hard-disable escape hatch. Parsed before the shape dispatch so a zero
  // override works regardless of registry entry.
  const rawBudget = env.ANTHROPIC_THINKING_BUDGET_TOKENS;
  const envBudget = rawBudget !== undefined && rawBudget !== '' ? parseInt(rawBudget, 10) : NaN;
  if (envBudget === 0) return {};

  if (entry.shape === 'disabled') return {};

  if (entry.shape === 'enabled') {
    const defaultBudget = Math.max(1024, Math.floor(max_tokens / 2));
    const budget_tokens = Number.isFinite(envBudget) && envBudget > 0 ? envBudget : defaultBudget;
    if (budget_tokens < 1024 || budget_tokens >= max_tokens) return {};
    return { thinking: { type: 'enabled', budget_tokens } };
  }

  if (entry.shape === 'adaptive') {
    // Adaptive omits budget_tokens — the API rejects it with a 400. The
    // model auto-sizes; `output_config.effort` is the only knob.
    const envEffort = env.ANTHROPIC_THINKING_EFFORT;
    const effort = VALID_EFFORTS.includes(envEffort) ? envEffort : (entry.effort ?? 'high');
    // Privacy variant: `display: 'omitted'` redacts thinking text in the
    // response (signature still preserved for replay). The field is left
    // off the body when unset so the API's 'summarized' default applies.
    const envDisplay = env.ANTHROPIC_THINKING_DISPLAY;
    const display = VALID_DISPLAYS.includes(envDisplay) ? envDisplay : undefined;
    return {
      thinking: { type: 'adaptive', ...(display === 'omitted' ? { display: 'omitted' } : {}) },
      output_config: { effort },
    };
  }
  return {};
}
