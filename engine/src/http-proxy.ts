import { createHash } from "node:crypto";
import http from "node:http";
import { BLOCKED, Engine, type Msg, type Outcome } from "./engine.js";
import { buildSinks, followProject, type Reporting } from "./headerwatch.js";
import { isInternalHost } from "./patterns.js";
import type { Policy } from "./policy.js";
import type { HttpInfo } from "./transport.js";

// Headers that describe the hop, not the message; never copied across the proxy.
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "content-encoding", "keep-alive"]);

// Reverse proxy for Streamable HTTP: POST /mcp carries client messages; the reply is JSON or an SSE stream.
export function runHttpProxy(policy: Policy, listen: number, upstream: URL, reporting: Reporting = {}) {
  const engine = new Engine(policy, upstream.href, buildSinks(policy, reporting));
  followProject(engine, reporting);

  const insecureUpstream = upstream.protocol === "http:" && !isInternalHost(upstream.hostname);
  if (insecureUpstream) console.error(`[mcpwatch] warning: ${upstream.href} is plain HTTP on a public address (MW034)`);

  // `strict`: server messages on an established session, where an unasked-for response is forged.
  async function guard(sessionId: string, msg: Msg, from: "client" | "server", info?: HttpInfo, strict = false): Promise<Outcome> {
    try {
      return from === "client" ? await engine.fromClient(sessionId, msg, info) : await engine.fromServer(sessionId, msg, strict);
    } catch (e) {
      engine.noteFailure(e);
      if (policy.failOpen || msg.id === undefined || msg.method === undefined) return { forward: msg, reply: null };
      return { forward: null, reply: { jsonrpc: "2.0", id: msg.id, error: { code: BLOCKED, message: "MCPWatch failed closed" } } };
    }
  }

  function upstreamHeaders(req: http.IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && typeof v === "string") out[k] = v;
    return out;
  }

  // A reply the guard owes the server (e.g. a refused sampling request) goes as its own POST.
  function replyToServer(headers: Record<string, string>, msg: Msg) {
    fetch(upstream, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(msg), signal: AbortSignal.timeout(policy.upstreamTimeoutMs) })
      .catch((e) => console.error(`[mcpwatch] could not reply to server: ${e.message}`));
  }

  http.createServer(async (req, res) => {
    const headers = upstreamHeaders(req);
    // The MCP session id if there is one; else the caller's own token, so two callers behind one address
    // (a NAT, a reverse proxy) don't share a score; else the address.
    const bearer = req.headers.authorization ?? req.headers["x-api-key"];
    let sessionId = (req.headers["mcp-session-id"] as string)
      || (bearer ? `tok-${createHash("sha256").update(String(bearer)).digest("hex").slice(0, 12)}` : `http-${req.socket.remoteAddress}`);
    let body: string | undefined;
    const info: HttpInfo = {
      headers: req.headers, remoteAddress: req.socket.remoteAddress,
      encrypted: "encrypted" in req.socket && req.socket.encrypted === true, insecureUpstream,
    };

    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    res.on("close", () => abort.abort());

    try {
      if (req.method !== "POST" && engine.fromHttp(sessionId, info, req.method ?? "GET")) {
        res.writeHead(403, { "content-type": "text/plain" }).end("Refused by MCPWatch");
        return;
      }
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > policy.maxBodyBytes) {
            res.writeHead(413, { "content-type": "text/plain", connection: "close" }).end("Request too large for MCPWatch");
            req.destroy();
            return;
          }
          chunks.push(c as Buffer);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        if (parsed === undefined) {
          // Not JSON, so nothing to check message by message; the transport rules still apply.
          if (engine.fromHttp(sessionId, info, "POST")) {
            res.writeHead(403, { "content-type": "text/plain" }).end("Refused by MCPWatch");
            return;
          }
          body = raw;
        } else {
          const batch = Array.isArray(parsed);
          const msgs = (batch ? parsed : [parsed]) as Msg[];
          const outcomes: Outcome[] = [];
          for (const m of msgs) outcomes.push(await guard(sessionId, m, "client", info));
          const replies = outcomes.map((o) => o.reply).filter(Boolean) as Msg[];
          if (replies.length) {
            // Answer blocked calls ourselves. In a batch, the rest are refused too so nothing waits forever.
            const all = batch
              ? msgs.filter((m) => m.id !== undefined).map((m) => replies.find((r) => r.id === m.id)
                ?? { jsonrpc: "2.0", id: m.id, error: { code: BLOCKED, message: "Batch refused by MCPWatch" } })
              : replies;
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(batch ? all : all[0]));
            return;
          }
          const forwards = outcomes.map((o) => o.forward).filter(Boolean) as Msg[];
          body = JSON.stringify(batch ? forwards : forwards[0]);
        }
      }

      // The upstream gets `upstreamTimeoutMs` to answer (a JSON body included); a stream, once started, may run
      // as long as it likes. A client that hangs up also ends the upstream request.
      timer = setTimeout(() => abort.abort(), policy.upstreamTimeoutMs);
      const up = await fetch(upstream, { method: req.method, headers, body, signal: abort.signal });
      if ((up.headers.get("content-type") ?? "").includes("text/event-stream")) clearTimeout(timer);
      const newSession = up.headers.get("mcp-session-id");
      if (newSession && newSession !== sessionId) {
        engine.renameSession(sessionId, newSession);
        sessionId = newSession;
      }

      const outHeaders: Record<string, string> = {};
      up.headers.forEach((v, k) => {
        if (!HOP.has(k)) outHeaders[k] = v;
      });
      res.writeHead(up.status, outHeaders);
      const type = up.headers.get("content-type") ?? "";
      const strict = !!req.headers["mcp-session-id"];

      if (type.includes("text/event-stream") && up.body) {
        await relaySse(up.body, res, policy.maxBodyBytes, (msg) => guard(sessionId, msg, "server", undefined, strict), (m) => replyToServer(headers, m),
          (id) => engine.noteEventId(sessionId, id));
      } else if (type.includes("application/json")) {
        const text = await up.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          res.end(text);
          return;
        }
        const batch = Array.isArray(parsed);
        const out: Msg[] = [];
        for (const m of (batch ? parsed : [parsed]) as Msg[]) {
          const o = await guard(sessionId, m, "server", undefined, strict);
          if (o.forward) out.push(o.forward);
          if (o.reply) replyToServer(headers, o.reply);
        }
        res.end(JSON.stringify(batch ? out : out[0] ?? {}));
      } else {
        res.end(Buffer.from(await up.arrayBuffer()));
      }
      if (req.method === "DELETE") engine.dropSession(sessionId);
    } catch (e) {
      console.error(`[mcpwatch] upstream error: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`MCPWatch could not reach ${upstream.href}`);
    } finally {
      clearTimeout(timer);
    }
  }).listen(listen, "127.0.0.1", () => {
    const ai = policy.ai.enabled ? `, AI review by ${policy.ai.model}` : "";
    console.error(`[mcpwatch] ${policy.mode} mode${ai}, http://127.0.0.1:${listen}/mcp -> ${upstream.href}`);
  });
}

// Checks each SSE event's JSON-RPC payload and re-emits it (or drops it).
async function relaySse(
  body: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
  maxEventBytes: number,
  guard: (m: Msg) => Promise<Outcome>,
  replyToServer: (m: Msg) => void,
  noteEventId: (id: string) => void,
) {
  const decoder = new TextDecoder();
  let buf = "";
  const flush = async (event: string) => {
    const lines = event.split(/\r?\n/);
    const id = lines.find((l) => l.startsWith("id:"))?.slice(3).trim();
    if (id) noteEventId(id);
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data) {
      res.write(event + "\n\n");
      return;
    }
    let msg: Msg;
    try {
      msg = JSON.parse(data);
    } catch {
      res.write(event + "\n\n");
      return;
    }
    const o = await guard(msg);
    if (o.reply) replyToServer(o.reply);
    if (!o.forward) return;
    const keep = lines.filter((l) => !l.startsWith("data:"));
    res.write([...keep, `data: ${JSON.stringify(o.forward)}`].join("\n") + "\n\n");
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.length > maxEventBytes) throw new Error(`a stream event is larger than ${maxEventBytes} bytes`);
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
      const event = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      await flush(event);
    }
  }
  if (buf.trim()) await flush(buf);
  res.end();
}
