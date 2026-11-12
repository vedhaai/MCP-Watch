import { describeAi } from "./ai.js";
import readline from "node:readline";
import { BLOCKED, Engine, type Msg, type Outcome } from "./engine.js";
import { buildSinks, followProject, type Reporting } from "./headerwatch.js";
import type { Mode, Policy } from "./policy.js";
import type { HttpInfo } from "./transport.js";

// `mcpwatch engine`: the engine as a sidecar for guards written in other languages (the Python
// package). One JSON object per line on stdin, one answer per line on stdout, matched by "id".
//
//   {"id":1,"op":"client","session":"s","msg":{…},"http":{"headers":{…}}}  -> {"id":1,"forward":…,"reply":…}
//   {"id":2,"op":"server","session":"s","msg":{…},"strict":false}            -> {"id":2,"forward":…,"reply":…}
//   {"id":3,"op":"http","session":"s","http":{…},"method":"GET"}            -> {"id":3,"refuse":false}
//   {"id":4,"op":"rename","from":"a","to":"b"} | "drop" {session} | "eventId" {session,eventId}
//          | "mode" {mode} | "flush"                                        -> {"id":4,"ok":true}
//
// Requests are answered as soon as they are checked, so a slow AI review never holds up another
// connection; the caller keeps each direction in order. Logs go to stderr only.
const MODES: Mode[] = ["off", "observe", "protect", "enforce"];

export function runEngineServer(policy: Policy, serverKey: string, reporting: Reporting = {}) {
  const engine = new Engine(policy, serverKey, buildSinks(policy, reporting));
  followProject(engine, reporting);
  const send = (answer: object) => process.stdout.write(JSON.stringify(answer) + "\n");

  async function check(work: () => Promise<Outcome>, msg: Msg): Promise<Outcome> {
    try {
      return await work();
    } catch (e) {
      engine.noteFailure(e);
      if (policy.failOpen || msg?.id === undefined || msg?.method === undefined) return { forward: msg, reply: null };
      return { forward: null, reply: { jsonrpc: "2.0", id: msg.id, error: { code: BLOCKED, message: "MCPWatch failed closed" } } };
    }
  }

  async function handle(req: Msg): Promise<object> {
    // Every session id and message must be what the sidecar protocol says; anything else is refused, not guessed at.
    if (["client", "server", "http", "drop", "eventId"].includes(req.op) && typeof req.session !== "string") return { error: "session must be a string" };
    if (["client", "server"].includes(req.op) && (!req.msg || typeof req.msg !== "object" || Array.isArray(req.msg))) return { error: "msg must be a JSON object" };
    switch (req.op) {
      case "client":
        return check(() => engine.fromClient(req.session, req.msg, req.http as HttpInfo | undefined), req.msg);
      case "server":
        return check(() => engine.fromServer(req.session, req.msg, req.strict === true), req.msg);
      case "http":
        return { refuse: engine.fromHttp(req.session, req.http as HttpInfo, req.method ?? "GET") };
      case "rename":
        engine.renameSession(req.from, req.to);
        return { ok: true };
      case "drop":
        engine.dropSession(req.session);
        return { ok: true };
      case "eventId":
        engine.noteEventId(req.session, req.eventId);
        return { ok: true };
      case "mode":
        // Only the guard that started us talks to us, but a bad value must not silently switch checking off or on.
        if (!MODES.includes(req.mode as Mode)) return { error: `unknown mode "${String(req.mode)}"` };
        engine.updatePolicy({ mode: req.mode as Mode });
        return { ok: true, mode: engine.mode };
      case "flush":
        await engine.flush();
        return { ok: true };
      default:
        return { error: `unknown op "${req.op}"` };
    }
  }

  readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    let req: Msg;
    try {
      req = JSON.parse(line);
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("not an object");
    } catch {
      // Answered, so a caller waiting on this line doesn't wait forever (it can't match an id, so it is null).
      console.error("[mcpwatch] engine: refused a line that isn't a JSON object");
      send({ id: null, error: "request is not a JSON object" });
      return;
    }
    handle(req).then(
      (answer) => send({ id: req.id, ...answer }),
      (e) => send({ id: req.id, error: (e as Error).message }),
    );
  });

  // The guard that started us has gone: send what's queued, then stop.
  process.stdin.on("end", async () => {
    await engine.flush();
    process.exit(0);
  });

  send({ id: 0, ready: true, mode: engine.mode });
  const ai = describeAi(policy.ai);
  console.error(`[mcpwatch] engine for "${serverKey}" in ${policy.mode} mode${ai}${reporting.key ? `, reporting to ${reporting.server}` : ""}`);
}
