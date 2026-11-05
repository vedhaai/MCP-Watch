// `mcpwatch engine`: the sidecar the Python package talks to, one JSON object per line each way.
// Run `npm run build` first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "cli.js");

function startEngine(options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcpwatch-engine-"));
  const events = path.join(dir, "events.jsonl");
  const child = spawn(process.execPath, [CLI, "engine"], {
    env: { ...process.env, MCPWATCH_EVENTS: events, MCPWATCH_PINS: path.join(dir, "pins.json"), MCPWATCH_PROJECT_KEY: "",
      MCPWATCH_ENGINE_OPTIONS: JSON.stringify({ name: "py-tools", ...options }) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const answer = JSON.parse(line);
    waiting.get(answer.id)?.(answer);
    waiting.delete(answer.id);
  });
  let next = 1;
  const ask = (op, fields = {}) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, op, ...fields }) + "\n");
  });
  const ready = new Promise((resolve) => waiting.set(0, resolve));
  const stop = () => new Promise((resolve) => {
    child.on("exit", resolve);
    child.stdin.end();
  });
  return { ask, ready, stop, events };
}

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("engine: answers each message with forward / reply, and logs events under the guard's name", async () => {
  const engine = startEngine();
  assert.deepEqual(await engine.ready, { id: 0, ready: true, mode: "enforce" });

  const clean = call(1, "calculator", { expression: "6*7" });
  assert.deepEqual(await engine.ask("client", { session: "s1", msg: clean }), { id: 1, forward: clean, reply: null });
  const blocked = await engine.ask("client", { session: "s1", msg: call(2, "read_file", { path: "../../../.ssh/id_rsa" }) });
  assert.equal(blocked.forward, null);
  assert.equal(blocked.reply.error.code, -32001);
  assert.deepEqual(blocked.reply.error.data.rules, ["MW002"]);

  // A result to a call the client made: the secret in it is redacted.
  await engine.ask("client", { session: "s1", msg: call(3, "read_file", { path: "docs/deploy-notes.txt" }) });
  const result = { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "key AKIAIOSFODNN7EXAMPLE" }] } };
  const out = await engine.ask("server", { session: "s1", msg: result });
  assert.match(out.forward.result.content[0].text, /\[REDACTED:aws-access-key\]/);

  // HTTP: a GET from a foreign web origin is refused (MW030).
  const refused = await engine.ask("http", { session: "s2", http: { headers: { origin: "https://evil.example" } }, method: "GET" });
  assert.equal(refused.refuse, true);

  assert.deepEqual(await engine.ask("mode", { mode: "observe" }), { id: 6, ok: true, mode: "observe" });
  const observed = await engine.ask("client", { session: "s1", msg: call(4, "read_file", { path: "../../../.ssh/id_rsa" }) });
  assert.equal(observed.reply, null);

  await engine.stop();
  const events = readFileSync(engine.events, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events.every((e) => e.server === "py-tools"));
  assert.ok(events.some((e) => e.tool === "read_file" && e.action === "block"));
  assert.ok(events.some((e) => e.tool === "read_file" && e.action === "allow" && e.enforceAction === "block"));
});

test("engine: the guard's options reach the policy", async () => {
  const engine = startEngine({ denyTools: ["run_command"], mode: "protect" });
  assert.equal((await engine.ready).mode, "protect");
  const denied = await engine.ask("client", { session: "s", msg: call(1, "run_command", { command: "ls" }) });
  assert.deepEqual(denied.reply.error.data.rules, ["MW009"]);
  await engine.stop();
});
