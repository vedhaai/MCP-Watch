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
  // Forward a message unchanged if the guard itself fails on it.
  failOpen: boolean;
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
  failOpen: true,
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
  if (!["off", "observe", "protect", "enforce"].includes(policy.mode)) {
    throw new Error(`Unknown mode "${policy.mode}" (use off, observe, protect or enforce)`);
  }
  return policy;
}
