// Transport, auth and session rules (MW030–MW036) on the engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../dist/engine.js";
import { loadPolicy } from "../dist/policy.js";

const TOKEN = "tok_live_9f8e7d6c5b4a3210abcdef";

function engine(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcpwatch-tr-"));
  const events = [];
  const policy = loadPolicy(undefined, { mode: "enforce", pinsFile: path.join(dir, "pins.json"), ...overrides });
  return { engine: new Engine(policy, "test", [{ write: (e) => events.push(e) }]), events };
}

const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const init = (id, name) => ({ jsonrpc: "2.0", id, method: "initialize", params: { clientInfo: { name, version: "1" } } });
const rules = (o) => o.reply?.error?.data?.rules ?? [];
const jwt = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2lnbmF0dXJl"].join(".");

test("MW030: browser requests from foreign origins are refused, local and allowed ones pass", async () => {
  const { engine: e } = engine({ allowedOrigins: ["https://app.example.com"] });
  const http = (origin) => ({ headers: { host: "127.0.0.1:3001", ...(origin ? { origin } : {}) } });
  assert.deepEqual(rules((await e.fromClient("a", call(1, "echo", { text: "hi" }), http("http://evil.example:3001")))), ["MW030"]);
  assert.deepEqual(rules((await e.fromClient("b", call(1, "echo", { text: "hi" }), http("null")))), ["MW030"]);
  for (const origin of [undefined, "http://localhost:6274", "https://app.example.com"]) {
    assert.ok((await e.fromClient("c", call(1, "echo", { text: "hi" }), http(origin))).forward, `origin ${origin} should pass`);
  }
  // Requests without a JSON-RPC body (the GET event stream) go through the same check.
  assert.equal(e.fromHttp("d", http("http://evil.example"), "GET"), true);
  assert.equal(e.fromHttp("d2", http(), "GET"), false);
});

test("MW030: a Host the server doesn't answer to is refused when hosts are listed", async () => {
  const { engine: e } = engine({ allowedHosts: ["mcp.example.com"] });
  assert.deepEqual(rules((await e.fromClient("a", call(1, "echo", { text: "x" }), { headers: { host: "rebind.evil.example" } }))), ["MW030"]);
  assert.ok((await e.fromClient("b", call(1, "echo", { text: "x" }), { headers: { host: "mcp.example.com:443" } })).forward);
});

test("MW031: requireAuth refuses calls without a credential; otherwise public callers are noted once", async () => {
  const strict = engine({ requireAuth: true }).engine;
  assert.deepEqual(rules((await strict.fromClient("a", call(1, "echo", { text: "x" }), { headers: {} }))), ["MW031"]);
  assert.ok((await strict.fromClient("b", call(1, "echo", { text: "x" }), { headers: { authorization: `Bearer ${TOKEN}` } })).forward);

  const { engine: e, events } = engine();
  const pub = { headers: { "x-forwarded-for": "203.0.113.7" } };
  assert.ok((await e.fromClient("p", call(1, "echo", { text: "x" }), pub)).forward, "a low finding alone doesn't block");
  (await e.fromClient("p", call(2, "echo", { text: "y" }), pub));
  assert.equal(events.filter((ev) => ev.findings.some((f) => f.rule === "MW031" && f.severity === "low")).length, 1);
});

test("MW032: the caller's token in tool arguments or server output is refused, and never logged", async () => {
  const { engine: e, events } = engine();
  const http = { headers: { authorization: `Bearer ${TOKEN}` } };
  assert.ok((await e.fromClient("s", call(1, "echo", { text: "hello" }), http)).forward);
  assert.deepEqual(rules((await e.fromClient("s", call(2, "fetch_url", { url: `https://api.example.com/?t=${TOKEN}` }), http))), ["MW032"]);

  (await e.fromClient("s", call(3, "echo", { text: "x" }), http));
  const out = (await e.fromServer("s", { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: `debug: header was ${TOKEN}` }] } }));
  assert.equal(out.forward.result.isError, true);
  assert.doesNotMatch(JSON.stringify(out.forward), new RegExp(TOKEN));
  assert.ok(events.some((ev) => ev.direction === "server->client" && ev.findings.some((f) => f.rule === "MW032")));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(TOKEN), "token must not reach the event log");
});

test("MW033: a session id presented with another credential is refused; guessable ids are noted", async () => {
  const { engine: e, events } = engine();
  const as = (token, sid = "c8f2e0a4-5d1b-4e7a-9a63-2f0b7d9c1e55") => ({ headers: { authorization: `Bearer ${token}`, "mcp-session-id": sid } });
  assert.ok((await e.fromClient("s1", call(1, "echo", { text: "x" }), as(TOKEN))).forward);
  assert.deepEqual(rules((await e.fromClient("s1", call(2, "echo", { text: "x" }), as("tok_attacker_000000000000000")))), ["MW033"]);

  (await e.fromClient("s2", call(1, "echo", { text: "x" }), as(TOKEN, "42")));
  assert.ok(events.some((ev) => ev.session === "s2" && ev.findings.some((f) => f.rule === "MW033" && f.severity === "low")));
});

test("MW034: plain HTTP from another machine and an insecure upstream are noted once", async () => {
  const { engine: e, events } = engine();
  const info = { headers: { authorization: `Bearer ${TOKEN}` }, remoteAddress: "198.51.100.4", encrypted: false, insecureUpstream: true };
  (await e.fromClient("s", call(1, "echo", { text: "x" }), info));
  (await e.fromClient("s", call(2, "echo", { text: "y" }), info));
  const hits = events.flatMap((ev) => ev.findings).filter((f) => f.rule === "MW034");
  assert.equal(hits.length, 2, "one for the client side, one for the upstream, each once");
});

test("MW035: a stdio session that re-initializes as another client is refused", async () => {
  const { engine: e } = engine();
  assert.ok((await e.fromClient("conn", init(1, "claude-desktop"))).forward);
  assert.deepEqual(rules((await e.fromClient("conn", init(2, "trusted-admin-tool")))), ["MW035"]);
  // Stateless HTTP shares buckets between clients, so a different name there is not an attack.
  assert.ok((await e.fromClient("http-anonymous", init(1, "a"), { headers: {} })).forward);
  assert.ok((await e.fromClient("http-anonymous", init(2, "b"), { headers: {} })).forward);
});

test("MW036: expired tokens and tokens for another audience are refused", async () => {
  const { engine: e } = engine({ expectedAudience: "https://mcp.example.com" });
  const bearer = (claims) => ({ headers: { authorization: `Bearer ${jwt(claims)}` } });
  const later = Math.floor(Date.now() / 1000) + 3600;
  assert.ok((await e.fromClient("a", call(1, "echo", { text: "x" }), bearer({ aud: "https://mcp.example.com", exp: later }))).forward);
  assert.deepEqual(rules((await e.fromClient("b", call(1, "echo", { text: "x" }), bearer({ aud: "https://api.other.example", exp: later })))), ["MW036"]);
  assert.deepEqual(rules((await e.fromClient("c", call(1, "echo", { text: "x" }), bearer({ aud: ["https://mcp.example.com"], exp: 1000 })))), ["MW036"]);
});
