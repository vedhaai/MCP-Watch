import { randomBytes } from "node:crypto";
import type { Engine } from "./engine.js";
import { EventLog, type EventSink, type McpEvent } from "./events.js";
import type { Mode, Policy, PolicyOverrides } from "./policy.js";

// Talks to a dashboard server with a project key: the MCPWatch dashboard (`mcpwatch dashboard`) or a
// Headerwatch server. Both use the same agent API: events are POSTed in batches to /api/agent/events,
// settings are polled from /api/agent/config.

const KEY_HEADER = "X-Headerwatch-Key";
export const DEFAULT_SERVER = "http://127.0.0.1:9100";

export interface Reporting {
  // Project key; without one, events only go to the local events file.
  key?: string;
  server?: string;
  // Also write the local events file. Default: only when there is no project key.
  localLog?: boolean;
  pollMs?: number;
}

export function buildSinks(policy: Policy, r: Reporting): EventSink[] {
  const sinks: EventSink[] = [];
  if (r.localLog ?? !r.key) sinks.push(new EventLog(policy.eventsFile));
  if (r.key) sinks.push(new HeaderwatchSink(r.server ?? DEFAULT_SERVER, r.key));
  return sinks;
}

// With a project key, the project's mode, thresholds and client lists apply to the engine live.
export function followProject(engine: Engine, r: Reporting) {
  if (r.key) pollConfig(r.server ?? DEFAULT_SERVER, r.key, (update) => engine.updatePolicy(update), r.pollMs);
}

