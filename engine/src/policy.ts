import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Mode = "off" | "observe" | "protect" | "enforce";

export interface Policy {
  // off: pass everything through, record nothing.
  // observe: never block, record what enforce would do.
  // protect: block high-severity findings only.
  // enforce: block high-severity findings, then throttle / block by session score.
  mode: Mode;
  windowSeconds: number;
  throttleAt: number;
  blockAt: number;
  maxCallsPerWindow: number;
  enumerationThreshold: number;
  replayThreshold: number;
  maxArgBytes: number;
  maxArgDepth: number;
  // Server responses larger than this (bytes) are withheld (MW023).
  maxResultBytes: number;
  // If non-empty, only these tools may be called.
  allowTools: string[];
  denyTools: string[];
  // A person's decisions, by client name (e.g. "cursor") or session id. They outrank the rules.
  clients: { block: string[]; allow: string[] };
  // HTTP only. Web origins allowed to call the server (e.g. "https://app.example.com"); other
  // browser origins are refused, which stops DNS rebinding. Loopback origins are always allowed.
  allowedOrigins: string[];
  // Host names the server answers to. Empty: not checked (loopback names are always allowed).
  allowedHosts: string[];
  // Refuse HTTP requests that carry no Authorization or X-API-Key header.
  requireAuth: boolean;
  // If set, a JWT bearer token whose "aud" doesn't include it is refused.
  expectedAudience: string;
  // What to do when the guard itself throws on a message. false (the default): refuse the request with
  // -32001, so a payload that crashes a check can't slip through. true: forward it unchecked.
  // Notifications and responses carry no id to answer, so they pass either way.
  failOpen: boolean;
  // HTTP proxy: the largest request body (bytes) it will read, and the longest it waits for the upstream.
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
  // Most calls to the AI reviewer in flight at once; more are answered as "reviewer busy".
  aiMaxConcurrent: number;
  // Most sessions one guard keeps in memory; the least recently used are dropped first.
  maxSessions: number;
  // Never pin a tool that isn't pinned already: a new tool is refused like a changed one (MW024). Learn the
  // tools in a normal run first. Default false: the first definition seen is trusted.
  strictPins: boolean;
  eventsFile: string;
  pinsFile: string;
  // Shared by every guard on this machine: tool names per server (MW027, MW028) and fingerprints of
  // sensitive output (MB006). Default: registry.json next to the pins file.
  registryFile?: string;
  // AI reviewer: a local model reviews every message against the rules, on top of the pattern checks.
  ai: AiPolicy;
}

// Settings given by the caller, a policy file or the dashboard: any subset, the AI ones too.
export type PolicyOverrides = Partial<Omit<Policy, "ai">> & { ai?: Partial<AiPolicy> };

export interface AiPolicy {
  enabled: boolean;
  // OpenAI-compatible base URL: Ollama (default), LM Studio, llama.cpp server, vLLM…
  url: string;
  model: string;
  // Only for servers that want one; local runtimes usually don't.
  apiKey?: string;
  timeoutMs: number;
  // AI findings below this confidence count one severity lower.
  minConfidence: number;
  // "block": a high AI finding blocks like a rule does. "advise": AI findings are capped at medium,
  // so they add to the session score but never block a message on their own.
  authority: "block" | "advise";
  // Block when the model can't be reached (MA002). Default: fall back to the rules alone.
  required: boolean;
  // Longest text sent to the model per message; the rest is cut.
  maxChars: number;
  // Price in US dollars per million tokens, to put a cost on each review. 0 = free (a local model).
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  // Daily caps (UTC day). Once one is reached the reviewer stops calling the model until the next day
  // and the rules alone decide (or MA002 fires when `required`). 0 = no cap.
  maxTokensPerDay: number;
  maxCostPerDay: number;
  // Circuit breaker: after this many model failures in a row the reviewer stops calling the model for
  // `circuitCooldownMs`, so a model that is down costs one timeout, not one per message. Then one
  // review goes through as a probe; if it works the breaker closes. 0 = never stop.
  circuitFailures: number;
  circuitCooldownMs: number;
  // A model on another machine (a hosted API, or a server elsewhere on the network) sees the text of
  // every reviewed message. It is only used when this is true. Such a model also gets personal data
  // masked on top of secrets (emails, card numbers, user names in paths) and at most `hostedMaxChars`.
  // A model on this machine (loopback) needs neither.
  allowHosted: boolean;
  hostedMaxChars: number;
  // With authority "block", only a model that has passed `mcpwatch ai` (recorded in `verifiedFile`) may
  // block on its own; an unchecked model's findings are capped at medium, as in "advise", and add to the
  // session score. Off by default, so existing setups keep blocking.
  requireVerified: boolean;
  verifiedFile: string;
}

