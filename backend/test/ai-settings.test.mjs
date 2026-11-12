// The dashboard's AI settings per project, against a stand-in OpenAI-compatible model server:
// rules only, a local model or an API model, what the guards receive, and Test AI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "dist", "cli.js");

// A model server whose answer is chosen by `judge(userMessage)`. `key`: refuse requests without this bearer token.
async function fakeModel(judge, { key } = {}) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (key && req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end("bad key");
    const answer = body.messages.length === 1 ? { verdict: "allow", findings: [] } : judge(body.messages.at(-1).content);
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(answer) } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

const clean = { verdict: "allow", findings: [] };
const flag = (rule, where) => ({ verdict: "block", findings: [{ rule, severity: "high", confidence: 0.9, where, reason: `looks like ${rule}` }] });

test("dashboard: choose rules only, a local model or an API model; the key never goes back to the browser", async (t) => {
  const model = await fakeModel((u) => (u.includes("curl") ? flag("MW001", "args.path") : clean), { key: "sk-live-abcd1234wxyz" });
  t.after(model.close);
  const port = 9300 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  // The stand-in provider is a loopback server, which is the self-hosted-endpoint case the dashboard
  // only allows when whoever started it opted in.
  const dash = spawn(process.execPath, [CLI, "--port", String(port), "--data", mkdtempSync(path.join(os.tmpdir(), "mcpwatch-ai-dash-"))],
    { stdio: "ignore", env: { ...process.env, MCPWATCH_AI_ALLOW_PRIVATE: "1" } });
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
  await api("/api/auth/register", "POST", { username: "ai-owner", password: "ai-owner-pass" });
  const p = (await api("/api/projects", "POST", { name: "AI project" })).body;
  assert.equal(p.ai.provider, "off", "new projects use the rules only");
  const config = async () => (await api("/api/agent/config", "GET", undefined, { "x-mcpwatch-key": p.key })).body.policy;
  assert.equal((await config()).ai_review, false);

  // An API model needs a URL, a model and a key.
  assert.equal((await api(`/api/projects/${p.id}`, "PATCH", { ai: { provider: "api", url: model.url, model: "m" } })).status, 400);
  const saved = await api(`/api/projects/${p.id}`, "PATCH", { ai: { provider: "api", url: model.url, model: "test-model", apiKey: "sk-live-abcd1234wxyz" } });
  assert.equal(saved.status, 200);
  for (const shown of [saved.body, (await api(`/api/projects/${p.id}`)).body, (await api("/api/projects")).body[0]]) {
    assert.equal(shown.ai.keyHint, "…wxyz");
    assert.doesNotMatch(JSON.stringify(shown), /sk-live/);
  }
  const cfg = await config();
  assert.deepEqual([cfg.ai_review, cfg.ai_url, cfg.ai_model, cfg.ai_key], [true, model.url, "test-model", "sk-live-abcd1234wxyz"]);

  // Saving again with the key field empty keeps the key.
  await api(`/api/projects/${p.id}`, "PATCH", { ai: { provider: "api", url: model.url, model: "test-model-2", apiKey: "" } });
  assert.equal((await config()).ai_key, "sk-live-abcd1234wxyz");

  // Test AI uses the saved key, and reports a wrong one.
  const ok = (await api(`/api/projects/${p.id}/ai-test`, "POST", { provider: "api", url: model.url, model: "test-model-2" })).body;
  assert.equal(ok.ok, true);
  assert.equal(ok.caught, true);
  const bad = (await api(`/api/projects/${p.id}/ai-test`, "POST", { provider: "api", url: model.url, model: "x", apiKey: "sk-wrong" })).body;
  assert.match(bad.error, /refused the API key/);

  // Back to a local model: the guard gets the local URL and no key.
  await api(`/api/projects/${p.id}`, "PATCH", { ai: { provider: "local", url: "", model: "" } });
  const local = await config();
  assert.deepEqual([local.ai_review, local.ai_url, local.ai_model, local.ai_key], [true, "http://127.0.0.1:11434/v1", "qwen2.5:7b", ""]);
  await api(`/api/projects/${p.id}`, "PATCH", { ai: { provider: "off" } });
  assert.equal((await config()).ai_review, false);
});

test("dashboard: a model on another machine needs the owner's consent, and the guards are told", async () => {
  const { AiService } = await import("../dist/services/ai-service.js");
  const svc = new AiService();
  const off = { provider: "off", url: "", model: "", apiKey: "" };
  const api = { provider: "api", url: "https://api.example.test/v1", model: "m", apiKey: "sk-test-123456" };

  assert.throws(() => svc.fromInput(api, off), /confirm that message text/);
  assert.throws(() => svc.fromInput({ ...api, hostedConsent: false }, off), /confirm that message text/);
  const ai = svc.fromInput({ ...api, hostedConsent: true }, off);
  assert.equal(ai.hostedConsent, true);
  assert.equal(svc.guardSettings(ai).ai_allow_hosted, true);

  // Settings saved before the consent existed keep working; an explicit false is passed on.
  assert.equal(svc.guardSettings(api).ai_allow_hosted, true);
  assert.equal(svc.guardSettings({ ...api, hostedConsent: false }).ai_allow_hosted, false);

  // A model on this machine needs none, and "local" pointed at another address does.
  assert.equal(svc.fromInput({ provider: "local" }, off).hostedConsent, undefined);
  assert.equal(svc.fromInput({ provider: "api", url: "http://127.0.0.1:8080/v1", model: "m", apiKey: "sk-test-123456" }, off).hostedConsent, undefined);
  assert.throws(() => svc.fromInput({ provider: "local", url: "http://192.168.1.20:11434/v1", model: "m" }, off), /confirm that message text/);
  assert.equal(svc.guardSettings(off).ai_review, false);
});
