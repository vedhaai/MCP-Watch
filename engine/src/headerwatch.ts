import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Engine } from "./engine.js";
import { EventLog, type EventSink, type McpEvent } from "./events.js";
import { isTrustedUrl } from "./patterns.js";
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

// The project key travels in a header and settings come back in the body, so the link must not be
// readable or changeable on the way: https, or plain http only to this machine.
// Whether the guard may talk to this dashboard with a project key. Says why not, once.
export function serverIsSafe(server: string): boolean {
  if (isTrustedUrl(server)) return true;
  warn(`not reporting to ${server}: the project key would cross the network unprotected. Use https:// or a loopback address`);
  return false;
}

// The project key from, in order: an explicit value, a file (--project-key-file, MCPWATCH_PROJECT_KEY_FILE),
// MCPWATCH_PROJECT_KEY. A file keeps the key out of the process listing and the environment.
export function projectKey(explicit?: string, file?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (explicit) return explicit;
  const path = file ?? env.MCPWATCH_PROJECT_KEY_FILE;
  if (path) {
    try {
      const key = readFileSync(path, "utf8").trim();
      if (key) return key;
    } catch (e) {
      warn(`could not read the project key file ${path}: ${errorMessage(e)}`);
    }
  }
  return env.MCPWATCH_PROJECT_KEY || undefined;
}

export function buildSinks(policy: Policy, r: Reporting): EventSink[] {
  const sinks: EventSink[] = [];
  const reporting = !!r.key && serverIsSafe(r.server ?? DEFAULT_SERVER);
  if (r.localLog ?? !reporting) sinks.push(new EventLog(policy.eventsFile));
  if (reporting) sinks.push(new HeaderwatchSink(r.server ?? DEFAULT_SERVER, r.key!));
  return sinks;
}

// With a project key, the project's mode, thresholds and client lists apply to the engine live.
// Guard failures go to the dashboard too, so it can say the engine is having trouble.
export function followProject(engine: Engine, r: Reporting) {
  if (!r.key || !serverIsSafe(r.server ?? DEFAULT_SERVER)) return;
  pollConfig(r.server ?? DEFAULT_SERVER, r.key, (update) => engine.updatePolicy(update), r.pollMs);
  reportFailures(r.server ?? DEFAULT_SERVER, r.key, engine, r.pollMs);
}

// Every `intervalMs`, if any check threw since the last report, tells the dashboard how many did.
// Nothing is sent while the engine is healthy.
export function reportFailures(server: string, key: string, engine: Engine, intervalMs = 5000) {
  const url = `${server.replace(/\/+$/, "")}/api/agent/health`;
  let sending = false;
  const send = async () => {
    if (sending) return;
    const { errors, failOpen } = engine.takeFailures();
    if (!errors) return;
    sending = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { [KEY_HEADER]: key, "Content-Type": "application/json" },
        body: JSON.stringify({ errors, fail_open: failOpen }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
    } catch (e) {
      engine.restoreFailures(errors);
      warn(`could not report guard errors to the dashboard: ${errorMessage(e)}`);
    } finally {
      sending = false;
    }
  };
  setInterval(send, intervalMs).unref();
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
  // A number from the network must be a sane one: a zero or negative threshold would block or allow everything.
  const positive = (k: string) => {
    const n = num(k);
    return n !== undefined && Number.isFinite(n) && n > 0 && n <= 1_000_000 ? n : undefined;
  };
  const windowSeconds = positive("window_seconds");
  const throttleAt = positive("throttle_at");
  const blockAt = positive("block_at");
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
    // The model endpoint receives the text of every reviewed message, and its key is sent along. A setting
    // from the network may only point at this machine or an https address, never plain HTTP elsewhere.
    const urlOk = typeof p.ai_url === "string" && p.ai_url !== "" && isTrustedUrl(p.ai_url);
    if (typeof p.ai_url === "string" && p.ai_url) {
      if (urlOk) out.ai.url = p.ai_url;
      else warn(`ignored AI endpoint ${p.ai_url} from the dashboard: use https:// or a loopback address`);
    }
    if (typeof p.ai_model === "string" && p.ai_model) out.ai.model = p.ai_model;
    if (typeof p.ai_key === "string" && (urlOk || !p.ai_url)) out.ai.apiKey = p.ai_key;
    if (typeof p.ai_timeout_ms === "number" && p.ai_timeout_ms > 0 && p.ai_timeout_ms <= 120_000) out.ai.timeoutMs = p.ai_timeout_ms;
    // The project's decision to let message text go to a model elsewhere. Older dashboards send nothing: the guard's own setting stays.
    if (typeof p.ai_allow_hosted === "boolean") out.ai.allowHosted = p.ai_allow_hosted;
  }
  if (cfg.clients) out.clients = { block: cfg.clients.block ?? [], allow: cfg.clients.allow ?? [] };
  return out;
}

export const SIGNATURE_HEADER = "x-mcpwatch-signature";

// The dashboard signs its settings with the project key (HMAC-SHA256 over the exact body). Anything else
// that answers on that port doesn't have the key, so it can't hand the guard settings of its own.
// Once a signed answer has been seen, unsigned ones are refused, and so are older versions (a replay).
// MCPWATCH_REQUIRE_SIGNED=1 refuses unsigned settings from the start. A Headerwatch server doesn't sign,
// so by default the first answer may be unsigned.
export class SettingsVerifier {
  private signedSeen = false;
  private version = -1;

  constructor(private key: string, private requireSigned = process.env.MCPWATCH_REQUIRE_SIGNED === "1") {}

  // The parsed settings, or an error saying why they are refused.
  verify(body: string, signature: string | null): ServerConfig {
    if (signature) {
      const want = Buffer.from(createHmac("sha256", this.key).update(body).digest("hex"));
      const got = Buffer.from(signature);
      if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("settings signature is wrong; ignored");
      this.signedSeen = true;
    } else if (this.signedSeen || this.requireSigned) {
      throw new Error("unsigned settings refused");
    }
    const cfg = JSON.parse(body) as ServerConfig & { version?: unknown };
    if (signature && typeof cfg.version === "number") {
      if (cfg.version < this.version) throw new Error("older settings than already applied; ignored");
      this.version = cfg.version;
    }
    return cfg;
  }
}

// Fetches the project's settings now and then every `intervalMs`; a failed fetch keeps the last settings.
export function pollConfig(server: string, key: string, apply: (update: PolicyOverrides) => void, intervalMs = 5000) {
  const url = `${server.replace(/\/+$/, "")}/api/agent/config`;
  const verifier = new SettingsVerifier(key);
  const refresh = async () => {
    try {
      const res = await fetch(url, { headers: { [KEY_HEADER]: key }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      apply(policyFromConfig(verifier.verify(await res.text(), res.headers.get(SIGNATURE_HEADER))));
    } catch (e) {
      warn(`could not fetch settings from the Headerwatch server: ${errorMessage(e)}`);
    }
  };
  void refresh();
  setInterval(refresh, intervalMs).unref();
}