export const HOME = path.join(os.homedir(), ".mcpwatch");

export const DEFAULT_POLICY: Policy = {
  mode: "enforce",
  windowSeconds: 60,
  throttleAt: 3,
  blockAt: 6,
  maxCallsPerWindow: 30,
  enumerationThreshold: 8,
  replayThreshold: 5,
  maxArgBytes: 100_000,
  maxArgDepth: 20,
  maxResultBytes: 5_000_000,
  allowTools: [],
  denyTools: [],
  clients: { block: [], allow: [] },
  allowedOrigins: [],
  allowedHosts: [],
  requireAuth: false,
  expectedAudience: "",
  failOpen: false,
  strictPins: false,
  maxBodyBytes: 10_000_000,
  upstreamTimeoutMs: 60_000,
  aiMaxConcurrent: 8,
  maxSessions: 10_000,
  eventsFile: path.join(HOME, "events.jsonl"),
  pinsFile: path.join(HOME, "pins.json"),
  ai: {
    enabled: false,
    url: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    timeoutMs: 8000,
    minConfidence: 0.6,
    authority: "block",
    required: false,
    maxChars: 6000,
    inputPricePerMTok: 0,
    outputPricePerMTok: 0,
    maxTokensPerDay: 0,
    maxCostPerDay: 0,
    circuitFailures: 3,
    circuitCooldownMs: 30_000,
    allowHosted: false,
    hostedMaxChars: 3000,
    requireVerified: false,
    verifiedFile: path.join(HOME, "ai-verified.json"),
  },
};

// AI settings from the environment: MCPWATCH_AI=1 turns the reviewer on.
export function aiFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<AiPolicy> {
  const out: Partial<AiPolicy> = {};
  if (env.MCPWATCH_AI) out.enabled = env.MCPWATCH_AI === "1";
  if (env.MCPWATCH_AI_URL) out.url = env.MCPWATCH_AI_URL;
  if (env.MCPWATCH_AI_MODEL) out.model = env.MCPWATCH_AI_MODEL;
  if (env.MCPWATCH_AI_KEY) out.apiKey = env.MCPWATCH_AI_KEY;
  if (env.MCPWATCH_AI_TIMEOUT_MS) out.timeoutMs = Number(env.MCPWATCH_AI_TIMEOUT_MS);
  if (env.MCPWATCH_AI_AUTHORITY === "block" || env.MCPWATCH_AI_AUTHORITY === "advise") out.authority = env.MCPWATCH_AI_AUTHORITY;
  if (env.MCPWATCH_AI_REQUIRED) out.required = env.MCPWATCH_AI_REQUIRED === "1";
  const num = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
  out.inputPricePerMTok = num(env.MCPWATCH_AI_INPUT_PRICE);
  out.outputPricePerMTok = num(env.MCPWATCH_AI_OUTPUT_PRICE);
  out.maxTokensPerDay = num(env.MCPWATCH_AI_MAX_TOKENS_PER_DAY);
  out.maxCostPerDay = num(env.MCPWATCH_AI_MAX_COST_PER_DAY);
  out.circuitFailures = num(env.MCPWATCH_AI_CIRCUIT_FAILURES);
  out.circuitCooldownMs = num(env.MCPWATCH_AI_CIRCUIT_COOLDOWN_MS);
  out.hostedMaxChars = num(env.MCPWATCH_AI_HOSTED_MAX_CHARS);
  if (env.MCPWATCH_AI_ALLOW_HOSTED) out.allowHosted = env.MCPWATCH_AI_ALLOW_HOSTED === "1";
  if (env.MCPWATCH_AI_REQUIRE_VERIFIED) out.requireVerified = env.MCPWATCH_AI_REQUIRE_VERIFIED === "1";
  if (env.MCPWATCH_AI_VERIFIED_FILE) out.verifiedFile = env.MCPWATCH_AI_VERIFIED_FILE;
  for (const k of Object.keys(out) as (keyof AiPolicy)[]) if (out[k] === undefined) delete out[k];
  return out;
}

