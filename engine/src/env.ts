// The guard's own secrets must not reach the server it wraps (or a server `mcpwatch scan --connect` starts):
// a malicious server could read them from its environment. Everything else is passed on, because
// servers legitimately need their own variables.
const GUARD_SECRETS = ["MCPWATCH_PROJECT_KEY", "MCPWATCH_PROJECT_KEY_FILE", "MCPWATCH_AI_KEY", "MCPWATCH_ENGINE_OPTIONS", "MCPWATCH_PINS_KEY"];

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of GUARD_SECRETS) delete out[k];
  return out;
}
