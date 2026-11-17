import { createHmac } from "node:crypto";
import type { McpEvent } from "@vedhaai/mcpwatch";
import nodemailer from "nodemailer";
import { HttpError } from "../errors.js";
import type { AlertSettingsInput, AlertTestResult } from "../models/api.js";
import type { AlertSeverity, Project, ProjectAlerts } from "../models/project.js";
import { LOGO_CID, logoPng, renderAlertEmail } from "./alert-email.js";
import { assertReachable } from "./safe-url.js";

type Channel = AlertTestResult["results"][number]["channel"];

const RANK: Record<AlertSeverity, number> = { low: 1, medium: 2, high: 3 };
const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const SEND_TIMEOUT_MS = 8000;
const MAX_EMAILS = 10;
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

// Whoever runs the dashboard decides whether alert URLs may point at their own network (an internal
// webhook receiver). A signed-in user cannot, same line as the AI provider URL.
const ALLOW_PRIVATE = process.env.MCPWATCH_ALERTS_ALLOW_PRIVATE === "1";

// What an alert says. It names the rule, tool and server but never the message text (`snippet`): that text
// is what the guard was protecting, and it can hold personal data or secrets.
export interface AlertPayload {
  project: { id: string; name: string };
  summary: string;
  count: number;
  // How many of `count` were blocked. `events` lists at most 5, so this can't be worked out from it.
  blocked: number;
  suppressed: number;
  events: { time: string; server: string; client: string; tool?: string; method: string; action: string; score: number; rules: { id: string; severity: string }[] }[];
  sample?: true;
}

const worst = (e: McpEvent): AlertSeverity | null =>
  e.findings.reduce<AlertSeverity | null>((w, f) => (!w || RANK[f.severity] > RANK[w] ? f.severity : w), null);

// Email is sent only when the project has a mail server and a from address, and someone to send to.
const smtpReady = (a: ProjectAlerts) => !!a.smtpHost && !!a.smtpFrom && a.emails.length > 0;
// Ports for mail only, so the SMTP box can't be used to probe other services on a host.
const SMTP_PORTS = new Set([25, 465, 587, 2525]);
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };
export { hostOf as alertHost };

export class AlertService {
  // When each project last sent, and how many matching events were held back since.
  private last = new Map<string, { at: number; held: number }>();

