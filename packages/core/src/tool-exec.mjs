// Tool-execution dispatch: look up the executor for a model-requested tool
// call and invoke it with the decoded arguments. The host owns what goes
// into the executors map; this module owns the lookup + dispatch.
//
// Imports nothing; the executors Map is a parameter.

/**
 * Execute a single model-requested tool call against the executors map.
 *
 * @param {{ name: string, arguments?: Record<string, unknown> }} call
 * @param {Map<string, (args: Record<string, unknown>) => unknown>} executors
 * @returns {Promise<unknown>} the executor's result (string or structured)
 * @throws if no executor is registered for `call.name`
 */
export async function executeFunctionCall(call, executors) {
  const executor = executors.get(call.name);
  if (!executor) throw new Error(`Unknown tool: ${call.name}`);
  return executor(call.arguments || {});
}
