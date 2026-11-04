// End-to-end: create a project on the MCPWatch dashboard, connect the demo MCP server with its key,
// and check that requests, mode changes and client blocks flow through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "cli.js");
const SERVER = path.join(here, "fixtures", "demo-server", "server.mjs");
let PORT = 9191;
let BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.map((c) => c.text).join("\n");

// `cookie` is the signed-in session; requests without one are anonymous.
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, body: await res.json(), cookie: setCookie ? setCookie.split(";")[0] : undefined };
}

function startDashboard(t) {
  PORT += 1; // one port per test, so a dashboard still shutting down never collides
  BASE = `http://127.0.0.1:${PORT}`;
  const data = mkdtempSync(path.join(os.tmpdir(), "mcpwatch-dash-"));
  const dash = spawn(process.execPath, [CLI, "dashboard", "--port", String(PORT), "--data", data], { stdio: "ignore" });
  t.after(() => dash.kill());
  return data;
}

test("dashboard: accounts, sessions and per-user projects", async (t) => {
  startDashboard(t);
  await sleep(600);

  // Not signed in: no dashboard data.
  assert.equal((await api("/api/projects")).status, 401);
  assert.equal((await api("/api/auth/me")).body.user, null);

  // Register rules.
  assert.equal((await api("/api/auth/register", { method: "POST", body: { username: "x", password: "longenough" } })).status, 400);
  assert.equal((await api("/api/auth/register", { method: "POST", body: { username: "alice", password: "short" } })).status, 400);
  const alice = await api("/api/auth/register", { method: "POST", body: { username: "alice", password: "alice-pass-1" } });
  assert.equal(alice.status, 200);
  assert.match(alice.cookie, /^mw_session=/);
  assert.equal((await api("/api/auth/register", { method: "POST", body: { username: "ALICE", password: "another-pass" } })).status, 400);
  assert.equal((await api("/api/auth/me", { cookie: alice.cookie })).body.user.username, "alice");

  // Writes must be JSON (blocks cross-site form posts).
  const form = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { cookie: alice.cookie, "content-type": "application/x-www-form-urlencoded" }, body: "name=x" });
  assert.equal(form.status, 415);

  // Each user sees only their own projects; someone else's project looks missing.
  const a1 = (await api("/api/projects", { method: "POST", cookie: alice.cookie, body: { name: "Alice server", kind: "middleware" } })).body;
  await api("/api/projects", { method: "POST", cookie: alice.cookie, body: { name: "Alice second", kind: "proxy-stdio" } });
  const bob = await api("/api/auth/register", { method: "POST", body: { username: "bob", password: "bob-pass-12" } });
  assert.equal((await api("/api/projects", { cookie: alice.cookie })).body.length, 2);
  assert.equal((await api("/api/projects", { cookie: bob.cookie })).body.length, 0);
  assert.equal((await api(`/api/projects/${a1.id}`, { cookie: bob.cookie })).status, 404);
  assert.equal((await api(`/api/projects/${a1.id}`, { method: "DELETE", cookie: bob.cookie })).status, 404);
  assert.equal((await api(`/api/projects/${a1.id}/events`, { cookie: bob.cookie })).status, 404);

  // Sign in, wrong password, lockout after 5 failures.
  assert.equal((await api("/api/auth/login", { method: "POST", body: { username: "alice", password: "nope-nope" } })).status, 401);
  const again = await api("/api/auth/login", { method: "POST", body: { username: "Alice", password: "alice-pass-1" } });
  assert.equal(again.status, 200);
  for (let i = 0; i < 5; i++) await api("/api/auth/login", { method: "POST", body: { username: "bob", password: "wrong-pass" } });
  assert.equal((await api("/api/auth/login", { method: "POST", body: { username: "bob", password: "bob-pass-12" } })).status, 429);

  // Sign out ends that session only.
  assert.equal((await api("/api/auth/logout", { method: "POST", cookie: alice.cookie })).status, 200);
  assert.equal((await api("/api/projects", { cookie: alice.cookie })).status, 401);
  assert.equal((await api("/api/projects", { cookie: again.cookie })).body.length, 2);
});

async function connect(command, args, env, name) {
  const client = new Client({ name, version: "2.0.0" });
  await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env }, stderr: "pipe" }));
  return client;
}

