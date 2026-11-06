// The MCPWatch dashboard API: accounts and sessions, per-user projects, project settings as the guards
// receive them, and project keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "cli.js");
let PORT = 9191;
let BASE = `http://127.0.0.1:${PORT}`;

// Waits until the dashboard answers (up to 5 s).
async function ready() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/api/auth/me"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}

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
  await ready();

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
  await ready();
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
  const bogus = await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { mode: "bogus" } });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.error, "mode must be one of off, observe, protect, enforce");

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

test("dashboard: accounts, keys and events are never readable by other users", async (t) => {
  // Password hashes, live session tokens and project keys all live in the data dir, so nothing in it
  // may be group- or world-readable.
  const data = startDashboard(t);
  await ready();

  const { cookie } = await api("/api/auth/register", { method: "POST", body: { username: "dana", password: "dana-pass-1" } });
  const { body: p } = await api("/api/projects", { cookie, method: "POST", body: { name: "perms" } });
  await api("/api/agent/events", { headers: { "x-mcpwatch-key": p.key }, method: "POST", body: { events: [{ mcp: { method: "tools/call", findings: [] } }] } });

  for (const [file, mode] of modes(data)) {
    assert.equal(mode & 0o077, 0, `${path.relative(data, file) || "."} is readable by other users (mode ${mode.toString(8)})`);
  }
  // The files that must exist by now, so the walk above can't pass by finding nothing.
  const found = modes(data).map(([f]) => path.basename(f));
  for (const name of ["users.json", "sessions.json", "projects.json", `${p.id}.jsonl`]) assert.ok(found.includes(name), `${name} was written`);
});

test("dashboard: a data dir left world-readable by an older version is tightened at startup", async (t) => {
  // mode on writeFileSync/mkdirSync only applies at creation, so an upgrade has to chmod what it finds.
  const data = mkdtempSync(path.join(os.tmpdir(), "mcpwatch-legacy-"));
  mkdirSync(path.join(data, "events"), { recursive: true });
  writeFileSync(path.join(data, "users.json"), "[]");
  writeFileSync(path.join(data, "events", "old.jsonl"), "{}\n");
  const stale = path.join(data, "stale-events.jsonl");
  writeFileSync(stale, "{}\n");
  for (const p of [data, path.join(data, "events")]) chmodSync(p, 0o755);
  for (const p of [path.join(data, "users.json"), path.join(data, "events", "old.jsonl"), stale]) chmodSync(p, 0o644);

  PORT += 1;
  BASE = `http://127.0.0.1:${PORT}`;
  const dash = spawn(process.execPath, [CLI, "--port", String(PORT), "--data", data, "--events", stale], { stdio: "ignore" });
  t.after(() => dash.kill());
  await ready();

  for (const [file, mode] of modes(data)) {
    assert.equal(mode & 0o077, 0, `${path.relative(data, file) || "."} was left readable by other users`);
  }
  // The local events file sits outside the data dir and is shared with the guards.
  assert.equal(statSync(stale).mode & 0o077, 0, "the local events file was left readable by other users");
  // Tightening must not have eaten the contents.
  assert.equal(readFileSync(path.join(data, "events", "old.jsonl"), "utf8"), "{}\n");
});

// Every path under `dir`, including `dir` itself, with its permission bits.
function modes(dir) {
  const out = [[dir, statSync(dir).mode]];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...modes(p));
    else out.push([p, statSync(p).mode]);
  }
  return out;
}

