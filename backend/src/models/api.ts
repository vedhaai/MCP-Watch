import type { Mode } from "@vedhaai/mcpwatch";
import type { AiProvider, ClientLists, Project, ProjectAi, ProjectKind } from "./project.js";

// What the API takes and returns. tsoa checks request bodies against these types; the services do the
// checks a type can't express (trimming, URLs, positive numbers).

export interface Credentials {
  username: string;
  password: string;
}

export interface SignedIn {
  user: { username: string } | null;
}

export interface Ok {
  ok: boolean;
}

export interface NewProject {
  name: string;
  kind?: ProjectKind;
}

// AI settings from the form. An empty `apiKey` keeps the saved key; `clearKey` removes it.
export interface AiSettingsInput {
  provider: AiProvider;
  url?: string;
  model?: string;
  apiKey?: string;
  clearKey?: boolean;
}

export interface ProjectPatch {
  name?: string;
  mode?: Mode;
  windowSeconds?: number;
  throttleAt?: number;
  blockAt?: number;
  denyTools?: string[];
  allowedOrigins?: string[];
  requireAuth?: boolean;
  expectedAudience?: string;
  ai?: AiSettingsInput;
  clients?: ClientLists;
}

// A project as the browser sees it: the AI key only as a hint that one is saved.
export interface ProjectView extends Omit<Project, "ai"> {
  ai: Omit<ProjectAi, "apiKey"> & { keySet: boolean; keyHint: string };
}

export interface AiTestResult {
  ok: boolean;
  verdict?: string;
  message?: string;
  model?: string;
  ms?: number;
  caught?: boolean;
  findings?: string[];
  error?: string;
}

// The settings a guard polls for, in the guard's own (snake_case) policy format.
export interface GuardConfig {
  version: number;
  policy: {
    mode: Mode;
    window_seconds: number;
    throttle_at: number;
    block_at: number;
    deny_tools: string[];
    allowed_origins: string[];
    require_auth: boolean;
    expected_audience: string;
    ai_review: boolean;
    ai_url?: string;
    ai_model?: string;
    ai_key?: string;
    ai_timeout_ms?: number;
  };
  clients: { block: string[]; throttle: string[]; allow: string[] };
}

export interface GuardEvents {
  events?: unknown[];
}

export interface Stored {
  ok: boolean;
  stored: number;
}

// One entry of the engine's rule catalog.
export interface Rule {
  id: string;
  title: string;
  severity: "high" | "medium" | "low";
  points: number;
  group: "tool-call" | "tool-definition" | "server-output" | "transport" | "behavior" | "supply-chain" | "ai";
}

export interface Meta {
  server: string;
  rules: Rule[];
}