  // Settings from the form, checked. `current` keeps a saved URL or secret when its field is left empty.
  async fromInput(input: AlertSettingsInput, current: ProjectAlerts): Promise<ProjectAlerts> {
    const cooldown = Number(input.cooldownSeconds);
    if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 86_400) throw new HttpError(400, "Cooldown must be between 0 and 86400 seconds");
    if (!(input.minSeverity in RANK)) throw new HttpError(400, "Severity must be high, medium or low");
    const emails = [...new Set((input.emails ?? current.emails).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (emails.length > MAX_EMAILS) throw new HttpError(400, `At most ${MAX_EMAILS} email addresses`);
    for (const e of emails) if (e.length > 254 || !EMAIL.test(e)) throw new HttpError(400, `"${e.slice(0, 60)}" is not an email address`);

    const out: ProjectAlerts = {
      enabled: input.enabled === true, minSeverity: input.minSeverity, onBlock: input.onBlock === true,
      cooldownSeconds: Math.floor(cooldown), emails, slackUrl: current.slackUrl, webhookUrl: current.webhookUrl, webhookSecret: current.webhookSecret,
      smtpHost: current.smtpHost, smtpPort: current.smtpPort, smtpSecure: current.smtpSecure, smtpUser: current.smtpUser, smtpPass: current.smtpPass, smtpFrom: current.smtpFrom,
    };
    if (input.smtpHost !== undefined) out.smtpHost = input.smtpHost.trim().toLowerCase().slice(0, 253);
    if (input.smtpPort !== undefined) out.smtpPort = Number(input.smtpPort);
    if (input.smtpSecure !== undefined) out.smtpSecure = input.smtpSecure === true;
    if (input.smtpUser !== undefined) out.smtpUser = input.smtpUser.trim().slice(0, 254);
    if (input.smtpFrom !== undefined) out.smtpFrom = input.smtpFrom.trim().slice(0, 254);
    if (input.smtpPass?.trim()) out.smtpPass = input.smtpPass.slice(0, 500);
    // A clear flag wins over whatever else the form sent: the form still carries the old values.
    if (input.clearSmtp === true) Object.assign(out, { emails: [], smtpHost: "", smtpPort: 587, smtpSecure: false, smtpUser: "", smtpPass: "", smtpFrom: "" });
    if (out.smtpHost) {
      if (!HOSTNAME.test(out.smtpHost)) throw new HttpError(400, "SMTP host must be a host name or address, like smtp.example.com");
      if (!SMTP_PORTS.has(out.smtpPort)) throw new HttpError(400, "SMTP port must be 25, 465, 587 or 2525");
      if (!EMAIL.test(out.smtpFrom)) throw new HttpError(400, "Enter the address emails are sent from");
      // Same rule as a webhook: the mail server has to be on the internet, unless whoever runs the dashboard says otherwise.
      await assertReachable(`https://${out.smtpHost}`, ALLOW_PRIVATE ? "private" : "public", "SMTP host");
    }
    // Without a server there is nothing to send email with, so recipients can't be saved.
    if (out.emails.length && !out.smtpHost) throw new HttpError(400, "Add an SMTP server to send email, or remove the email addresses");
    if (input.slackUrl?.trim()) out.slackUrl = input.slackUrl.trim().slice(0, 500);
    if (input.webhookUrl?.trim()) out.webhookUrl = input.webhookUrl.trim().slice(0, 500);
    if (input.webhookSecret?.trim()) out.webhookSecret = input.webhookSecret.trim().slice(0, 200);
    if (input.clearSlack === true) out.slackUrl = "";
    if (input.clearWebhook === true) { out.webhookUrl = ""; out.webhookSecret = ""; }

    if (out.slackUrl) await this.assertSlack(out.slackUrl);
    if (out.webhookUrl) await assertReachable(out.webhookUrl, ALLOW_PRIVATE ? "private" : "public", "Webhook URL");
    if (out.enabled && !out.emails.length && !out.slackUrl && !out.webhookUrl) throw new HttpError(400, "Add an email address, a Slack URL or a webhook URL, or turn alerts off");
    return out;
  }

  // A Slack incoming-webhook URL is always https://hooks.slack.com/..., so nothing else is accepted: it keeps
  // the "Slack" box from being a second, unrestricted webhook.
  private async assertSlack(raw: string) {
    let u: URL;
    try { u = new URL(raw); } catch { throw new HttpError(400, "Slack URL is not a valid URL"); }
    if (u.protocol !== "https:" || !SLACK_HOSTS.has(u.hostname)) throw new HttpError(400, "Slack URL must be an incoming webhook: https://hooks.slack.com/services/…");
    await assertReachable(raw, "public", "Slack URL");
  }

  // Called with each batch of events a guard reports. Never throws and never waits for the network: a slow
  // Slack must not slow the guard's report.
  notify(p: Project, events: McpEvent[]): void {
    const a = p.alerts;
    if (!a?.enabled) return;
    const hits = events.filter((e) => this.matches(a, e));
    if (!hits.length) return;
    const state = this.last.get(p.id) ?? { at: 0, held: 0 };
    const now = Date.now();
    if (now - state.at < a.cooldownSeconds * 1000) {
      this.last.set(p.id, { at: state.at, held: state.held + hits.length });
      return;
    }
    this.last.set(p.id, { at: now, held: 0 });
    const payload = this.payload(p, hits, state.held);
    void this.deliver(a, payload).then((results) => {
      for (const r of results) if (!r.ok) console.warn(`alert to ${r.channel} for project ${p.id} failed: ${r.error}`);
    });
  }

  private matches(a: ProjectAlerts, e: McpEvent): boolean {
    if (a.onBlock && (e.action === "block" || e.action === "throttle")) return true;
    const w = worst(e);
    return !!w && RANK[w] >= RANK[a.minSeverity];
  }

  private payload(p: Project, hits: McpEvent[], suppressed: number, sample = false): AlertPayload {
    const blocked = hits.filter((e) => e.action === "block").length;
    return {
      project: { id: p.id, name: p.name },
      summary: `${hits.length} alert${hits.length === 1 ? "" : "s"} in ${p.name}${blocked ? `, ${blocked} blocked` : ""}${suppressed ? ` (+${suppressed} more since the last alert)` : ""}`,
      count: hits.length, blocked, suppressed,
      events: hits.slice(0, 5).map((e) => ({
        time: e.time, server: e.server, client: e.clientName || e.client, tool: e.tool, method: e.method, action: e.action, score: e.score,
        rules: e.findings.slice(0, 10).map((f) => ({ id: f.rule, severity: f.severity })),
      })),
      ...(sample ? { sample: true as const } : {}),
    };
  }

  // Sends a sample through every channel in these settings (saved, or the unsaved ones in the form).
  async test(p: Project, a: ProjectAlerts): Promise<AlertTestResult> {
    const sample: McpEvent = {
      time: new Date().toISOString(), server: "example-server", session: "", client: "example-client", clientName: "example-client",
      direction: "client->server", method: "tools/call", tool: "read_file", mode: p.mode, action: "block", enforceAction: "block", score: 8,
      findings: [{ rule: "MW001", severity: "high", points: 8, detail: "" }],
    };
    return { results: await this.deliver(a, { ...this.payload(p, [sample], 0, true), summary: `Test alert from MCPWatch for ${p.name}` }) };
  }

  private async deliver(a: ProjectAlerts, payload: AlertPayload): Promise<AlertTestResult["results"]> {
    const jobs: [Channel, () => Promise<void>][] = [];
    if (smtpReady(a)) jobs.push(["email", () => this.email(a, payload)]);
    if (a.slackUrl) jobs.push(["slack", () => this.slack(a.slackUrl, payload)]);
    if (a.webhookUrl) jobs.push(["webhook", () => this.webhook(a.webhookUrl, a.webhookSecret, payload)]);
    return Promise.all(jobs.map(async ([channel, send]) => {
      try {
        await send();
        return { channel, ok: true };
      } catch (e) {
        // The message can contain the URL (fetch errors do); only the part safe to show is kept.
        return { channel, ok: false, error: (e instanceof HttpError ? e.message : (e as Error).message ?? "failed").replace(/https?:\/\/\S+/g, "<url>").slice(0, 200) };
      }
    }));
  }

  private async post(url: string, body: string, headers: Record<string, string>, reach: "public" | "private") {
    // Checked again at send time: a name can resolve somewhere else than it did when saved.
    await assertReachable(url, reach, "Alert URL");
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    // A redirect could lead anywhere, including inside the network, so it counts as a failure.
    if (res.status >= 300) throw new Error(`receiver answered ${res.status}`);
  }

  private async slack(url: string, p: AlertPayload) {
    const lines = p.events.map((e) => `• \`${e.rules.map((r) => r.id).join(", ") || "-"}\` ${e.action}: ${e.tool ?? e.method} on ${e.server || "unknown server"} (client ${e.client || "unknown"})`);
    const text = `:rotating_light: *${p.summary}*\n${lines.join("\n")}`;
    await this.post(url, JSON.stringify({ text }), {}, "public");
  }

  private async webhook(url: string, secret: string, p: AlertPayload) {
    const body = JSON.stringify({ type: "mcpwatch.alert", ...p });
    const headers: Record<string, string> = {};
    if (secret) {
      // The timestamp is signed too, so a captured request can't be replayed later without detection.
      const ts = String(Math.floor(Date.now() / 1000));
      headers["X-MCPWatch-Timestamp"] = ts;
      headers["X-MCPWatch-Signature"] = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    }
    await this.post(url, body, headers, ALLOW_PRIVATE ? "private" : "public");
  }

  private async email(a: ProjectAlerts, p: AlertPayload) {
    // Checked again at send time: a name can resolve somewhere else than it did when saved.
    await assertReachable(`https://${a.smtpHost}`, ALLOW_PRIVATE ? "private" : "public", "SMTP host");
    const transport = nodemailer.createTransport({
      host: a.smtpHost, port: a.smtpPort, secure: a.smtpSecure,
      // Never send a password in the clear. Port 25 without a login may stay unencrypted (it is how servers talk to each other).
      requireTLS: !a.smtpSecure && (a.smtpPort !== 25 || !!a.smtpUser),
      ...(a.smtpUser ? { auth: { user: a.smtpUser, pass: a.smtpPass } } : {}),
      connectionTimeout: SEND_TIMEOUT_MS, greetingTimeout: SEND_TIMEOUT_MS, socketTimeout: SEND_TIMEOUT_MS,
    });
    const mail = renderAlertEmail(p);
    try {
      await transport.sendMail({
        from: a.smtpFrom, to: a.emails, subject: mail.subject, text: mail.text, html: mail.html,
        attachments: [{ filename: "mcpwatch.png", content: logoPng(), cid: LOGO_CID, contentType: "image/png", contentDisposition: "inline" }],
      });
    } finally {
      transport.close();
    }
  }
}
