import type { Mode } from "@vedhaai/mcpwatch";

export type ProjectKind = "middleware" | "middleware-python" | "middleware-java" | "proxy-stdio" | "proxy-http";
export type AiProvider = "off" | "local" | "api";

export interface Project {
  id: string;
  // The dashboard user who owns it. Projects from before accounts existed go to the first user.
  ownerId?: string;
  name: string;
  kind: ProjectKind;
  key: string;
  mode: Mode;
  windowSeconds: number;
  throttleAt: number;
  blockAt: number;
  denyTools: string[];
  clients: ClientLists;
  // Transport rules (HTTP servers): allowed web origins, required auth, expected token audience.
  allowedOrigins: string[];
  requireAuth: boolean;
  expectedAudience: string;
  // Who reviews each message on top of the pattern rules: nobody (rules only), a local model, or a
  // model behind an API key. The guard calls the model itself; the dashboard only hands it these settings.
  ai: ProjectAi;
  version: number;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface ClientLists {
  block: string[];
  allow: string[];
}

export interface ProjectAi {
  provider: AiProvider;
  // OpenAI-compatible base URL and model. Empty for "local" means Ollama with qwen2.5:7b.
  url: string;
  model: string;
  // Only for "api". Stored here and sent to the project's guards; never sent back to the browser.
  apiKey: string;
}

export const LOCAL_AI = { url: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" };
export const AI_OFF: ProjectAi = { provider: "off", url: "", model: "", apiKey: "" };
