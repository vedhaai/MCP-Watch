// The MCPWatch dashboard API: accounts and sessions, per-user projects, project settings as the guards
// receive them, and project keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "cli.js");
let PORT = 9191;
let BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const dash = spawn(process.execPath, [CLI, "--port", String(PORT), "--data", data], { stdio: "ignore" });
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

test("dashboard: create a project, configure it for its guards, and revoke its key", async (t) => {
  startDashboard(t);
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

  // 2. A guard fetching its config marks the project as connected.
  assert.equal((await api("/api/agent/config", { headers: { "x-mcpwatch-key": p.key } })).status, 200);
  assert.ok((await api(`/api/projects/${p.id}`, { cookie })).body.lastSeenAt, "project shows as connected");

  // 3. Deleting a project revokes its key.
  await api(`/api/projects/${p.id}`, { cookie, method: "DELETE" });
  assert.equal((await api("/api/agent/config", { headers: { "x-mcpwatch-key": p.key } })).status, 401);
  assert.equal((await api("/api/projects", { cookie })).body.length, 0);
});
