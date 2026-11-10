import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import spawn from "cross-spawn";
import { BLOCKED, Engine, type Msg, type Outcome } from "./engine.js";
import { buildSinks, followProject, type Reporting } from "./headerwatch.js";
import type { Policy } from "./policy.js";

// MCP stdio is newline-delimited JSON-RPC. The proxy sits between the client (our stdin/stdout)
// and the real server (a child process), checking every line in both directions.
export function runStdioProxy(policy: Policy, command: string, args: string[], reporting: Reporting = {}) {
  const serverKey = [command, ...args].join(" ");
  const engine = new Engine(policy, serverKey, buildSinks(policy, reporting));
  followProject(engine, reporting);
  const sessionId = `stdio-${process.pid}`;

  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  const toServer = (m: Msg | string) => child.stdin!.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n");
  const toClient = (m: Msg | string) => process.stdout.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n");

  // Checks can wait on the AI reviewer; each direction keeps its own order.
  const queues = { client: Promise.resolve(), server: Promise.resolve() };

  async function handle(line: string, from: "client" | "server") {
    if (!line.trim()) return;
    const [forward, back] = from === "client" ? [toServer, toClient] : [toClient, toServer];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      forward(line); // Not JSON: not ours to judge.
      return;
    }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      let outcome: Outcome;
      try {
        outcome = from === "client" ? await engine.fromClient(sessionId, msg) : await engine.fromServer(sessionId, msg);
      } catch (e) {
        engine.noteFailure(e);
        if (policy.failOpen || msg.id === undefined || msg.method === undefined) outcome = { forward: msg, reply: null };
        else outcome = { forward: null, reply: { jsonrpc: "2.0", id: msg.id, error: { code: BLOCKED, message: "MCPWatch failed closed" } } };
      }
      if (outcome.forward) forward(outcome.forward);
      if (outcome.reply) back(outcome.reply);
    }
  }

  const lines = (input: Readable, from: "client" | "server") =>
    readline.createInterface({ input, crlfDelay: Infinity }).on("line", (l) => {
      queues[from] = queues[from].then(() => handle(l, from));
    });

  lines(process.stdin, "client");
  lines(child.stdout!, "server");

  process.stdin.on("end", () => void queues.client.then(() => (child.stdin as Writable).end()));
  child.on("error", (e) => {
    console.error(`[mcpwatch] could not start "${command}": ${e.message}`);
    process.exit(1);
  });
  child.on("exit", async (code, signal) => {
    await queues.server;
    await engine.flush();
    process.exit(code ?? (signal ? 1 : 0));
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));

  const ai = policy.ai.enabled ? `, AI review by ${policy.ai.model}` : "";
  console.error(`[mcpwatch] ${policy.mode} mode${ai}, guarding stdio server: ${serverKey}`);
}