test("dashboard: create a project, connect a server with its key, see and control its requests", async (t) => {
  const data = startDashboard(t);
  await sleep(600);
  const { cookie } = await api("/api/auth/register", { method: "POST", body: { username: "owner", password: "owner-pass-1" } });
  const as = (opts = {}) => ({ ...opts, cookie });

  // 1. Create a project: it starts in observe mode, waiting for its first connection.
  const created = await api("/api/projects", as({ method: "POST", body: { name: "Support tools", kind: "middleware" } }));
  assert.equal(created.status, 201);
  const p = created.body;
  assert.match(p.key, /^mw_/);
  assert.equal(p.mode, "observe");
  assert.equal(p.lastSeenAt, null);
  assert.equal((await api("/api/agent/config", { headers: { "x-mcpwatch-key": "mw_wrong" } })).status, 401);
  assert.equal((await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { mode: "bogus" } })).status, 400);

  // Transport settings are validated and reach the guard's config.
  assert.equal((await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { allowedOrigins: ["not a url"] } })).status, 400);
  await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { allowedOrigins: ["https://app.example.com/"], expectedAudience: "https://mcp.example.com" } });
  const cfg = (await api("/api/agent/config", { headers: { "x-mcpwatch-key": p.key } })).body.policy;
  assert.deepEqual(cfg.allowed_origins, ["https://app.example.com"]);
  assert.equal(cfg.expected_audience, "https://mcp.example.com");
  assert.equal(cfg.require_auth, false);
  await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { allowedOrigins: [], expectedAudience: "" } });

  // 2. Connect the demo server (middleware built in) with the project key. The client is unchanged.
  const env = { MCPWATCH_PROJECT_KEY: p.key, MCPWATCH_SERVER: BASE, MCPWATCH_POLL_MS: "200", MCPWATCH_PINS: path.join(data, "pins.json") };
  const client = await connect(process.execPath, [SERVER], env, "e2e-dash");
  t.after(() => client.close());
  await sleep(400);
  assert.ok((await api(`/api/projects/${p.id}`, { cookie })).body.lastSeenAt, "project shows as connected");

  // 3. Observe: the attack reaches the server, the dashboard records what enforce would do.
  assert.match(text(await client.callTool({ name: "read_file", arguments: { path: "../../../.ssh/id_rsa" } })), /outside the sandbox/);

  // 4. Switch to enforce in the dashboard: blocked within a poll.
  await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { mode: "enforce" } });
  await sleep(500);
  await assert.rejects(client.callTool({ name: "read_file", arguments: { path: "../../../.ssh/id_rsa" } }), /MW002/);

  // 5. Block the client by name in the dashboard: even clean calls are refused.
  await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { clients: { block: ["e2e-dash"], allow: [] } } });
  await sleep(500);
  await assert.rejects(client.callTool({ name: "calculator", arguments: { expression: "1+1" } }), /client is blocked/);
  await sleep(1300); // events are sent about once a second

  const events = (await api(`/api/projects/${p.id}/events`, { cookie })).body;
  const calls = events.filter((e) => e.method === "tools/call" && e.direction === "client->server");
  assert.ok(calls.every((e) => e.client === "e2e-dash 2.0.0" && e.clientName === "e2e-dash" && e.server === "demo-tools"));
  assert.ok(calls.some((e) => e.mode === "observe" && e.action === "allow" && e.enforceAction === "block"));
  assert.ok(calls.some((e) => e.mode === "enforce" && e.action === "block" && e.findings.some((f) => f.rule === "MW002")));
  assert.ok(calls.some((e) => e.clientRule === "block" && e.tool === "calculator"));
  await client.close();

  // 6. The proxy reports to a project too.
  const proxied = await api("/api/projects", { cookie, method: "POST", body: { name: "Third-party server", kind: "proxy-stdio" } });
  const proxyClient = await connect(process.execPath,
    [CLI, "--project-key", proxied.body.key, "--server", BASE, "--pins", path.join(data, "pins2.json"), "--", process.execPath, SERVER],
    { MCPWATCH_ENABLED: "0" }, "e2e-proxy");
  t.after(() => proxyClient.close());
  await api(`/api/projects/${proxied.body.id}`, { cookie, method: "PATCH", body: { mode: "enforce" } });
  await sleep(5300); // proxy polls every 5 s
  await assert.rejects(proxyClient.callTool({ name: "fetch_url", arguments: { url: "http://169.254.169.254/" } }), /MW003/);
  await proxyClient.close();
  await sleep(1300);
  const pe = (await api(`/api/projects/${proxied.body.id}/events`, { cookie })).body;
  assert.ok(pe.some((e) => e.tool === "fetch_url" && e.action === "block" && e.clientName === "e2e-proxy"));

  // 7. Deleting a project revokes its key.
  await api(`/api/projects/${p.id}`, { cookie, method: "DELETE" });
  assert.equal((await api("/api/agent/config", { headers: { "x-mcpwatch-key": p.key } })).status, 401);
  assert.equal((await api("/api/projects", { cookie })).body.length, 1);
});
