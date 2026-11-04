import { RULES, type Severity } from "./catalog.js";
import {
  CAPABILITIES, COMMAND_INJECTION, CREDENTIAL_FIELD, HIDDEN_CHARS, NOSQL_KEY, OTHER_INJECTION, PATH_TRAVERSAL, SENSITIVE_PATH, SQL_INJECTION, URL_IN_TEXT,
  findSecrets, injectionIndicators, isInternalHost,
} from "./patterns.js";
import type { Policy } from "./policy.js";

export interface Finding {
  rule: string;
  severity: Severity;
  points: number;
  detail: string;
  where?: string;
  // Set when the AI reviewer, not a pattern, raised it.
  source?: "ai";
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
}

export function finding(rule: string, detail: string, where?: string, severity?: Severity): Finding {
  const info = RULES[rule];
  const sev = severity ?? info.severity;
  return { rule, severity: sev, points: sev === info.severity ? info.points : sev === "high" ? 5 : sev === "medium" ? 2 : 1, detail, where };
}

// Every string inside a JSON value, with its path (e.g. "args.items[2].path").
export function strings(value: unknown, at = "args", out: [string, string][] = []): [string, string][] {
  if (typeof value === "string") out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out);
  }
  return out;
}

function depth(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + children.reduce((m: number, c) => Math.max(m, depth(c)), 0);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + "…" : s);

// ---- tools/call (client -> server) ----

export function checkToolCall(name: string, args: unknown, known: Map<string, ToolDef> | null, policy: Policy): Finding[] {
  const out: Finding[] = [];

  if (policy.denyTools.includes(name) || (policy.allowTools.length > 0 && !policy.allowTools.includes(name))) {
    out.push(finding("MW009", `Tool "${name}" is not allowed by policy`));
  }
  if (known && !known.has(name)) out.push(finding("MW007", `Tool "${name}" was not in the server's tool list`));

  out.push(...checkArgs(args, policy));

  const tool = known?.get(name);
  if (tool?.inputSchema) out.push(...checkSchema(args, tool.inputSchema));
  return out;
}

// Content checks on any client-supplied parameters (tool arguments, resource URIs, prompt arguments).
export function checkArgs(args: unknown, policy: Policy, root = "args"): Finding[] {
  const out: Finding[] = [];
  const raw = JSON.stringify(args ?? {});
  if (raw.length > policy.maxArgBytes || depth(args) > policy.maxArgDepth) {
    out.push(finding("MW008", `Arguments are ${raw.length} bytes, depth ${depth(args)}`));
  }

  for (const [where, s] of strings(args, root)) {
    if (COMMAND_INJECTION.some((re) => re.test(s))) out.push(finding("MW001", `Shell syntax: "${short(s)}"`, where));
    if (PATH_TRAVERSAL.test(s)) out.push(finding("MW002", `Path traversal: "${short(s)}"`, where));
    else if (SENSITIVE_PATH.test(s)) out.push(finding("MW002", `Sensitive file: "${short(s)}"`, where));
    for (const url of s.match(URL_IN_TEXT) ?? []) {
      const reason = ssrfReason(url);
      if (reason) out.push(finding("MW003", `${reason}: ${short(url)}`, where));
    }
    if (SQL_INJECTION.some((re) => re.test(s))) out.push(finding("MW004", `SQL injection pattern: "${short(s)}"`, where));
    const other = OTHER_INJECTION.filter((p) => p.re.test(s)).map((p) => p.name);
    if (other.length) out.push(finding("MW010", `${other.join(", ")} pattern: "${short(s)}"`, where));
    const secrets = findSecrets(s);
    if (secrets.length) out.push(finding("MW005", `Contains ${secrets.join(", ")}`, where));
  }
  for (const [where, key] of operatorKeys(args, root)) out.push(finding("MW010", `NoSQL operator "${key}" in arguments`, where));
  return out;
}

