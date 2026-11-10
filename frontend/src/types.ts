// What the dashboard API sends the browser. Mirrors src/events.ts, src/rules.ts and forBrowser() in src/dashboard.ts.

export type Severity = "high" | "medium" | "low";
export type Action = "allow" | "block" | "throttle" | "redact" | "strip";
export type Mode = "off" | "observe" | "protect" | "enforce";
export type ProjectKind = "middleware" | "middleware-python" | "middleware-java" | "proxy-stdio" | "proxy-http";
export type AiProvider = "off" | "local" | "api";

export interface Finding {
  rule: string;
  severity: Severity;
  points: number;
  detail: string;
  where?: string;
  source?: "ai";
}

export interface McpEvent {
  time: string;
  server: string;
  session: string;
  client: string;
  clientName: string;
  direction: "client->server" | "server->client" | "local";
  method: string;
  tool?: string;
  id?: string | number;
  mode: string;
  action: Action;
  enforceAction: Action;
  clientRule?: "block" | "allow";
  score: number;
  findings: Finding[];
  snippet?: string;
  ai?: { model: string; verdict: string; ms: number; cached?: boolean; error?: string };
}

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  key: string;
  mode: Mode;
  windowSeconds: number;
  throttleAt: number;
  blockAt: number;
  denyTools: string[];
  clients: { block: string[]; allow: string[] };
  allowedOrigins: string[];
  requireAuth: boolean;
  expectedAudience: string;
  ai: { provider: AiProvider; url: string; model: string; keySet: boolean; keyHint: string };
  version: number;
  createdAt: string;
  lastSeenAt: string | null;
  // The guard's last report that its checks were failing.
  engineIssue?: { at: string; errors: number; failOpen: boolean } | null;
}

export interface RuleInfo {
  id: string;
  title: string;
  severity: Severity;
  points: number;
  group: string;
}

export interface Meta {
  server: string;
  rules: RuleInfo[];
}

export interface User {
  username: string;
  // This account set up the dashboard, so it sees what belongs to no project (local events).
  owner: boolean;
}