let lastWarning = 0;
function warn(message: string) {
  if (Date.now() - lastWarning > 60_000) {
    lastWarning = Date.now();
    console.error(`[mcpwatch] ${message}`);
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Short method names; the server stores at most 10 characters.
const METHODS: Record<string, string> = {
  "initialize": "INIT",
  "tools/list": "LIST",
  "tools/call": "CALL",
  "resources/read": "READ",
  "prompts/get": "PROMPT",
  "sampling/createMessage": "SAMPLING",
  "notifications/tools/list_changed": "CHANGED",
};

// An MCP event in Headerwatch's hw.event/1 shape, so it shows on the Requests page.
export function toHwEvent(e: McpEvent): Record<string, unknown> {
  const flagged = e.findings.length > 0 || e.action !== "allow";
  const arrow = e.direction === "client->server" ? "→" : "←";
  return {
    schema: "hw.event/1",
    request_id: randomBytes(8).toString("hex"),
    ts: Date.parse(e.time) / 1000,
    method: METHODS[e.method] ?? e.method.slice(0, 10),
    path: `mcp ${arrow} ${e.method}${e.tool ? ` ${e.tool}` : ""}`,
    mode: e.mode,
    action: e.action,
    status: null,
    enforce_action: e.enforceAction,
    score: e.score,
    client: e.client,
    ip: e.session,
    header_names: [],
    // Evidence for flagged messages only, already secret-redacted.
    headers: flagged ? [["mcp-direction", e.direction], ["mcp-server", e.server], ["mcp-content", e.snippet ?? ""]] : null,
    findings: e.findings.map((f) => ({ rule: f.rule, severity: f.severity, points: f.points, detail: f.where ? `${f.detail} (${f.where})` : f.detail })),
    client_rule: e.clientRule === "allow" ? "allow" : e.clientRule === "block" ? "block" : "",
    // The full MCP event, for the MCPWatch dashboard. Headerwatch ignores fields it doesn't know.
    mcp: e,
  };
}

// Queues events and sends them from a timer, so MCP messages never wait on the network.
export class HeaderwatchSink implements EventSink {
  private queue: Record<string, unknown>[] = [];
  private sending: Promise<void> | null = null;
  private readonly url: string;

  constructor(server: string, private readonly key: string, private readonly maxQueue = 5000, intervalMs = 1000) {
    this.url = `${server.replace(/\/+$/, "")}/api/agent/events`;
    setInterval(() => this.flush(), intervalMs).unref();
    // A stdio server exits as soon as its client disconnects; send what is still queued first.
    // The pending request keeps the process alive; a few tries at most, so a down server can't hold it open.
    let exitTries = 0;
    process.on("beforeExit", () => {
      if (this.queue.length && !this.sending && exitTries++ < 3) void this.flush();
    });
  }

  write(event: McpEvent) {
    if (this.queue.length >= this.maxQueue) return warn("event queue full, dropping events");
    this.queue.push(toHwEvent(event));
  }

  flush(): Promise<void> {
    if (!this.sending) this.sending = this.send().finally(() => (this.sending = null));
    return this.sending;
  }

  private async send() {
    while (this.queue.length) {
      const items = this.queue.splice(0, 200);
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { [KEY_HEADER]: this.key, "Content-Type": "application/json" },
          body: JSON.stringify({ events: items }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`server answered ${res.status}`);
      } catch (e) {
        this.queue.unshift(...items.slice(0, this.maxQueue - this.queue.length));
        warn(`could not send events to the Headerwatch server: ${errorMessage(e)}`);
        return;
      }
    }
  }
}

interface ServerConfig {
  policy?: Record<string, unknown>;
  clients?: { block?: string[]; throttle?: string[]; allow?: string[] };
}

// The part of the project's settings that applies to MCP: mode, score thresholds, client lists and
// the transport settings. A Headerwatch server sends none of the transport ones, so local values stay.
export function policyFromConfig(cfg: ServerConfig): PolicyOverrides {
  const p = cfg.policy ?? {};
  const out: PolicyOverrides = {};
  if (typeof p.mode === "string" && ["off", "observe", "protect", "enforce"].includes(p.mode)) out.mode = p.mode as Mode;
  const num = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : undefined);
  const windowSeconds = num("window_seconds");
  const throttleAt = num("throttle_at");
  const blockAt = num("block_at");
  if (windowSeconds) out.windowSeconds = windowSeconds;
  if (throttleAt) out.throttleAt = throttleAt;
  if (blockAt) out.blockAt = blockAt;
  if (Array.isArray(p.deny_tools)) out.denyTools = p.deny_tools.filter((t): t is string => typeof t === "string");
  if (Array.isArray(p.allowed_origins)) out.allowedOrigins = p.allowed_origins.filter((o): o is string => typeof o === "string");
  if (typeof p.require_auth === "boolean") out.requireAuth = p.require_auth;
  if (typeof p.expected_audience === "string") out.expectedAudience = p.expected_audience;
  if (typeof p.ai_review === "boolean") {
    out.ai = { enabled: p.ai_review };
    // The project picks the model too; without these (older dashboards, Headerwatch) the guard's own settings stay.
    if (typeof p.ai_url === "string" && p.ai_url) out.ai.url = p.ai_url;
    if (typeof p.ai_model === "string" && p.ai_model) out.ai.model = p.ai_model;
    if (typeof p.ai_key === "string") out.ai.apiKey = p.ai_key;
    if (typeof p.ai_timeout_ms === "number" && p.ai_timeout_ms > 0) out.ai.timeoutMs = p.ai_timeout_ms;
  }
  if (cfg.clients) out.clients = { block: cfg.clients.block ?? [], allow: cfg.clients.allow ?? [] };
  return out;
}

// Fetches the project's settings now and then every `intervalMs`; a failed fetch keeps the last settings.
export function pollConfig(server: string, key: string, apply: (update: PolicyOverrides) => void, intervalMs = 5000) {
  const url = `${server.replace(/\/+$/, "")}/api/agent/config`;
  const refresh = async () => {
    try {
      const res = await fetch(url, { headers: { [KEY_HEADER]: key }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      apply(policyFromConfig((await res.json()) as ServerConfig));
    } catch (e) {
      warn(`could not fetch settings from the Headerwatch server: ${errorMessage(e)}`);
    }
  };
  void refresh();
  setInterval(refresh, intervalMs).unref();
}