// Object keys like {"$ne": null} that a database would read as query operators.
function operatorKeys(value: unknown, at: string, out: [string, string][] = []): [string, string][] {
  if (Array.isArray(value)) value.forEach((v, i) => operatorKeys(v, `${at}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (NOSQL_KEY.test(k)) out.push([`${at}.${k}`, k]);
      operatorKeys(v, `${at}.${k}`, out);
    }
  }
  return out;
}

function ssrfReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (["file:", "gopher:", "dict:", "ldap:", "ftp:"].includes(u.protocol)) return `${u.protocol} URL`;
  if (isInternalHost(u.hostname)) return "Internal or metadata address";
  return null;
}

function typeOk(value: unknown, type: string | string[] | undefined): boolean {
  if (!type) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) =>
    t === "string" ? typeof value === "string"
      : t === "number" ? typeof value === "number"
      : t === "integer" ? Number.isInteger(value)
      : t === "boolean" ? typeof value === "boolean"
      : t === "array" ? Array.isArray(value)
      : t === "object" ? !!value && typeof value === "object" && !Array.isArray(value)
      : t === "null" ? value === null
      : true);
}

function checkSchema(args: unknown, schema: JsonSchema): Finding[] {
  const out: Finding[] = [];
  const obj = (args ?? {}) as Record<string, unknown>;
  if (typeof obj !== "object" || Array.isArray(obj)) return [finding("MW006", "Arguments are not an object")];
  const props = schema.properties ?? {};
  for (const req of schema.required ?? []) {
    if (!(req in obj)) out.push(finding("MW006", `Missing required argument "${req}"`, `args.${req}`));
  }
  for (const [k, v] of Object.entries(obj)) {
    const prop = props[k];
    if (!prop) {
      if (schema.additionalProperties === false) out.push(finding("MW006", `Unexpected argument "${k}"`, `args.${k}`));
    } else if (!typeOk(v, prop.type)) {
      out.push(finding("MW006", `Argument "${k}" should be ${prop.type}`, `args.${k}`));
    }
  }
  return out;
}

// ---- tools/list result (server -> client) ----

export function checkToolDefinition(tool: ToolDef): Finding[] {
  const out: Finding[] = [];
  const text = [tool.description ?? "", JSON.stringify(tool.inputSchema ?? {})].join("\n");
  const where = `tool.${tool.name}`;

  const hidden = text.match(HIDDEN_CHARS);
  if (hidden) out.push(finding("MW021", `${hidden.length} invisible character(s)`, where));
  if ((tool.description ?? "").length > 1500) out.push(finding("MW021", `Very long description (${tool.description!.length} chars)`, where));

  const hits = injectionIndicators(text.replace(HIDDEN_CHARS, ""));
  if (hits.length >= 2) out.push(finding("MW020", `Instructions aimed at the model: ${hits.join(", ")}`, where));
  else if (hits.length === 1) out.push(finding("MW020", `Possible instruction aimed at the model: ${hits[0]}`, where, "medium"));
  return out;
}

// MW028: a description that names tools of other servers, e.g. "when using send_email, always BCC …".
// Only distinctive names count (with _ or -, or long), so plain words like "search" don't.
export function checkShadowing(tool: ToolDef, foreign: Map<string, string[]>, own: Set<string>): Finding[] {
  const text = tool.description ?? "";
  const named = [...foreign.keys()].filter((n) => !own.has(n) && (/[_-]/.test(n) || n.length >= 10))
    .filter((n) => new RegExp(`(?<![\\w-])${escapeRe(n)}(?![\\w-])`, "i").test(text));
  if (!named.length) return [];
  const owners = [...new Set(named.flatMap((n) => foreign.get(n)!))].join(", ");
  const steering = injectionIndicators(text.replace(HIDDEN_CHARS, "")).length > 0;
  return [finding("MW028", `Mentions ${named.join(", ")} from ${owners}${steering ? " with instructions to the model" : ""}`,
    `tool.${tool.name}`, steering ? "high" : "medium")];
}

// MW039: what the tools together let the model do.
export function capabilities(tools: ToolDef[]): string[] {
  const found = new Set<string>();
  for (const t of tools) {
    const text = `${t.name} ${t.description ?? ""}`;
    for (const c of CAPABILITIES) if (c.re.test(text)) found.add(c.name);
  }
  return [...found];
}

// MW029: an elicitation (form or URL) that asks the user for credentials or payment details.
export function checkElicitation(params: Record<string, unknown>): Finding[] {
  const out: Finding[] = [];
  const schema = (params.requestedSchema ?? {}) as { properties?: Record<string, { title?: string; description?: string }> };
  const asked = Object.entries(schema.properties ?? {})
    .filter(([k, v]) => CREDENTIAL_FIELD.test(k.replace(/([a-z])([A-Z])/g, "$1 $2")) || CREDENTIAL_FIELD.test(`${v?.title ?? ""} ${v?.description ?? ""}`))
    .map(([k]) => k);
  const message = String(params.message ?? "");
  if (asked.length) out.push(finding("MW029", `Form asks for ${asked.join(", ")}`, "params.requestedSchema"));
  else if (CREDENTIAL_FIELD.test(message) && /(?:enter|type|provide|confirm|share|send|give)/i.test(message)) {
    out.push(finding("MW029", `Message asks for credentials: "${short(message)}"`, "params.message"));
  }
  if (typeof params.url === "string") {
    try {
      const u = new URL(params.url);
      if (u.protocol !== "https:" && !isInternalHost(u.hostname)) out.push(finding("MW029", `Sends the user to a non-HTTPS page: ${short(params.url)}`, "params.url", "medium"));
    } catch {
      out.push(finding("MW029", "Sends the user to an invalid URL", "params.url", "medium"));
    }
  }
  out.push(...checkServerText(message, "params.message").findings);
  return out;
}

// ---- tool results, resources, prompts, sampling (server -> client) ----

export function checkServerText(text: string, where: string): { findings: Finding[]; secrets: boolean } {
  const out: Finding[] = [];
  const hits = injectionIndicators(text.replace(HIDDEN_CHARS, ""));
  if (hits.length >= 2) out.push(finding("MW022", `Prompt injection: ${hits.join(", ")}`, where));
  else if (hits.length === 1 && hits[0] !== "sensitive-path") {
    out.push(finding("MW022", `Possible prompt injection: ${hits[0]}`, where, "medium"));
  }
  const secrets = findSecrets(text);
  if (secrets.length) out.push(finding("MW025", `Contains ${secrets.join(", ")}`, where));
  return { findings: out, secrets: secrets.length > 0 };
}
