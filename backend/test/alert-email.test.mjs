// The alert email: what it says, that it carries a text twin, and that nothing a guard sends can break out of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOGO_CID, logoPng, renderAlertEmail } from "../dist/services/alert-email.js";

const event = (extra = {}) => ({
  time: "2026-11-13T10:42:07.000Z", server: "files-server", client: "claude-desktop", tool: "run_command", method: "tools/call", action: "block", score: 9,
  rules: [{ id: "MW001", severity: "high" }, { id: "MW009", severity: "low" }], ...extra,
});
const payload = (extra = {}) => ({ project: { id: "p1", name: "Prod gateway" }, summary: "2 alerts in Prod gateway, 1 blocked", count: 2, blocked: 1, suppressed: 0, events: [event(), event({ action: "throttle" })], ...extra });

test("alert email: subject, readable rule titles, both HTML and text parts", () => {
  const m = renderAlertEmail(payload());
  assert.equal(m.subject, "[MCPWatch] High: 2 alerts in Prod gateway, 1 blocked");
  for (const part of [m.html, m.text]) {
    for (const s of ["Prod gateway", "run_command", "files-server", "claude-desktop", "MW001"]) assert.ok(part.includes(s), `${s} is in the email`);
  }
  assert.match(m.html, /MW001 · /, "a known rule shows its title next to the id");
  assert.match(m.html, /2026-11-13 10:42:07 UTC/);
  assert.match(m.html, /<html/);
  assert.doesNotMatch(m.text, /<[a-z]+/i, "the text part has no markup");
  assert.match(m.text, /never include message text/);
});

test("alert email: the header carries the MCPWatch name and the logo as an inline image", () => {
  const m = renderAlertEmail(payload());
  assert.match(m.html, /<img src="cid:mcpwatch-logo"[^>]*alt="MCPWatch"/);
  assert.match(m.html, />MCPWatch<\/div>/);
  assert.equal(LOGO_CID, "mcpwatch-logo");
  const png = logoPng();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "the logo is a real PNG");
  assert.ok(png.length < 40_000, "small enough for an email");
});

test("alert email: a test alert says it is a test, and counts held-back events", () => {
  const t = renderAlertEmail(payload({ sample: true, summary: "Test alert from MCPWatch for Prod gateway", count: 1, events: [event()] }));
  assert.equal(t.subject, "[MCPWatch] Test alert");
  assert.match(t.html, /This is a test/);
  assert.match(t.text, /TEST ALERT/);

  const more = renderAlertEmail(payload({ count: 8, blocked: 6, suppressed: 4, events: Array.from({ length: 5 }, () => event()) }));
  assert.match(more.html, /\+7 more alerts/, "3 not listed + 4 held back by the cooldown");
  assert.match(more.text, /\+7 more alerts/);
});

test("alert email: nothing a guard sends can inject markup or extra headers", () => {
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
  const m = renderAlertEmail(payload({
    project: { id: "p1", name: evil }, summary: `${evil}\r\nBcc: attacker@example.com`,
    events: [event({ server: evil, client: evil, tool: evil, method: evil, time: evil, rules: [{ id: evil, severity: evil }], action: evil })],
  }));
  // The escaped text still reads "onerror=alert(2)", which is harmless; what matters is that no tag is live.
  assert.doesNotMatch(m.html, /<script\b/i, "no live markup from guard-supplied values");
  assert.match(m.html, /&lt;script&gt;/);
  assert.deepEqual([...m.html.matchAll(/<img\b[^>]*>/gi)].map((x) => x[0].match(/src="([^"]*)"/)?.[1]), ["cid:mcpwatch-logo"], "the logo is the only image");
  assert.doesNotMatch(m.html, /"[^"<>]*"\s+on\w+=/i, "no attribute can be opened by a guard-supplied quote");
  assert.doesNotMatch(m.subject, /[\r\n]/, "no header injection through the subject");
  assert.ok(m.subject.length <= 200);
});

test("alert email: an event with no rule explains itself, and an unknown rule shows its id", () => {
  const m = renderAlertEmail(payload({ events: [event({ rules: [] }), event({ rules: [{ id: "AI-custom-7", severity: "medium" }] })] }));
  assert.match(m.html, /No rule fired/);
  assert.match(m.html, /AI-custom-7/);
});
