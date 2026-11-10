import { createHmac } from "node:crypto";
import type { AiSummary, McpEvent } from "@vedhaai/mcpwatch";
import type { EventRepository } from "../data/event-repository.js";
import type { ProjectRepository } from "../data/project-repository.js";
import type { GuardConfig, GuardEvents, GuardHealth, Ok, Stored } from "../models/api.js";
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

  // HMAC-SHA256 over the exact JSON the guard will receive, keyed with the project key. A guard checks it, so
  // something else answering on this port can't hand it settings (turn the mode off, point the AI at itself).
  sign(config: GuardConfig, key: string): string {
    return createHmac("sha256", key).update(JSON.stringify(config)).digest("hex");
  }

  // Up to 1000 events per batch; anything that isn't an MCP event is dropped.
  report(p: Project, body: GuardEvents): Stored {
    const items = Array.isArray(body.events) ? body.events.slice(0, 1000) : [];
    const events = items.map((e) => toMcpEvent(e as Record<string, unknown>)).filter((e): e is McpEvent => !!e);
    this.events.append(p.id, events);
    this.seen(p);
    return { ok: true, stored: events.length };
  }

  // A report with no failures is ignored; the warning clears on its own once reports stop.
  health(p: Project, body: GuardHealth): Ok {
    const errors = Math.min(Math.max(0, Math.trunc(Number(body.errors) || 0)), 1_000_000);
    const at = new Date().toISOString();
    if (errors) this.projects.update(p.id, { engineIssue: { at, errors, failOpen: body.fail_open !== false }, lastSeenAt: at });
    return { ok: true };
  }

  private seen(p: Project) {
    this.projects.update(p.id, { lastSeenAt: new Date().toISOString() });
  }
}

// The engine exports McpEvent but not the finding type inside it, which is the one shape here that
// needs naming.
type Finding = McpEvent["findings"][number];

const ACTIONS = ["allow", "block", "throttle", "redact", "strip"] as const;
const SEVERITIES = ["high", "medium", "low"] as const;

// A value only counts if it is one of the strings the dashboard knows how to render.
function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.find((a) => a === value) ?? fallback;
}

// Objects and arrays become "" rather than "[object Object]": a guard that sends one of those for a
// name is sending nonsense, and the dashboard should not display it as if it meant something.
function text(value: unknown, max: number): string {
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, max);
  return "";
}

function int(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// Findings arrive as whatever the guard put in the array, and the dashboard renders every one of
// them. Anything that isn't an object is dropped; an object is coerced into a renderable finding
// rather than discarded, so a real detection is never lost to a bad field.
function toFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const where = text(f.where, 200);
  return {
    rule: text(f.rule, 40) || "unknown",
    severity: oneOf(SEVERITIES, f.severity, "low"),
    points: int(f.points, 0),
    detail: text(f.detail, 300),
    ...(where ? { where } : {}),
    ...(f.source === "ai" ? { source: "ai" as const } : {}),
  };
}

// What a guard sends: hw.event/1 with the full MCP event under `mcp`.
function toMcpEvent(raw: Record<string, unknown>): McpEvent | null {
  const e = raw?.mcp as Record<string, unknown> | undefined;
  if (!e || typeof e !== "object" || typeof e.method !== "string" || !Array.isArray(e.findings)) return null;
  const id = typeof e.id === "number" && Number.isFinite(e.id) ? e.id : typeof e.id === "string" ? e.id.slice(0, 100) : undefined;
  return {
    time: text(e.time, 40) || new Date().toISOString(), server: text(e.server, 300),
    session: text(e.session, 100), client: text(e.client, 100),
    clientName: text(e.clientName, 100) || text(e.client, 100),
    direction: oneOf(["client->server", "server->client", "local"] as const, e.direction, "client->server"), method: e.method.slice(0, 60),
    tool: text(e.tool, 100) || undefined, id, mode: text(e.mode, 40), action: oneOf(ACTIONS, e.action, "allow"),
    enforceAction: oneOf(ACTIONS, e.enforceAction, "allow"),
    clientRule: e.clientRule === "block" || e.clientRule === "allow" ? e.clientRule : undefined, score: int(e.score, 0),
    findings: e.findings.slice(0, 30).map(toFinding).filter((f): f is Finding => !!f),
    snippet: text(e.snippet, 600) || undefined, ai: aiSummary(e.ai),
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
