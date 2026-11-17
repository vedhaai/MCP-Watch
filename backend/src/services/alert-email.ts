import { CATALOG } from "@vedhaai/mcpwatch";
import { LOGO_PNG_BASE64 } from "./alert-email-logo.js";
import type { AlertPayload } from "./alert-service.js";

// The email an alert sends: a table-based HTML page with inline styles (the only thing mail clients
// render reliably) and a plain-text twin for clients that show text only.
//
// Everything in an alert comes from a guard, so none of it is trusted: every value is escaped before it
// goes into the HTML, and nothing is ever used as a URL or an attribute. Like every alert, it names the
// rule, tool, server and client but never the message text.

// The header logo is an inline attachment the email refers to as cid:mcpwatch-logo (see AlertService.email).
export const LOGO_CID = "mcpwatch-logo";
export const logoPng = () => Buffer.from(LOGO_PNG_BASE64, "base64");

const TITLES = new Map(CATALOG.map((r) => [r.id, r.title]));
const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

type Sev = "high" | "medium" | "low";
const RANK: Record<Sev, number> = { low: 1, medium: 2, high: 3 };
const SEV: Record<Sev, { fg: string; bg: string; label: string }> = {
  high: { fg: "#9b1c1c", bg: "#fde8e8", label: "High" },
  medium: { fg: "#92400e", bg: "#fef3c7", label: "Medium" },
  low: { fg: "#075985", bg: "#e0f2fe", label: "Low" },
};
const ACTION: Record<string, { fg: string; bg: string; edge: string }> = {
  block: { fg: "#9b1c1c", bg: "#fde8e8", edge: "#dc2626" },
  throttle: { fg: "#92400e", bg: "#fef3c7", edge: "#d97706" },
  redact: { fg: "#075985", bg: "#e0f2fe", edge: "#0284c7" },
  strip: { fg: "#075985", bg: "#e0f2fe", edge: "#0284c7" },
  allow: { fg: "#3f3f46", bg: "#f4f4f5", edge: "#a1a1aa" },
};

const sevOf = (s: string): Sev => (s === "high" || s === "medium" || s === "low" ? s : "low");
const actionOf = (a: string) => ACTION[a] ?? ACTION.allow;

function worst(p: AlertPayload): Sev | null {
  let w: Sev | null = null;
  for (const e of p.events) for (const r of e.rules) if (!w || RANK[sevOf(r.severity)] > RANK[w]) w = sevOf(r.severity);
  return w;
}

// 2026-11-13 10:42:07 UTC; a time that doesn't parse is shown as it came.
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 40) : d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

const ruleLabel = (id: string) => (TITLES.has(id) ? `${id} · ${TITLES.get(id)}` : id);

export interface AlertEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderAlertEmail(p: AlertPayload): AlertEmail {
  const blocked = p.blocked;
  const w = worst(p);
  const shown = p.events.length;
  const more = Math.max(0, p.count - shown) + p.suppressed;

  const subject = (p.sample ? "[MCPWatch] Test alert" : `[MCPWatch] ${w ? SEV[w].label + ": " : ""}${p.summary}`).replace(/[\r\n]+/g, " ").slice(0, 200);

