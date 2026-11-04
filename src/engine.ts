import { AiReviewer, combine, type ReviewInput } from "./ai.js";
import { RULES } from "./catalog.js";
import { EventLog, type Action, type AiSummary, type EventSink, type McpEvent } from "./events.js";
import { CONFIDENTIAL_LABEL, HIDDEN_CHARS, redactSecrets } from "./patterns.js";
import { Pins } from "./pins.js";
import type { Policy, PolicyOverrides } from "./policy.js";
import path from "node:path";
import { Registry } from "./registry.js";
import {
  capabilities, checkArgs, checkElicitation, checkServerText, checkShadowing, checkToolCall, checkToolDefinition, finding,
  strings, type Finding, type ToolDef,
} from "./rules.js";
import { Session } from "./state.js";
import { checkTransport, credentialLeak, redactCredential, type HttpInfo } from "./transport.js";

// Loose JSON-RPC message shape; the guard must cope with anything on the wire.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Msg = Record<string, any>;

export interface Outcome {
  // Message to pass on to the other side (possibly modified), or null to drop it.
  forward: Msg | null;
  // Message to send back to the side it came from (e.g. a JSON-RPC error for a blocked call).
  reply: Msg | null;
}

export const BLOCKED = -32001;
export const THROTTLED = -32002;

const isRequest = (m: Msg) => typeof m.method === "string" && m.id !== undefined;
const isResponse = (m: Msg) => m.method === undefined && m.id !== undefined;

function errorReply(id: unknown, code: number, message: string, findings: Finding[]): Msg {
  return { jsonrpc: "2.0", id, error: { code, message, data: { rules: findings.map((f) => f.rule) } } };
}

function titles(findings: Finding[]): string {
  const ids = [...new Set(findings.filter((f) => f.severity === "high").map((f) => f.rule))];
  const list = ids.length ? ids : [...new Set(findings.map((f) => f.rule))];
  return list.map((id) => `${id} ${RULES[id].title}`).join("; ");
}

const snippet = (value: unknown) => {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return redactSecrets(s).slice(0, 300);
};

// Deep-map every string in a JSON value.
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

export class Engine {
  private sessions = new Map<string, Session>();
  private pins: Pins;
  private sinks: EventSink[];
  private registry: Registry;
  private reviewer: AiReviewer;

  constructor(private policy: Policy, private serverKey: string, sinks?: EventSink[]) {
    this.pins = new Pins(policy.pinsFile, serverKey);
    this.registry = new Registry(policy.registryFile ?? path.join(path.dirname(policy.pinsFile), "registry.json"));
    this.sinks = sinks ?? [new EventLog(policy.eventsFile)];
    this.reviewer = new AiReviewer(policy);
    this.reviewer.warmUp();
  }

  get mode() {
    return this.policy.mode;
  }