// The guard's environment variables (MCPWATCH_MODE, MCPWATCH_ALLOWED_ORIGINS, …), under the caller's
// own options: a setting the caller gave is kept.
export function withEnv(overrides: PolicyOverrides, env: NodeJS.ProcessEnv = process.env): PolicyOverrides {
  const out = { ...overrides };
  if (!out.mode && env.MCPWATCH_MODE) out.mode = env.MCPWATCH_MODE as Mode;
  if (!out.eventsFile && env.MCPWATCH_EVENTS) out.eventsFile = env.MCPWATCH_EVENTS;
  if (!out.pinsFile && env.MCPWATCH_PINS) out.pinsFile = env.MCPWATCH_PINS;
  if (out.strictPins === undefined && env.MCPWATCH_STRICT_PINS) out.strictPins = env.MCPWATCH_STRICT_PINS === "1";
  const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  out.allowedOrigins ??= list(env.MCPWATCH_ALLOWED_ORIGINS);
  out.allowedHosts ??= list(env.MCPWATCH_ALLOWED_HOSTS);
  if (out.requireAuth === undefined && env.MCPWATCH_REQUIRE_AUTH) out.requireAuth = env.MCPWATCH_REQUIRE_AUTH === "1";
  out.expectedAudience ??= env.MCPWATCH_AUDIENCE;
  out.ai = { ...aiFromEnv(env), ...out.ai };
  for (const k of Object.keys(out) as (keyof Policy)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export function loadPolicy(configFile: string | undefined, overrides: PolicyOverrides): Policy {
  let fromFile: PolicyOverrides = {};
  if (configFile) fromFile = JSON.parse(readFileSync(configFile, "utf8"));
  // Fresh clients and ai objects per policy, so runtime updates never touch DEFAULT_POLICY.
  const defined = <T extends object>(o: T = {} as T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const ai = { ...DEFAULT_POLICY.ai, ...defined(fromFile.ai), ...defined(overrides.ai) } as AiPolicy;
  const policy: Policy = { ...DEFAULT_POLICY, clients: { block: [], allow: [] }, ...fromFile, ...overrides, ai };
  if (!["block", "advise"].includes(policy.ai.authority)) {
    throw new Error(`Unknown AI authority "${policy.ai.authority}" (use block or advise)`);
  }
  for (const k of ["inputPricePerMTok", "outputPricePerMTok", "maxTokensPerDay", "maxCostPerDay", "circuitFailures", "circuitCooldownMs"] as const) {
    if (typeof policy.ai[k] !== "number" || !Number.isFinite(policy.ai[k]) || policy.ai[k] < 0) {
      throw new Error(`AI setting "${k}" must be zero or a positive number`);
    }
  }
  if (typeof policy.ai.hostedMaxChars !== "number" || !(policy.ai.hostedMaxChars > 0)) {
    throw new Error(`AI setting "hostedMaxChars" must be a positive number`);
  }
  if (!["off", "observe", "protect", "enforce"].includes(policy.mode)) {
    throw new Error(`Unknown mode "${policy.mode}" (use off, observe, protect or enforce)`);
  }
  for (const k of ["windowSeconds", "throttleAt", "blockAt", "maxCallsPerWindow", "maxArgBytes", "maxArgDepth", "maxResultBytes",
    "maxBodyBytes", "upstreamTimeoutMs", "aiMaxConcurrent", "maxSessions"] as const) {
    if (typeof policy[k] !== "number" || !Number.isFinite(policy[k]) || policy[k] <= 0) {
      throw new Error(`Setting "${k}" must be a positive number`);
    }
  }
  return policy;
}
