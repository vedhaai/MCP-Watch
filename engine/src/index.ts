export { mcpwatch, type McpWatchOptions, type McpWatchHandle } from "./middleware.js";
export { Engine } from "./engine.js";
export { CATALOG, RULES } from "./catalog.js";
export { DEFAULT_POLICY, HOME, type Mode, type Policy } from "./policy.js";
export type { AiFailure, AiSummary, McpEvent } from "./events.js";
// Used by the dashboard (@vedhaai/mcpwatch-dashboard) to test a project's AI settings.
export { AiReviewer, isHostedAi, type AiStats } from "./ai.js";