  // Before the process exits: send queued events, giving up after `timeoutMs`.
  async flush(timeoutMs = 3000) {
    const all = Promise.all(this.sinks.map((s) => s.flush?.()));
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  // Applies settings fetched at runtime (mode, thresholds, client lists). Sessions share this object.
  updatePolicy(update: PolicyOverrides) {
    const ai = update.ai ? { ...this.policy.ai, ...update.ai } : this.policy.ai;
    Object.assign(this.policy, update, { ai });
    this.reviewer.warmUp();
  }

  // The AI reviewer's findings join the pattern findings. It can add, never remove: a rule the
  // patterns already raised isn't repeated, unless the AI rates it more severe. Returns undefined
  // when the reviewer is off.
  private async review(s: Session, findings: Finding[], input: ReviewInput, where?: string): Promise<AiSummary | undefined> {
    if (!this.reviewer.enabled) return undefined;
    // The caller's own token never goes to the model either.
    const content = s.credential ? mapStrings(input.content, (t) => redactCredential(t, s)) : input.content;
    const { findings: extra, summary } = await this.reviewer.review({ ...input, content });
    const rank = { low: 0, medium: 1, high: 2 };
    const covered = (f: Finding) => findings.some((p) => p.rule === f.rule && rank[p.severity] >= rank[f.severity]);
    findings.push(...extra.filter((f) => !covered(f)).map((f) => (where ? { ...f, where } : f)));
    return summary;
  }

  // A person's decision about a client outranks the rules, as in Headerwatch.
  private clientRule(s: Session): "block" | "allow" | undefined {
    const ids = [s.clientName, s.client, s.id];
    if (ids.some((id) => this.policy.clients.block.includes(id))) return "block";
    if (ids.some((id) => this.policy.clients.allow.includes(id))) return "allow";
    return undefined;
  }

  session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) this.sessions.set(id, (s = new Session(id, this.policy)));
    return s;
  }

  dropSession(id: string) {
    this.sessions.delete(id);
  }

  // HTTP: the session id only exists after initialize, so the state gathered before it moves over.
  renameSession(from: string, to: string) {
    const s = this.sessions.get(from);
    if (!s || this.sessions.has(to)) return;
    this.sessions.delete(from);
    s.id = to;
    this.sessions.set(to, s);
  }

  private emit(s: Session, e: Omit<McpEvent, "time" | "server" | "session" | "client" | "clientName" | "score" | "mode">) {
    // The caller's own token never goes into an event, whatever carried it.
    if (s.credential) {
      e = { ...e, snippet: e.snippet && redactCredential(e.snippet, s), findings: e.findings.map((f) => ({ ...f, detail: redactCredential(f.detail, s) })) };
    }
    const event: McpEvent = {
      time: new Date().toISOString(), server: this.serverKey, session: s.id, client: s.client, clientName: s.clientName,
      score: s.score(),
      mode: this.policy.mode, ...e,
    };
    for (const sink of this.sinks) sink.write(event);
  }

  // The action for a client request, in the current mode, plus what enforce would do.
  private decide(s: Session, findings: Finding[]): { action: Action; enforceAction: Action; clientRule?: "block" | "allow" } {
    const high = findings.some((f) => f.severity === "high");
    // High findings block on their own; the rest build up the session score.
    s.addPoints(findings.filter((f) => f.severity !== "high").reduce((n, f) => n + f.points, 0));
    const score = s.score();
    let enforceAction: Action = high || score >= this.policy.blockAt ? "block" : score >= this.policy.throttleAt ? "throttle" : "allow";
    let action: Action =
      this.policy.mode === "observe" ? "allow" : this.policy.mode === "protect" ? (high ? "block" : "allow") : enforceAction;
    const clientRule = this.clientRule(s);
    if (clientRule) action = enforceAction = clientRule;
    if (action === "block") s.noteBlocked();
    return { action, enforceAction, clientRule };
  }

  // For server output the guard can only withhold or clean it, so protect and enforce act the same.
  private act(enforceAction: Action): Action {
    return this.policy.mode === "observe" ? "allow" : enforceAction;
  }

  // ---- client -> server ----

  // `http` describes the request that carried the message; without it (stdio) the transport rules don't run.
  async fromClient(sessionId: string, msg: Msg, http?: HttpInfo): Promise<Outcome> {
    if (this.policy.mode === "off") return { forward: msg, reply: null };
    const s = this.session(sessionId);
    if (isResponse(msg)) {
      s.pendingFromServer.delete(msg.id);
      return { forward: msg, reply: null };
    }
    if (!isRequest(msg)) return { forward: msg, reply: null };

    const method: string = msg.method;
    const params = msg.params ?? {};
    let tool: string | undefined;
    const findings: Finding[] = http ? checkTransport(http, s, this.policy) : [];

    if (method === "initialize") {
      const info = params.clientInfo ?? {};
      const name = String(info.name ?? "unknown");
      // Only where a session really is one client: stdio, or an HTTP request carrying an MCP session id.
      // Stateless HTTP requests share buckets, so a different name there is just another client.
      const pinned = !http || !!http.headers["mcp-session-id"];
      if (pinned && s.clientName !== "unknown" && name !== s.clientName) {
        findings.push(finding("MW035", `Session started as "${s.clientName}", now claims to be "${name}"`, "params.clientInfo"));
      }
      s.clientName = name;
      s.client = `${name} ${info.version ?? ""}`.trim();
    } else if (method === "tools/call") {
      tool = String(params.name ?? "");
      findings.push(...checkToolCall(tool, params.arguments, s.tools, this.policy));
      if (credentialLeak(JSON.stringify(params.arguments ?? {}), s)) {
        findings.push(finding("MW032", "The caller's own credential is being passed to a tool", "args"));
      }
      if (s.rugPulled.has(tool)) {
        findings.push(finding("MW024", `"${tool}" changed after it was pinned; calls are refused until re-approved`));
      }
      findings.push(...s.checkBehavior(tool, params.arguments));
      for (const [where, value] of strings(params.arguments)) {
        const from = this.registry.leakSource(this.serverKey, value);
        if (from) {
          findings.push(finding("MB006", `Sensitive output of "${from}" is being sent to "${tool}"`, where));
          break;
        }
      }
    } else if (method === "resources/read") {
      findings.push(...checkArgs({ uri: params.uri }, this.policy, "params"));
    } else if (method === "prompts/get") {
      findings.push(...checkArgs(params.arguments ?? {}, this.policy));
    }

    let ai: AiSummary | undefined;
    if (method === "tools/call") {
      const content = { tool, description: s.tools?.get(tool!)?.description?.slice(0, 500), arguments: params.arguments ?? {} };
      ai = await this.review(s, findings, { kind: "tool-call", label: `tools/call ${tool}`, content });
    } else if (method === "resources/read") {
      ai = await this.review(s, findings, { kind: "tool-call", label: "resources/read", content: { uri: params.uri } });
    } else if (method === "prompts/get") {
      ai = await this.review(s, findings, { kind: "tool-call", label: `prompts/get ${params.name}`, content: { prompt: params.name, arguments: params.arguments ?? {} } });
    }

    const { action, enforceAction, clientRule } = this.decide(s, findings);
    const quiet = method === "ping" || method === "tools/list" || method === "resources/list" || method === "prompts/list";
    if (!quiet || findings.length) {
      this.emit(s, {
        direction: "client->server", method, tool, id: msg.id, action, enforceAction, findings, clientRule, ai,
        snippet: method === "tools/call" ? snippet(params.arguments) : method === "initialize" ? s.client : snippet(params),
      });
    }

    if (action === "block") {
      const why = clientRule === "block" ? "this client is blocked" : titles(findings);
      return { forward: null, reply: errorReply(msg.id, BLOCKED, `Blocked by MCPWatch: ${why}`, findings) };
    }
    if (action === "throttle") {
      return {
        forward: null,
        reply: errorReply(msg.id, THROTTLED, `Rate limited by MCPWatch (session score ${s.score()}): ${titles(findings)}`, findings),
      };
    }
    s.pendingFromClient.set(msg.id, { method, tool, t: Date.now() });
    return { forward: msg, reply: null };
  }

  // HTTP requests without a JSON-RPC body (the GET event stream, DELETE to end a session) only go
  // through the transport rules. Returns true when the request should be refused.
  fromHttp(sessionId: string, http: HttpInfo, method: string): boolean {
    if (this.policy.mode === "off") return false;
    const s = this.session(sessionId);
    const findings = checkTransport(http, s, this.policy);
    if (!findings.length) return false;
    const { action, enforceAction, clientRule } = this.decide(s, findings);
    this.emit(s, { direction: "client->server", method: `http ${method}`, action, enforceAction, findings, clientRule });
    return action === "block" || action === "throttle";
  }

  // HTTP proxy: an SSE event id relayed to the client on this session.
  noteEventId(sessionId: string, id: string) {
    const s = this.session(sessionId);
    if (s.eventIds.size >= 5000) s.eventIds.delete(s.eventIds.values().next().value!);
    s.eventIds.add(id);
  }

  // ---- server -> client ----

  // `strict`: the message came over the network on an established session (HTTP proxy), so a
  // response to a request the client never sent is forged or replayed (MW037).
  async fromServer(sessionId: string, msg: Msg, strict = false): Promise<Outcome> {
    if (this.policy.mode === "off") return { forward: msg, reply: null };
    const s = this.session(sessionId);
    if (isRequest(msg)) return this.serverRequest(s, msg);
    if (!isResponse(msg)) {
      if (msg.method === "notifications/tools/list_changed") {
        this.emit(s, { direction: "server->client", method: msg.method, action: "allow", enforceAction: "allow", findings: [] });
      }
      return { forward: msg, reply: null };
    }

    const pending = s.pendingFromClient.get(msg.id);
    s.pendingFromClient.delete(msg.id);
    if (!pending && strict) {
      const findings = [finding("MW037", `Response to request id ${JSON.stringify(msg.id)}, which the client never sent or already got`)];
      const action = this.act("block");
      this.emit(s, { direction: "server->client", method: "response", id: msg.id, action, enforceAction: "block", findings });
      return { forward: action === "block" ? null : msg, reply: null };
    }
    if (!pending || msg.error || !msg.result) return { forward: msg, reply: null };

    // MW023: a response too big for the client's context.
    const size = JSON.stringify(msg.result).length;
    if (size > this.policy.maxResultBytes) {
      const findings = [finding("MW023", `${pending.method} result is ${size} bytes (limit ${this.policy.maxResultBytes})`)];
      const action = this.act("block");
      this.emit(s, { direction: "server->client", method: pending.method, tool: pending.tool, id: msg.id, action, enforceAction: "block", findings });
      if (action === "block") {
        return { forward: { jsonrpc: "2.0", id: msg.id, error: { code: BLOCKED, message: `Withheld by MCPWatch: ${titles(findings)}` } }, reply: null };
      }
    }

    switch (pending.method) {
      case "initialize":
        return { forward: this.initialized(s, msg), reply: null };
      case "tools/list":
        return { forward: await this.toolsList(s, msg), reply: null };
      case "tools/call":
        return { forward: await this.serverContent(s, msg, pending.method, pending.tool, ["content", "structuredContent"]), reply: null };
      case "resources/read":
        return { forward: await this.serverContent(s, msg, pending.method, undefined, ["contents"]), reply: null };
      case "prompts/get":
        return { forward: await this.serverContent(s, msg, pending.method, undefined, ["messages", "description"]), reply: null };
      default:
        return { forward: msg, reply: null };
    }
  }

  // MW038: the server now reports a different name or version than the one pinned for it.
  private initialized(s: Session, msg: Msg): Msg {
    const pin = this.pins.checkServer(msg.result.serverInfo ?? {});
    if (pin.status === "changed") {
      const findings = [finding("MW038", `Server was ${pin.was}, is now ${pin.now}; review the update`, "result.serverInfo")];
      this.emit(s, { direction: "server->client", method: "initialize", id: msg.id, action: "allow", enforceAction: "allow", findings, snippet: pin.now });
    }
    return msg;
  }

  private async toolsList(s: Session, msg: Msg): Promise<Msg> {
    const tools: ToolDef[] = Array.isArray(msg.result.tools) ? msg.result.tools : [];
    const kept: ToolDef[] = [];
    const all: Finding[] = [];
    let stripped = 0;
    let cleaned = 0;

    // Other servers on this machine (from the shared registry), for collisions and shadowing.
    const foreign = this.registry.otherTools(this.serverKey);
    const own = new Set(tools.map((t) => t.name));
    this.registry.recordTools(this.serverKey, [...own]);

    const perTool = tools.map((tool) => {
      const findings = checkToolDefinition(tool);
      if (foreign.has(tool.name)) {
        findings.push(finding("MW027", `"${tool.name}" is also offered by ${foreign.get(tool.name)!.join(", ")}`, `tool.${tool.name}`));
      }
      findings.push(...checkShadowing(tool, foreign, own));
      if (this.pins.check(tool) === "changed") {
        findings.push(finding("MW024", `"${tool.name}" no longer matches its pinned definition`, `tool.${tool.name}`));
        s.rugPulled.add(tool.name);
      }
      return findings;
    });
    // Each definition is reviewed once per change: the reviewer caches by content.
    const reviews = await Promise.all(tools.map((tool, i) => this.review(s, perTool[i], {
      kind: "tool-definition", label: `tool definition "${tool.name}"`,
      content: { name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} },
    }, `tool.${tool.name}`)));
    const ai = combine(reviews.filter((r): r is AiSummary => !!r));

    for (const [i, tool] of tools.entries()) {
      const findings = perTool[i];
      all.push(...findings);
      if (this.policy.mode === "observe") {
        kept.push(tool);
      } else if (findings.some((f) => f.severity === "high")) {
        stripped++;
      } else if (findings.some((f) => f.rule === "MW021")) {
        cleaned++;
        kept.push({ ...tool, description: (tool.description ?? "").replace(HIDDEN_CHARS, "") });
      } else {
        kept.push(tool);
      }
    }

    // MW039: what the tools let the model do. Reported, never blocked: the owner decides.
    const caps = capabilities(kept);
    if (caps.includes("shell") || caps.includes("payments") || caps.length >= 3) {
      all.push(finding("MW039", `Tools can: ${caps.join(", ")}. Consider denying tools you don't need`));
    }

    s.tools = new Map(kept.map((t) => [t.name, t]));
    const enforceAction: Action = all.some((f) => f.severity === "high") ? "strip" : all.some((f) => f.rule === "MW021") ? "redact" : "allow";
    this.emit(s, {
      direction: "server->client", method: "tools/list", id: msg.id, action: this.act(enforceAction), enforceAction, findings: all, ai,
      snippet: tools.map((t) => t.name).join(", ") + (stripped ? ` (removed ${stripped})` : "") + (cleaned ? ` (cleaned ${cleaned})` : ""),
    });
    return this.policy.mode === "observe" ? msg : { ...msg, result: { ...msg.result, tools: kept } };
  }

  // Tool results, resource contents and prompt messages: withhold injections, redact secrets.
  private async serverContent(s: Session, msg: Msg, method: string, tool: string | undefined, keys: string[]): Promise<Msg> {
    const findings: Finding[] = [];
    let secrets = false;
    let first = "";
    const texts: string[] = [];
    for (const key of keys) {
      if (msg.result[key] === undefined) continue;
      const start = texts.length;
      mapStrings(msg.result[key], (t) => (texts.push(t), t));
      for (const t of texts.slice(start)) {
        first ||= t;
        const r = checkServerText(t, `result.${key}`);
        findings.push(...r.findings);
        secrets ||= r.secrets;
        if (credentialLeak(t, s) && !findings.some((f) => f.rule === "MW032")) {
          findings.push(finding("MW032", "Server output contains the caller's own credential", `result.${key}`));
        }
      }
    }
    if (secrets) s.taint();
    // Remember sensitive output, so another server's guard notices it leaving through its tools (MB006).
    if (secrets || texts.some((t) => CONFIDENTIAL_LABEL.test(t))) this.registry.recordSensitive(this.serverKey, texts);
    const ai = texts.length
      ? await this.review(s, findings, { kind: "server-output", label: `${method} result${tool ? ` of ${tool}` : ""}`, content: texts.join("\n---\n") })
      : undefined;

    const enforceAction: Action = findings.some((f) => f.severity === "high") ? "block" : secrets ? "redact" : "allow";
    const action = this.act(enforceAction);
    this.emit(s, { direction: "server->client", method, tool, id: msg.id, action, enforceAction, findings, ai, snippet: snippet(first) });

    if (action === "block") {
      const text = `[MCPWatch] This ${method === "tools/call" ? "tool result" : "content"} was withheld: ${titles(findings)}`;
      const result = method === "tools/call" ? { content: [{ type: "text", text }], isError: true }
        : method === "resources/read" ? { contents: [{ uri: msg.result.contents?.[0]?.uri ?? "", text }] }
        : { messages: [{ role: "user", content: { type: "text", text } }] };
      return { ...msg, result };
    }
    if (action === "redact") {
      const result = { ...msg.result };
      for (const key of keys) if (result[key] !== undefined) result[key] = mapStrings(result[key], (t) => redactCredential(redactSecrets(t), s));
      return { ...msg, result };
    }
    return msg;
  }

  // Requests the server sends to the client: sampling, elicitation, roots.
  private async serverRequest(s: Session, msg: Msg): Promise<Outcome> {
    const method: string = msg.method;
    if (method === "elicitation/create") return this.elicitation(s, msg);
    if (method !== "sampling/createMessage") {
      s.pendingFromServer.set(msg.id, { method, t: Date.now() });
      return { forward: msg, reply: null };
    }
    const findings: Finding[] = [finding("MW026", "Server requested a model completion")];
    const texts: string[] = [];
    mapStrings({ m: msg.params?.messages, s: msg.params?.systemPrompt }, (t) => (texts.push(t), t));
    for (const t of texts) findings.push(...checkServerText(t, "params.messages").findings);
    const ai = await this.review(s, findings, { kind: "server-output", label: "sampling request", content: texts.join("\n---\n") });

    const enforceAction: Action = findings.some((f) => f.severity === "high") ? "block" : "allow";
    const action = this.act(enforceAction);
    this.emit(s, { direction: "server->client", method, id: msg.id, action, enforceAction, findings, ai, snippet: snippet(texts[0] ?? "") });
    if (action === "block") {
      return { forward: null, reply: errorReply(msg.id, BLOCKED, `Blocked by MCPWatch: ${titles(findings)}`, findings) };
    }
    s.pendingFromServer.set(msg.id, { method, t: Date.now() });
    return { forward: msg, reply: null };
  }

  // MW029: a form or link asking the user for passwords, keys or payment details is refused.
  private async elicitation(s: Session, msg: Msg): Promise<Outcome> {
    const findings = checkElicitation(msg.params ?? {});
    const ai = await this.review(s, findings, { kind: "server-output", label: "elicitation request", content: msg.params ?? {} });
    const enforceAction: Action = findings.some((f) => f.severity === "high") ? "block" : "allow";
    const action = this.act(enforceAction);
    this.emit(s, {
      direction: "server->client", method: msg.method, id: msg.id, action, enforceAction, findings, ai, snippet: snippet(msg.params?.message ?? ""),
    });
    if (action === "block") {
      return { forward: null, reply: errorReply(msg.id, BLOCKED, `Blocked by MCPWatch: ${titles(findings)}`, findings) };
    }
    s.pendingFromServer.set(msg.id, { method: msg.method, t: Date.now() });
    return { forward: msg, reply: null };
  }
}
