import type { AiSummary, McpEvent } from "@vedhaai/mcpwatch";
import type { EventRepository } from "../data/event-repository.js";
import type { ProjectRepository } from "../data/project-repository.js";
import type { GuardConfig, GuardEvents, Stored } from "../models/api.js";
import type { Project } from "../models/project.js";
import type { AiService } from "./ai-service.js";

// What the guards use: they authenticate with the project key, poll for settings and report events.
export class AgentService {
  constructor(private projects: ProjectRepository, private events: EventRepository, private ai: AiService) {}

  projectForKey(key: string | undefined): Project | undefined {
    return this.projects.byKey(key ?? "");
  }

  // Fetching settings also marks the project as connected.
  config(p: Project): GuardConfig {
    this.seen(p);
    return {
      version: p.version,
      policy: {
        mode: p.mode, window_seconds: p.windowSeconds, throttle_at: p.throttleAt, block_at: p.blockAt, deny_tools: p.denyTools,
        allowed_origins: p.allowedOrigins, require_auth: p.requireAuth, expected_audience: p.expectedAudience, ...this.ai.guardSettings(p.ai),
      },
      clients: { block: p.clients.block, throttle: [], allow: p.clients.allow },
    };
  }

  // Up to 1000 events per batch; anything that isn't an MCP event is dropped.
  report(p: Project, body: GuardEvents): Stored {
    const items = Array.isArray(body.events) ? body.events.slice(0, 1000) : [];
    const events = items.map((e) => toMcpEvent(e as Record<string, unknown>)).filter((e): e is McpEvent => !!e);
    this.events.append(p.id, events);
    this.seen(p);
    return { ok: true, stored: events.length };
  }

  private seen(p: Project) {
    this.projects.update(p.id, { lastSeenAt: new Date().toISOString() });
  }
}

// What a guard sends: hw.event/1 with the full MCP event under `mcp`.
function toMcpEvent(raw: Record<string, unknown>): McpEvent | null {
  const e = raw?.mcp as McpEvent | undefined;
  if (!e || typeof e !== "object" || typeof e.method !== "string" || !Array.isArray(e.findings)) return null;
  return {
    time: String(e.time ?? new Date().toISOString()), server: String(e.server ?? "").slice(0, 300),
    session: String(e.session ?? "").slice(0, 100), client: String(e.client ?? "").slice(0, 100),
    clientName: String(e.clientName ?? e.client ?? "").slice(0, 100),
    direction: e.direction === "server->client" || e.direction === "local" ? e.direction : "client->server", method: e.method.slice(0, 60),
    tool: e.tool ? String(e.tool).slice(0, 100) : undefined, id: e.id, mode: String(e.mode ?? ""), action: e.action,
    enforceAction: e.enforceAction, clientRule: e.clientRule, score: Number(e.score) || 0,
    findings: e.findings.slice(0, 30), snippet: e.snippet ? String(e.snippet).slice(0, 600) : undefined, ai: aiSummary(e.ai),
  };
}

function aiSummary(a: unknown): AiSummary | undefined {
  if (!a || typeof a !== "object") return undefined;
  const s = a as Record<string, unknown>;
  const verdict = (["allow", "suspicious", "block", "error"] as const).find((v) => v === s.verdict);
  if (!verdict) return undefined;
  return { model: String(s.model ?? "").slice(0, 100), verdict, ms: Number(s.ms) || 0, cached: s.cached === true || undefined,
    error: s.error ? String(s.error).slice(0, 300) : undefined };
}