  // ---- plain text
  const lines = [p.sample ? `TEST ALERT: nothing was detected. This checks that email alerts reach you.\n` : "", p.summary, `Project: ${p.project.name}`, ""];
  p.events.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.action.toUpperCase()}  ${e.tool ?? e.method}  (score ${e.score})`);
    lines.push(`   Server: ${e.server || "unknown"}   Client: ${e.client || "unknown"}   Time: ${when(e.time)}`);
    for (const r of e.rules) lines.push(`   - ${ruleLabel(r.id)} [${sevOf(r.severity)}]`);
    lines.push("");
  });
  if (more) lines.push(`+${more} more alert${more === 1 ? "" : "s"} not listed here. Open the project's Requests page in the dashboard to see them.`, "");
  lines.push("Alerts never include message text. Change where alerts go under the project's Settings > Alerts.");
  const text = lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");

  // ---- HTML
  const chip = (fg: string, bg: string, label: string) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${bg};color:${fg};font-size:12px;font-weight:600;line-height:18px;">${esc(label)}</span>`;
  const stat = (label: string, value: string) =>
    `<td style="padding:0 24px 0 0;"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#71717a;">${esc(label)}</div>` +
    `<div style="font-size:20px;font-weight:700;color:#18181b;">${esc(value)}</div></td>`;
  const meta = (label: string, value: string) =>
    `<span style="color:#71717a;">${esc(label)}</span> <span style="color:#27272a;">${esc(value || "unknown")}</span>`;

  const cards = p.events.map((e) => {
    const a = actionOf(e.action);
    const rules = e.rules.length
      ? e.rules.map((r) => `<div style="margin:4px 0 0;font-size:13px;color:#27272a;">${chip(SEV[sevOf(r.severity)].fg, SEV[sevOf(r.severity)].bg, SEV[sevOf(r.severity)].label)} ${esc(ruleLabel(r.id))}</div>`).join("")
      : `<div style="margin:4px 0 0;font-size:13px;color:#71717a;">No rule fired; the message was stopped by a client or tool rule.</div>`;
    return `<tr><td style="padding:0 0 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-left:4px solid ${a.edge};border-radius:8px;background:#ffffff;"><tr><td style="padding:12px 14px;">
<div style="font-size:15px;font-weight:700;color:#18181b;">${chip(a.fg, a.bg, e.action.toUpperCase())}&nbsp; ${esc(e.tool ?? e.method)}</div>
<div style="margin:6px 0 2px;font-size:12px;line-height:20px;">${meta("Server", e.server)} &nbsp;·&nbsp; ${meta("Client", e.client)} &nbsp;·&nbsp; ${meta("Score", String(e.score))}</div>
<div style="font-size:12px;color:#71717a;">${esc(when(e.time))}</div>
${rules}
</td></tr></table></td></tr>`;
  }).join("");

  const banner = p.sample
    ? `<tr><td style="padding:0 0 16px;"><div style="padding:10px 14px;border-radius:8px;background:#e0f2fe;color:#075985;font-size:13px;line-height:20px;"><b>This is a test.</b> Nothing was detected. It only checks that email alerts reach you.</div></td></tr>`
    : "";
  const moreRow = more
    ? `<tr><td style="padding:0 0 12px;font-size:13px;color:#52525b;">+${more} more alert${more === 1 ? "" : "s"} not listed here. Open the project's <b>Requests</b> page in the dashboard to see them.</td></tr>`
    : "";

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(p.summary)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<tr><td style="background:#1c1410;border-radius:12px 12px 0 0;padding:16px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding:0 12px 0 0;vertical-align:middle;"><img src="cid:${LOGO_CID}" width="36" height="36" alt="MCPWatch" style="display:block;border:0;width:36px;height:36px;"></td>
<td style="vertical-align:middle;"><div style="font-size:20px;line-height:22px;font-weight:700;color:#ffffff;">MCPWatch</div><div style="font-size:10px;line-height:14px;color:#f58a3c;letter-spacing:.14em;">MCP SECURITY GUARD</div></td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e4e4e7;border-top:0;border-radius:0 0 12px 12px;padding:24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${banner}
<tr><td style="padding:0 0 4px;font-size:20px;line-height:28px;font-weight:700;color:#18181b;">${esc(p.sample ? "Test alert" : p.summary)}</td></tr>
<tr><td style="padding:0 0 18px;font-size:14px;color:#52525b;">Project <b style="color:#18181b;">${esc(p.project.name)}</b></td></tr>
<tr><td style="padding:0 0 20px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${stat("Alerts", String(p.count + p.suppressed))}${stat("Blocked", String(blocked))}${w ? stat("Highest severity", SEV[w].label) : ""}</tr></table></td></tr>
${cards}
${moreRow}
<tr><td style="padding:12px 0 0;border-top:1px solid #e4e4e7;font-size:12px;line-height:18px;color:#71717a;">Alerts never include message text, only the rule, tool, server and client. You get this because email alerts are on for this project. Change where alerts go under the project's <b>Settings &rsaquo; Alerts</b>.</td></tr>
</table></td></tr></table></td></tr></table></body></html>`;

  return { subject, text, html };
}
