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

function startDashboard(t, env = {}, eventsFile) {
  PORT += 1; // one port per test, so a dashboard still shutting down never collides
  BASE = `http://127.0.0.1:${PORT}`;
  const data = mkdtempSync(path.join(os.tmpdir(), "mcpwatch-dash-"));
  const args = [CLI, "--port", String(PORT), "--data", data];
  if (eventsFile) args.push("--events", eventsFile);
  const dash = spawn(process.execPath, args, { stdio: "ignore", env: { ...process.env, ...env } });
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
  // Usernames are unique regardless of case. Checked as a signed-in caller, because an anonymous one
  // is now turned away before the dashboard will say whether a name is taken.
  assert.equal((await api("/api/auth/register", { method: "POST", cookie: alice.cookie, body: { username: "ALICE", password: "another-pass" } })).status, 400);
  assert.equal((await api("/api/auth/me", { cookie: alice.cookie })).body.user.username, "alice");

  // Writes must be JSON (blocks cross-site form posts).
  const form = await fetch(`${BASE}/api/projects`, { method: "POST", headers: { cookie: alice.cookie, "content-type": "application/x-www-form-urlencoded" }, body: "name=x" });
  assert.equal(form.status, 415);

  // Each user sees only their own projects; someone else's project looks missing.
  const a1 = (await api("/api/projects", { method: "POST", cookie: alice.cookie, body: { name: "Alice server", kind: "middleware" } })).body;
  await api("/api/projects", { method: "POST", cookie: alice.cookie, body: { name: "Alice second", kind: "proxy-stdio" } });
  // Alice makes bob's account; it doesn't touch her session, so bob signs in himself.
  const made = await api("/api/auth/register", { method: "POST", cookie: alice.cookie, body: { username: "bob", password: "bob-pass-12" } });
  assert.equal(made.status, 200);
  assert.equal(made.cookie, undefined, "creating an account for someone else must not reassign your own session");
  assert.equal((await api("/api/auth/me", { cookie: alice.cookie })).body.user.username, "alice");
  const bob = await api("/api/auth/login", { method: "POST", body: { username: "bob", password: "bob-pass-12" } });
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

test("dashboard: a user cannot aim the AI settings at the dashboard's own network", async (t) => {
  // Both the Test AI button and saving settings fetch (or hand a guard) the URL, so both check it.
  startDashboard(t);
  await ready();
  const { cookie } = await api("/api/auth/register", { method: "POST", body: { username: "erin", password: "erin-pass-1" } });
  const { body: p } = await api("/api/projects", { cookie, method: "POST", body: { name: "ssrf" } });

  const internal = [
    ["http://127.0.0.1:9299/v1", /local network/],
    ["http://localhost:9299/v1", /local network/],
    ["http://10.0.0.5/v1", /local network/],
    ["http://169.254.169.254/latest/meta-data", /reserved address/],
  ];
  for (const [url, message] of internal) {
    const ai = { provider: "api", url, model: "m", apiKey: "sk-test" };
    const tested = await api(`/api/projects/${p.id}/ai-test`, { cookie, method: "POST", body: ai });
    assert.equal(tested.status, 400, `Test AI should refuse ${url}`);
    assert.match(tested.body.error, message);
    const saved = await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { ai } });
    assert.equal(saved.status, 400, `saving should refuse ${url}`);
    assert.match(saved.body.error, message);
  }
  // Nothing was stored, so no guard is handed a blocked address.
  assert.equal((await api(`/api/projects/${p.id}`, { cookie })).body.ai.provider, "off");

  // A local model is the one case that may reach this machine — but not the metadata service.
  assert.equal((await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { ai: { provider: "local", url: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" } } })).status, 200);
  const metadata = await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { ai: { provider: "local", url: "http://169.254.169.254/v1", model: "m" } } });
  assert.equal(metadata.status, 400);
  assert.match(metadata.body.error, /reserved address/);

  // A real provider still saves and reaches the guards.
  const ok = await api(`/api/projects/${p.id}`, { cookie, method: "PATCH", body: { ai: { provider: "api", url: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "sk-test" } } });
  assert.equal(ok.status, 200);
  assert.equal((await api("/api/agent/config", { headers: { "x-mcpwatch-key": p.key } })).body.policy.ai_url, "https://api.openai.com/v1");
});

test("dashboard: only the first account is open; after that one is made by someone signed in", async (t) => {
  startDashboard(t);
  await ready();

  // Nobody yet, so the first account can sign itself up.
  const owner = await api("/api/auth/register", { method: "POST", body: { username: "owner", password: "owner-pass-1" } });
  assert.equal(owner.status, 200);
  assert.match(owner.cookie, /^mw_session=/);

  // From here an anonymous request is turned away, and before the dashboard says whether a name is
  // taken — otherwise it would answer that question for anyone who asks.
  const uninvited = await api("/api/auth/register", { method: "POST", body: { username: "attacker", password: "attacker-p1" } });
  assert.equal(uninvited.status, 403);
  assert.match(uninvited.body.error, /already has an account/);
  assert.equal((await api("/api/auth/register", { method: "POST", body: { username: "owner", password: "owner-pass-1" } })).status, 403,
    "an existing username must not be distinguishable from a free one");
  assert.equal((await api("/api/auth/login", { method: "POST", body: { username: "attacker", password: "attacker-p1" } })).status, 401,
    "the refused account was not created");

  // A signed-in user can still add one.
  assert.equal((await api("/api/auth/register", { method: "POST", cookie: owner.cookie, body: { username: "colleague", password: "colleague-1" } })).status, 200);
  assert.equal((await api("/api/auth/login", { method: "POST", body: { username: "colleague", password: "colleague-1" } })).status, 200);

  // A password long enough to be a lever on the hash is refused rather than hashed.
  assert.equal((await api("/api/auth/register", { method: "POST", cookie: owner.cookie, body: { username: "big", password: "p".repeat(5000) } })).status, 400);
});

test("dashboard: open registration can be turned back on by whoever starts the dashboard", async (t) => {
  startDashboard(t, { MCPWATCH_OPEN_REGISTRATION: "1" });
  await ready();
  assert.equal((await api("/api/auth/register", { method: "POST", body: { username: "first", password: "first-pass-1" } })).status, 200);
  const second = await api("/api/auth/register", { method: "POST", body: { username: "second", password: "second-pass" } });
  assert.equal(second.status, 200, "the opt-in restores the old behaviour for a shared dashboard");
  assert.match(second.cookie, /^mw_session=/);
});

test("dashboard: signing in is capped per caller, so password hashing can't be used as a lever", async (t) => {
  startDashboard(t);
  await ready();

  // Distinct usernames, so the per-username lockout isn't what answers: this is the per-caller cap.
  const codes = [];
  for (let i = 0; i < 24; i++) {
    codes.push((await api("/api/auth/login", { method: "POST", body: { username: `nobody${i}`, password: "whatever-123" } })).status);
  }
  assert.ok(codes.slice(0, 20).every((c) => c === 401), `the first 20 are answered normally, got ${JSON.stringify(codes)}`);
  assert.ok(codes.slice(20).every((c) => c === 429), `everything past the cap is refused, got ${codes.slice(20)}`);

  // Reading who is signed in is cheap and stays available.
  assert.equal((await api("/api/auth/me")).status, 200);
});

test("dashboard: local events belong to the account that set the dashboard up", async (t) => {
  // Guards without a project key write to a shared file, so nothing in these events says whose they
  // are. They are the host's own captured traffic, and only its owner sees them.
  const events = path.join(mkdtempSync(path.join(os.tmpdir(), "mcpwatch-local-")), "events.jsonl");
  writeFileSync(events, JSON.stringify({
    time: "2026-11-06T00:00:00Z", method: "tools/call", findings: [], snippet: "OWNER-ONLY-DATA",
    client: "c", server: "s", session: "x", direction: "client->server", mode: "observe", score: 0,
  }) + "\n");
  startDashboard(t, {}, events);
  await ready();

  const owner = await api("/api/auth/register", { method: "POST", body: { username: "owner", password: "owner-pass-1" } });
  await api("/api/auth/register", { method: "POST", cookie: owner.cookie, body: { username: "colleague", password: "colleague-1" } });
  const other = await api("/api/auth/login", { method: "POST", body: { username: "colleague", password: "colleague-1" } });

  // The browser is told which account it is, so the page is only offered to the one that can load it.
  assert.equal((await api("/api/auth/me", { cookie: owner.cookie })).body.user.owner, true);
  assert.equal((await api("/api/auth/me", { cookie: other.cookie })).body.user.owner, false);

  const mine = await api("/api/local-events", { cookie: owner.cookie });
  assert.equal(mine.status, 200);
  assert.equal(mine.body[0].snippet, "OWNER-ONLY-DATA");

  const theirs = await api("/api/local-events", { cookie: other.cookie });
  assert.equal(theirs.status, 403, "another account must not read the host's captured traffic");
  assert.match(theirs.body.error, /set up this dashboard/);
  assert.equal(JSON.stringify(theirs.body).includes("OWNER-ONLY-DATA"), false, "nothing of the traffic leaks in the refusal");

  assert.equal((await api("/api/local-events")).status, 401);

  // The rest of the dashboard is unchanged for the second account.
  assert.equal((await api("/api/meta", { cookie: other.cookie })).status, 200);
  assert.equal((await api("/api/projects", { method: "POST", cookie: other.cookie, body: { name: "theirs" } })).status, 201);
});

