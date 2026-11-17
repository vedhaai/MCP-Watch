// Alerts: a project's webhook receives a signed alert when a guard reports a finding, the URLs and secret
// never go back to the browser, and the dashboard refuses addresses it shouldn't call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "cli.js");

async function receiver() {
  const got = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    got.push({ headers: req.headers, raw: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200).end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => server.close() };
}

async function start(t, env = {}) {
  const port = 9800 + Math.floor(Math.random() * 150);
  const base = `http://127.0.0.1:${port}`;
  const dash = spawn(process.execPath, [CLI, "--port", String(port), "--data", mkdtempSync(path.join(os.tmpdir(), "mcpwatch-alerts-"))],
    { stdio: "ignore", env: { ...process.env, ...env } });
  t.after(() => dash.kill());
  let cookie;
  const api = async (p, method = "GET", body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: body && JSON.stringify(body) });
    cookie ??= res.headers.get("set-cookie")?.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + "/api/auth/me"); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  await api("/api/auth/register", "POST", { username: "alert-owner", password: "alert-owner-pass" });
  const p = (await api("/api/projects", "POST", { name: "Alert project" })).body;
  return { api, p };
}

const settings = (extra) => ({ enabled: true, minSeverity: "high", onBlock: true, cooldownSeconds: 0, ...extra });
const report = (api, p, events) => api("/api/agent/events", "POST", { events: events.map((mcp) => ({ mcp })) }, { "x-mcpwatch-key": p.key });
const hit = (extra = {}) => ({ method: "tools/call", tool: "run", server: "srv", action: "block", score: 8, snippet: "secret message text",
  findings: [{ rule: "MW001", severity: "high", points: 8, detail: "bad" }], ...extra });
const waitFor = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 100)); };

test("alerts: a finding sends a signed webhook without the message text; secrets stay private", async (t) => {
  const hook = await receiver();
  t.after(hook.close);
  const { api, p } = await start(t, { MCPWATCH_ALERTS_ALLOW_PRIVATE: "1" });
  assert.equal(p.alerts.enabled, false, "alerts start off");

  const saved = await api(`/api/projects/${p.id}`, "PATCH", { alerts: settings({ webhookUrl: hook.url + "?token=abc123", webhookSecret: "whsec-test-1",
    smtpHost: "127.0.0.1", smtpPort: 2525, smtpUser: "mailer", smtpPass: "smtp-pass-xyz", smtpFrom: "alerts@example.com", emails: ["ops@example.com"] }) });
  assert.equal(saved.status, 200);
  for (const shown of [saved.body, (await api(`/api/projects/${p.id}`)).body, (await api("/api/projects")).body[0]]) {
    assert.equal(shown.alerts.webhookSet, true);
    assert.equal(shown.alerts.webhookSecretSet, true);
    assert.equal(shown.alerts.smtpPassSet, true);
    assert.equal(shown.alerts.smtpHost, "127.0.0.1");
    assert.doesNotMatch(JSON.stringify(shown), /abc123|whsec-test-1|smtp-pass-xyz/);
  }

  await report(api, p, [hit()]);
  await waitFor(() => hook.got.length);
  assert.equal(hook.got.length, 1);
  const { headers, raw } = hook.got[0];
  const ts = headers["x-mcpwatch-timestamp"];
  assert.equal(headers["x-mcpwatch-signature"], "sha256=" + createHmac("sha256", "whsec-test-1").update(`${ts}.${raw}`).digest("hex"));
  const body = JSON.parse(raw);
  assert.equal(body.type, "mcpwatch.alert");
  assert.equal(body.events[0].rules[0].id, "MW001");
  assert.doesNotMatch(raw, /secret message text/, "the message text is never in an alert");

  // An empty URL keeps the saved one; a low finding that wasn't blocked sends nothing.
  await api(`/api/projects/${p.id}`, "PATCH", { alerts: settings({ webhookUrl: "" }) });
  await report(api, p, [hit({ action: "allow", findings: [{ rule: "MW009", severity: "low", points: 1, detail: "" }] })]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hook.got.length, 1);

  // Test alert goes through the saved webhook and is marked as a sample.
  const test = (await api(`/api/projects/${p.id}/alerts-test`, "POST", settings({}))).body;
  assert.deepEqual(test.results.filter((r) => r.channel === "webhook").map((r) => r.ok), [true]);
  assert.equal(test.results.find((r) => r.channel === "email").ok, false, "nothing listens on the test mail server, and that is reported, not thrown");
  assert.equal(JSON.parse(hook.got.at(-1).raw).sample, true);

  // "Remove email" sends the clear flag along with the old values the form still holds: the flag wins.
  const removed = await api(`/api/projects/${p.id}`, "PATCH", { alerts: settings({
    clearSmtp: true, smtpHost: "127.0.0.1", smtpPort: 2525, smtpUser: "mailer", smtpFrom: "alerts@example.com", emails: ["ops@example.com"] }) });
  assert.equal(removed.status, 200);
  assert.deepEqual([removed.body.alerts.smtpHost, removed.body.alerts.smtpPassSet, removed.body.alerts.emails], ["", false, []]);
  assert.equal(removed.body.alerts.webhookSet, true, "the other channels are untouched");
});

test("alerts: the cooldown holds back repeats", async (t) => {
  const hook = await receiver();
  t.after(hook.close);
  const { api, p } = await start(t, { MCPWATCH_ALERTS_ALLOW_PRIVATE: "1" });
  await api(`/api/projects/${p.id}`, "PATCH", { alerts: settings({ webhookUrl: hook.url, cooldownSeconds: 3600 }) });
  await report(api, p, [hit()]);
  await waitFor(() => hook.got.length);
  await report(api, p, [hit(), hit()]);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hook.got.length, 1);
});

test("alerts: addresses the dashboard shouldn't call, and bad settings, are refused", async (t) => {
  const { api, p } = await start(t);
  const patch = (alerts) => api(`/api/projects/${p.id}`, "PATCH", { alerts: settings(alerts) });
  assert.equal((await patch({ webhookUrl: "http://127.0.0.1:9/x" })).status, 400, "loopback webhook");
  assert.equal((await patch({ webhookUrl: "http://169.254.169.254/latest" })).status, 400, "metadata address");
  assert.equal((await patch({ slackUrl: "https://example.com/services/T/B/x" })).status, 400, "not a Slack host");
  assert.equal((await patch({ slackUrl: "http://hooks.slack.com/services/T/B/x" })).status, 400, "Slack over http");
  assert.equal((await patch({ emails: ["not-an-email"] })).status, 400);
  assert.equal((await patch({ emails: ["a@example.com"] })).status, 400, "recipients need an SMTP server");
  const smtp = { smtpHost: "smtp.example.com", smtpFrom: "alerts@example.com", emails: ["a@example.com"] };
  assert.equal((await patch({ ...smtp, smtpHost: "127.0.0.1" })).status, 400, "loopback mail server");
  assert.equal((await patch({ ...smtp, smtpHost: "169.254.169.254" })).status, 400, "metadata address as mail server");
  assert.equal((await patch({ ...smtp, smtpHost: "bad host!" })).status, 400, "not a host name");
  assert.equal((await patch({ ...smtp, smtpPort: 22 })).status, 400, "not a mail port");
  assert.equal((await patch({ ...smtp, smtpFrom: "nope" })).status, 400, "from must be an address");
  assert.equal((await patch({})).status, 400, "enabled with nowhere to send");
  assert.equal((await patch({ cooldownSeconds: -1, webhookUrl: "https://example.com/h" })).status, 400);
});
