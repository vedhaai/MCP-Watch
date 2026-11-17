import type { Mode } from "@vedhaai/mcpwatch";

export type ProjectKind = "middleware" | "middleware-python" | "middleware-java" | "proxy-stdio" | "proxy-http";
export type AiProvider = "off" | "local" | "api";

export interface Project {
  id: string;
  // The dashboard user who owns it. Projects from before accounts existed go to the first user.
  ownerId?: string;
  name: string;
  kind: ProjectKind;
  key: string;
  mode: Mode;
  windowSeconds: number;
  throttleAt: number;
  blockAt: number;
  denyTools: string[];
  clients: ClientLists;
  // Transport rules (HTTP servers): allowed web origins, required auth, expected token audience.
  allowedOrigins: string[];
  requireAuth: boolean;
  expectedAudience: string;
  // Who reviews each message on top of the pattern rules: nobody (rules only), a local model, or a
  // model behind an API key. The guard calls the model itself; the dashboard only hands it these settings.
  ai: ProjectAi;
  // Where to tell people when the guard finds something. Off until the owner turns it on.
  alerts: ProjectAlerts;
  version: number;
  createdAt: string;
  lastSeenAt: string | null;
  // The last time a guard reported that its checks were failing; null when it never has.
  engineIssue?: EngineIssue | null;
}

export interface EngineIssue {
  // When the dashboard received the report (its own clock, not the guard's).
  at: string;
  // Checks that failed in that report.
  errors: number;
  // True: messages passed unchecked. False: requests were refused.
  failOpen: boolean;
}

export interface ClientLists {
  block: string[];
  allow: string[];
}

export interface ProjectAi {
  provider: AiProvider;
  // OpenAI-compatible base URL and model. Empty for "local" means Ollama with qwen2.5:7b.
  url: string;
  model: string;
  // Only for "api". Stored here and sent to the project's guards; never sent back to the browser.
  apiKey: string;
  // For a model that is not on the guard's machine: the owner confirmed that message text may be sent
  // there. Saving such a model without it is refused. Settings saved before this existed have none and
  // keep working (they were chosen on purpose); only an explicit `false` withholds it from the guards.
  hostedConsent?: boolean;
}

export type AlertSeverity = "high" | "medium" | "low";

export interface ProjectAlerts {
  enabled: boolean;
  // Alert on an event whose worst finding is at least this severe.
  minSeverity: AlertSeverity;
  // Also alert whenever the guard blocked or throttled a message, whatever its findings.
  onBlock: boolean;
  // At most one alert per this many seconds; events in between are counted in the next one.
  cooldownSeconds: number;
  // Recipients, and the SMTP server that sends to them. Email is only sent when a host and a from address are set.
  emails: string[];
  smtpHost: string;
  smtpPort: number;
  // true: TLS from the first byte (port 465); false: STARTTLS when the server offers it.
  smtpSecure: boolean;
  smtpUser: string;
  // Secret: stored encrypted, never sent back to the browser.
  smtpPass: string;
  smtpFrom: string;
  // Secrets: a Slack incoming-webhook URL and a webhook URL both carry their access in the address.
  // Stored encrypted and never sent back to the browser.
  slackUrl: string;
  webhookUrl: string;
  // Signs each webhook body (HMAC-SHA256) so the receiver can tell it came from this dashboard.
  webhookSecret: string;
}

export const ALERTS_OFF: ProjectAlerts = {
  enabled: false, minSeverity: "high", onBlock: true, cooldownSeconds: 300, emails: [],
  smtpHost: "", smtpPort: 587, smtpSecure: false, smtpUser: "", smtpPass: "", smtpFrom: "", slackUrl: "", webhookUrl: "", webhookSecret: "",
};

export const LOCAL_AI ={ url: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" };
export const AI_OFF: ProjectAi = { provider: "off", url: "", model: "", apiKey: "" };
