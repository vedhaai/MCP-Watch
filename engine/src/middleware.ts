import { createHash, randomUUID } from "node:crypto";
import { Engine, type Msg, type Outcome } from "./engine.js";
import { DEFAULT_SERVER, buildSinks, followProject, projectKey as resolveKey } from "./headerwatch.js";
import { loadPolicy, withEnv, type Mode, type PolicyOverrides } from "./policy.js";

// The structural parts of the SDK's Transport that the guard needs. Kept local so a server built
// against any SDK copy can be wrapped.
interface Transport {
  start(): Promise<void>;
  send(message: Msg, options?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: Msg, extra?: Extra) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}

interface Extra {
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
  [k: string]: unknown;
}

// An McpServer (has .server) or a low-level Server (has .connect).
type Connectable = { connect(transport: never): Promise<void> };
type GuardableServer = Connectable | { server: Connectable };

export interface McpWatchOptions extends PolicyOverrides {
  // false (or MCPWATCH_ENABLED=0) leaves the server untouched.
  enabled?: boolean;
  // Name used for pinned tool definitions and on the dashboard. Defaults to the server's own name.
  name?: string;
  // Dashboard server and project key. With a key, events go to that project and its mode and
  // client lists apply live. Defaults: MCPWATCH_SERVER (else the MCPWatch dashboard on :9100),
  // MCPWATCH_PROJECT_KEY. A Headerwatch server (:9000) works too.
  server?: string;
  projectKey?: string;
  // Also write events to the local events file. Default: only when there is no project key.
  localLog?: boolean;
}

export interface McpWatchHandle {
  readonly enabled: boolean;
  readonly mode: Mode;
  // Change the mode at runtime; "off" passes everything through.
  setMode(mode: Mode): void;
}

const env = process.env;

/**
 * Guards an MCP server: every message between any client and this server is checked by MCPWatch.
 * Call it once, before server.connect(transport). Clients need no changes.
 */
export function mcpwatch(server: GuardableServer, options: McpWatchOptions = {}): McpWatchHandle {
  const { enabled, name, server: hwServer, projectKey, localLog, ...overrides } = options;
  const on = enabled ?? env.MCPWATCH_ENABLED !== "0";
  if (!on) return { enabled: false, mode: "off", setMode: () => {} };

  const policy = loadPolicy(env.MCPWATCH_CONFIG, withEnv(overrides, env));
  const low = ("server" in server ? server.server : server) as Connectable & { _serverInfo?: { name?: string } };
  const serverName = name ?? low._serverInfo?.name ?? "mcp-server";

  const reporting = {
    key: resolveKey(projectKey, undefined, env),
    server: hwServer ?? env.MCPWATCH_SERVER ?? DEFAULT_SERVER,
    localLog,
    pollMs: Number(env.MCPWATCH_POLL_MS ?? 5000),
  };
  const engine = new Engine(policy, serverName, buildSinks(policy, reporting));
  followProject(engine, reporting);

  const connect = low.connect.bind(low) as (t: Transport) => Promise<void>;
  (low as { connect: (t: Transport) => Promise<void> }).connect = (transport: Transport) =>
    connect(new GuardedTransport(transport, engine, policy.failOpen));

  const ai = policy.ai.enabled ? `, AI review by ${policy.ai.model}` : "";
  console.error(`[mcpwatch] guarding "${serverName}" in ${policy.mode} mode${ai}${reporting.key ? `, reporting to ${reporting.server}` : ""}`);
  return {
    enabled: true,
    get mode() {
      return engine.mode;
    },
    setMode: (mode) => engine.updatePolicy({ mode }),
  };
}

// Sits between the SDK's protocol layer and the real transport. Messages from the client are
// checked before the server's handlers see them; messages to the client are checked before they leave.
class GuardedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: Msg, extra?: Extra) => void;
  private readonly connId = `conn-${randomUUID().slice(0, 8)}`;
  private session = this.connId;
  // Checks can wait on the AI reviewer; client messages still reach the server in the order sent.
  private inbound: Promise<void> = Promise.resolve();

  constructor(private inner: Transport, private engine: Engine, private failOpen: boolean) {
    inner.onmessage = (msg, extra) => {
      this.inbound = this.inbound.then(async () => {
        this.session = this.sessionFor(extra);
        // Streamable HTTP: the request's headers feed the transport rules (Origin, auth, session).
        const headers = extra?.requestInfo?.headers;
        const o = await this.guard(() => this.engine.fromClient(this.session, msg, headers ? { headers } : undefined), msg);
        if (o.reply) this.inner.send(o.reply, { relatedRequestId: msg.id }).catch((e) => this.onerror?.(e));
        if (o.forward) this.onmessage?.(o.forward, extra);
      });
    };
    inner.onclose = () => {
      if (this.session === this.connId || this.session.startsWith("http-session-")) this.engine.dropSession(this.session);
      this.onclose?.();
    };
    inner.onerror = (e) => this.onerror?.(e);
  }

  // stdio: one session per connection. HTTP: the MCP session id, else the caller's token, else one
  // shared bucket (stateless servers make a new transport per request).
  private sessionFor(extra?: Extra): string {
    if (this.inner.sessionId) return `http-session-${this.inner.sessionId}`;
    const headers = extra?.requestInfo?.headers;
    if (!headers) return this.connId;
    const auth = headers.authorization ?? headers["x-api-key"];
    if (auth) return `tok-${createHash("sha256").update(String(auth)).digest("hex").slice(0, 12)}`;
    return "http-anonymous";
  }

  private async guard(check: () => Promise<Outcome>, msg: Msg): Promise<Outcome> {
    try {
      return await check();
    } catch (e) {
      this.engine.noteFailure(e);
      if (this.failOpen || msg.id === undefined || msg.method === undefined) return { forward: msg, reply: null };
      return { forward: null, reply: { jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "MCPWatch failed closed" } } };
    }
  }

  get sessionId() {
    return this.inner.sessionId;
  }

  setProtocolVersion(version: string) {
    this.inner.setProtocolVersion?.(version);
  }

  start() {
    return this.inner.start();
  }

  async send(message: Msg, options?: Record<string, unknown>) {
    const o = await this.guard(() => this.engine.fromServer(this.session, message), message);
    // A reply owed to the server itself (a refused sampling request) goes back up the protocol layer.
    if (o.reply) queueMicrotask(() => this.onmessage?.(o.reply!));
    if (o.forward) await this.inner.send(o.forward, options);
  }

  close() {
    return this.inner.close();
  }
}
