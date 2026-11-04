import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import spawn from "cross-spawn";
import { RULES } from "./catalog.js";
import type { McpEvent } from "./events.js";
import { HeaderwatchSink } from "./headerwatch.js";
import { findSecrets, isInternalHost, redactSecrets } from "./patterns.js";
import { capabilities, checkToolDefinition, finding, type Finding, type ToolDef } from "./rules.js";

// `mcpwatch scan`: checks the MCP servers configured in the clients on this machine (Claude Desktop,
// Claude Code, Cursor, VS Code, Windsurf) before any of them runs: typosquatted packages, risky
// launch commands, unpinned versions, plaintext secrets, over-broad access, and changes since the
// last accepted scan (config tampering). With --connect it also starts each server and checks its
// tool definitions, which runs the server's code.

export interface ServerEntry {
  client: string;
  file: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ServerReport {
  entry: ServerEntry;
  findings: Finding[];
  tools?: number;
  serverInfo?: string;
  error?: string;
}

export interface ScanOptions {
  files?: string[];
  baselineFile: string;
  accept?: boolean;
  connect?: boolean;
  timeoutMs?: number;
}

const HOME = os.homedir();
const tilde = (p: string) => (p.toLowerCase().startsWith(HOME.toLowerCase()) ? "~" + p.slice(HOME.length) : p);

// ---- where MCP clients keep their server lists ----

export function defaultConfigFiles(cwd = process.cwd()): { client: string; file: string }[] {
  const appData = process.env.APPDATA ?? path.join(HOME, "AppData", "Roaming");
  const list = [
    { client: "Claude Desktop", file: path.join(appData, "Claude", "claude_desktop_config.json") },
    { client: "Claude Desktop", file: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json") },
    { client: "Claude Desktop", file: path.join(HOME, ".config", "Claude", "claude_desktop_config.json") },
    { client: "Claude Code", file: path.join(HOME, ".claude.json") },
    { client: "Claude Code (project)", file: path.join(cwd, ".mcp.json") },
    { client: "Cursor", file: path.join(HOME, ".cursor", "mcp.json") },
    { client: "Cursor (project)", file: path.join(cwd, ".cursor", "mcp.json") },
    { client: "VS Code", file: path.join(appData, "Code", "User", "mcp.json") },
    { client: "VS Code (project)", file: path.join(cwd, ".vscode", "mcp.json") },
    { client: "Windsurf", file: path.join(HOME, ".codeium", "windsurf", "mcp_config.json") },
  ];
  return list.filter((c) => existsSync(c.file));
}

// Only the server lists are read; nothing else in these files (e.g. ~/.claude.json history) is kept.
export function readServers(client: string, file: string): ServerEntry[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const out: ServerEntry[] = [];
  const add = (servers: unknown, where = "") => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(servers as Record<string, Record<string, unknown>>)) {
      if (!raw || typeof raw !== "object") continue;
      out.push({
        client, file, name: where ? `${name} (${where})` : name,
        command: typeof raw.command === "string" ? raw.command : undefined,
        args: Array.isArray(raw.args) ? raw.args.map(String) : [],
        env: raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : {},
        url: typeof raw.url === "string" ? raw.url : typeof raw.serverUrl === "string" ? raw.serverUrl : undefined,
        headers: raw.headers && typeof raw.headers === "object" ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, String(v)])) : {},
      });
    }
  };
  add(json.mcpServers);
  add(json.servers);
  // Claude Code keeps per-project servers under projects.<path>.mcpServers.
  if (json.projects && typeof json.projects === "object") {
    for (const [dir, p] of Object.entries(json.projects as Record<string, { mcpServers?: unknown }>)) {
      add(p?.mcpServers, path.basename(dir));
    }
  }
  return out;
}

// ---- static checks ----

// Well-known MCP server packages. A name one or two edits away from one of these is a typosquat.
const KNOWN_PACKAGES = [
  "@modelcontextprotocol/server-filesystem", "@modelcontextprotocol/server-github", "@modelcontextprotocol/server-gitlab",
  "@modelcontextprotocol/server-memory", "@modelcontextprotocol/server-everything", "@modelcontextprotocol/server-postgres",
  "@modelcontextprotocol/server-puppeteer", "@modelcontextprotocol/server-brave-search", "@modelcontextprotocol/server-google-maps",
  "@modelcontextprotocol/server-slack", "@modelcontextprotocol/server-sequential-thinking", "@modelcontextprotocol/server-redis",
  "@modelcontextprotocol/server-gdrive", "@modelcontextprotocol/inspector",
  "@playwright/mcp", "@upstash/context7-mcp", "@notionhq/notion-mcp-server", "@stripe/mcp", "@supabase/mcp-server-supabase",
  "@sentry/mcp-server", "@browserbasehq/mcp", "@azure/mcp", "mcp-remote", "firecrawl-mcp",
  "mcp-server-fetch", "mcp-server-git", "mcp-server-time", "mcp-server-sqlite",
];

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const RUNNERS = new Set(["npx", "bunx", "uvx", "pipx", "pnpx"]);
// Flags of `docker run` that take a value, so the image name can be found after them.
const DOCKER_VALUE_FLAGS = new Set(["-e", "--env", "-v", "--volume", "--name", "-p", "--publish", "--env-file", "--network", "--net",
  "-u", "--user", "--mount", "-w", "--workdir", "--entrypoint", "--cap-add", "--pid", "-l", "--label", "--platform"]);

const base = (cmd: string) => path.basename(cmd).toLowerCase().replace(/\.(cmd|exe|bat)$/, "");

// The package a runner (npx, uvx …) will download and run, if any.
export function packageOf(command: string | undefined, args: string[]): { kind: "npm" | "pypi" | "docker"; spec: string } | undefined {
  if (!command) return undefined;
  const cmd = base(command);
  let rest = args;
  if ((cmd === "pnpm" || cmd === "yarn") && (args[0] === "dlx")) rest = args.slice(1);
  else if (cmd === "pipx" && args[0] === "run") rest = args.slice(1);
  else if (cmd === "docker" || cmd === "podman") {
    const i = args.indexOf("run");
    if (i === -1) return undefined;
    for (let j = i + 1; j < args.length; j++) {
      const a = args[j];
      if (DOCKER_VALUE_FLAGS.has(a)) j++;
      else if (!a.startsWith("-")) return { kind: "docker", spec: a };
    }
    return undefined;
  } else if (!RUNNERS.has(cmd) && cmd !== "pnpm" && cmd !== "yarn") return undefined;
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (a === "-p" || a === "--package" || a === "--from") return { kind: cmd === "uvx" || cmd === "pipx" ? "pypi" : "npm", spec: rest[j + 1] ?? "" };
    if (a.startsWith("--package=") || a.startsWith("--from=")) return { kind: cmd === "uvx" ? "pypi" : "npm", spec: a.split("=").slice(1).join("=") };
    if (!a.startsWith("-")) return { kind: cmd === "uvx" || cmd === "pipx" ? "pypi" : "npm", spec: a };
  }
  return undefined;
}

// "@scope/name@1.2.3" -> name "@scope/name", version "1.2.3"; "pkg==1.0" (PyPI) likewise.
function splitSpec(spec: string): { name: string; version?: string } {
  const py = /^([^=<>~!@]+)(?:==|@)(.+)$/.exec(spec);
  if (!spec.startsWith("@") && py) return { name: py[1].toLowerCase(), version: py[2] };
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at).toLowerCase(), version: spec.slice(at + 1) } : { name: spec.toLowerCase() };
}

const SUSPICIOUS: { re: RegExp; why: string; severity: "high" | "medium" }[] = [
  { re: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(?:sh|bash|zsh|iex|powershell|pwsh|python3?|node)\b/i, why: "downloads a script and runs it", severity: "high" },
  { re: /\b(?:powershell|pwsh)(?:\.exe)?\b.*\s-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i, why: "runs an encoded PowerShell command", severity: "high" },
  { re: /\b(?:iex|invoke-expression)\b/i, why: "evaluates a string as PowerShell", severity: "high" },
  { re: /\bbase64\s+(?:-d|--decode)\b|frombase64string/i, why: "decodes hidden content", severity: "high" },
  { re: /(?:^|\s)(?:node|python3?|ruby|perl|deno)(?:\.exe)?\s+(?:-e|-c|--eval)\s/i, why: "runs an inline script instead of a package", severity: "medium" },
  { re: /(?:^|\s)(?:npx|bunx|pnpx|uvx)\s+(?:-\S+\s+)*(?:https?:|git\+|github:|gist:)/i, why: "runs code straight from a URL, not a registry", severity: "medium" },
  { re: /(?:^|[\s"'])(?:\/tmp\/|\/var\/tmp\/|[a-z]:\\(?:windows\\)?temp\\|%temp%|\$env:temp)/i, why: "runs a program from a temp folder", severity: "medium" },
];

const SECRET_KEY = /token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth/i;
// ${VAR}, $VAR, ${input:x}, ${env:X}: a reference, not the secret itself.
const IS_REFERENCE = /^\$\{[^}]+\}$|^\$[A-Z_][A-Z0-9_]*$|^env:|^op:\/\/|^keychain:/i;

const BROAD_PATHS = (p: string) => {
  const v = p.replace(/[\\/]+$/, "").toLowerCase();
  return v === "" || v === "~" || v === "$home" || /^[a-z]:$/.test(v) || v === HOME.toLowerCase().replace(/[\\/]+$/, "")
    || v === "/home" || v === "/users" || v === "c:\\users" || v === "/root" || v === "/etc";
};

export function checkEntry(e: ServerEntry): Finding[] {
  const out: Finding[] = [];
  const args = e.args ?? [];
  const line = [e.command ?? "", ...args].join(" ");

  // MS001 / MS003: the package that gets downloaded.
  const pkg = packageOf(e.command, args);
  if (pkg && pkg.kind !== "docker") {
    const { name, version } = splitSpec(pkg.spec);
    if (!KNOWN_PACKAGES.includes(name)) {
      const near = KNOWN_PACKAGES.find((k) => name.length >= 6 && distance(name, k) <= 2);
      const unscoped = KNOWN_PACKAGES.find((k) => k.startsWith("@") && k.split("/")[1] === name);
      const sameName = KNOWN_PACKAGES.find((k) => k.startsWith("@") && name.startsWith("@") && k.split("/")[1] === name.split("/")[1]);
      const like = near ?? unscoped ?? sameName;
      if (like) out.push(finding("MS001", `"${name}" looks like "${like}"`, "args"));
    }
    if (!version || version === "latest" || /^[\^~*]|^>=?/.test(version)) {
      out.push(finding("MS003", `${name} runs ${version ? `@${version}` : "the newest version"} on every start; pin a version`, "args"));
    }
  } else if (pkg?.kind === "docker") {
    const image = pkg.spec;
    if (!image.includes("@sha256:") && (!/:[\w.-]+$/.test(image.split("/").pop() ?? "") || image.endsWith(":latest"))) {
      out.push(finding("MS003", `Image ${image} has no fixed tag or digest`, "args"));
    }
  }

  // MS002: how the server is launched.
  for (const s of SUSPICIOUS) if (s.re.test(line)) out.push(finding("MS002", `Launch command ${s.why}`, "command", s.severity));
  const nodeOptions = e.env?.NODE_OPTIONS ?? "";
  if (/--(?:require|import|loader|experimental-loader)\b|(?:^|\s)-r\s/.test(nodeOptions)) {
    out.push(finding("MS002", "NODE_OPTIONS loads extra code into the server", "env.NODE_OPTIONS"));
  }
  for (const k of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONSTARTUP"]) {
    if (e.env?.[k]) out.push(finding("MS002", `${k} injects code into the server`, `env.${k}`));
  }

  // MS004: secrets written into the config. Only key names are reported, never values.
  for (const [k, v] of [...Object.entries(e.env ?? {}), ...Object.entries(e.headers ?? {})]) {
    if (!v || IS_REFERENCE.test(v.trim())) continue;
    const kinds = findSecrets(v);
    if (kinds.length || (SECRET_KEY.test(k) && v.length >= 8)) {
      out.push(finding("MS004", `${k} holds ${kinds.length ? kinds.join(", ") : "a secret"} in plaintext; use an env reference or keychain`, `env.${k}`));
    }
  }
  const argSecrets = findSecrets(args.join(" "));
  if (argSecrets.length) out.push(finding("MS004", `Arguments contain ${argSecrets.join(", ")}`, "args"));
  if (args.some((a, i) => /^--?(?:token|api-?key|password|secret)(?:=.{8,})?$/i.test(a) && (a.includes("=") || (args[i + 1] ?? "").length >= 8))) {
    if (!argSecrets.length) out.push(finding("MS004", "A secret is passed as a command-line argument", "args"));
  }

  // MS005: more access than a tool server should have.
  const docker = pkg?.kind === "docker";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1] ?? "";
    if (docker) {
      if (a === "--privileged") out.push(finding("MS005", "Container runs --privileged", "args", "high"));
      if ((a === "--network" || a === "--net") && next === "host" || /^--net(?:work)?=host$/.test(a)) out.push(finding("MS005", "Container shares the host network", "args"));
      if (a === "--pid" && next === "host") out.push(finding("MS005", "Container shares the host's processes", "args"));
      if (/^--cap-add(?:=)?(?:ALL|SYS_ADMIN)?$/.test(a) && (/ALL|SYS_ADMIN/.test(a) || /^(?:ALL|SYS_ADMIN)$/.test(next))) out.push(finding("MS005", "Container gets extra kernel capabilities", "args", "high"));
      if ((a === "-u" || a === "--user") && /^(?:0|root)(?::|$)/.test(next)) out.push(finding("MS005", "Container runs as root", "args", "low"));
      if (a === "-v" || a === "--volume" || a === "--mount") {
        const src = a === "--mount" ? (/(?:src|source)=([^,]+)/.exec(next)?.[1] ?? "") : next.split(":").slice(0, /^[a-z]:/i.test(next) ? 2 : 1).join(":");
        if (/docker\.sock/.test(next)) out.push(finding("MS005", "Container can control Docker (docker.sock mounted)", "args", "high"));
        else if (BROAD_PATHS(src)) out.push(finding("MS005", `Container mounts ${tilde(src) || "/"}`, "args"));
      }
    } else if (!a.startsWith("-") && i > 0 && BROAD_PATHS(a)) {
      out.push(finding("MS005", `"${tilde(a) || "/"}" gives the server a whole disk or home folder`, "args"));
    } else if (a === "/" && i > 0) {
      out.push(finding("MS005", `"/" gives the server the whole disk`, "args"));
    }
  }

  // MS007: remote servers over plain HTTP.
  if (e.url) {
    try {
      const u = new URL(e.url);
      if (u.protocol === "http:" && !isInternalHost(u.hostname)) out.push(finding("MS007", `${u.host} is reached over plain HTTP`, "url"));
    } catch {
      // not a URL: nothing to check
    }
  }
  return out;
}

// ---- baseline: what the configs looked like at the last accepted scan (MS006) ----

interface BaselineEntry { config: string; tools?: string; server?: string; acceptedAt: string }
type Baseline = Record<string, BaselineEntry>;

const fp = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const keyOf = (e: ServerEntry) => `${tilde(e.file)}#${e.name}`;
// Everything that decides what runs, env values included (hashed, never stored).
const configPrint = (e: ServerEntry) => fp({ c: e.command, a: e.args, u: e.url, env: e.env, h: e.headers });

function loadBaseline(file: string): Baseline | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveBaseline(file: string, b: Baseline) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(b, null, 2));
}

// ---- --connect: start the server and ask for its tools ----

type Rpc = (method: string, params?: unknown) => Promise<Record<string, unknown>>;

async function withStdio<T>(e: ServerEntry, timeoutMs: number, fn: (rpc: Rpc, notify: (m: string) => void) => Promise<T>): Promise<T> {
  const child = spawn(e.command!, e.args ?? [], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...e.env } });
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  let id = 0;
  readline.createInterface({ input: child.stdout! }).on("line", (l) => {
    try {
      const m = JSON.parse(l);
      waiting.get(m.id)?.(m);
    } catch {
      // not JSON-RPC (a log line on stdout)
    }
  });
  const failed = new Promise<never>((_, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`server exited (code ${code})`)));
    setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs).unref();
  });
  const rpc: Rpc = (method, params) => {
    const n = ++id;
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    return Promise.race([new Promise<Record<string, unknown>>((r) => waiting.set(n, r)), failed]);
  };
  const notify = (method: string) => child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  try {
    return await fn(rpc, notify);
  } finally {
    child.kill();
  }
}

async function withHttp<T>(e: ServerEntry, timeoutMs: number, fn: (rpc: Rpc, notify: (m: string) => void) => Promise<T>): Promise<T> {
  let session: string | null = null;
  let id = 0;
  const post = async (body: unknown) => {
    const res = await fetch(e.url!, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...e.headers, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    return res;
  };
  const rpc: Rpc = async (method, params) => {
    const n = ++id;
    const res = await post({ jsonrpc: "2.0", id: n, method, params });
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    const text = await res.text();
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const m = JSON.parse(line.slice(5));
        if (m.id === n) return m;
      }
      throw new Error("no answer in the event stream");
    }
    return JSON.parse(text);
  };
  return fn(rpc, (method) => void post({ jsonrpc: "2.0", method }).catch(() => {}));
}

async function fetchTools(e: ServerEntry, timeoutMs: number): Promise<{ serverInfo: string; tools: ToolDef[] }> {
  const run = e.url ? withHttp : e.command ? withStdio : null;
  if (!run) throw new Error("no command or url");
  return run(e, timeoutMs, async (rpc, notify) => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpwatch-scan", version: "0.1.0" } });
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error).slice(0, 200)}`);
    const info = ((init.result as Record<string, unknown>)?.serverInfo ?? {}) as { name?: string; version?: string };
    notify("notifications/initialized");
    const tools: ToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await rpc("tools/list", cursor ? { cursor } : {});
      const result = (r.result ?? {}) as { tools?: ToolDef[]; nextCursor?: string };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return { serverInfo: `${info.name ?? "?"}@${info.version ?? "?"}`, tools };
  });
}

// ---- the scan ----

export async function scan(opts: ScanOptions, extra: ServerEntry[] = []): Promise<{ reports: ServerReport[]; baselineCreated: boolean; removed: string[] }> {
  const configs = opts.files?.length ? opts.files.map((f) => ({ client: path.basename(f), file: path.resolve(f) })) : defaultConfigFiles();
  const entries = [...configs.flatMap((c) => readServers(c.client, c.file)), ...extra];
  const old = loadBaseline(opts.baselineFile);
  const next: Baseline = { ...(old ?? {}) };
  const reports: ServerReport[] = [];

  for (const e of entries) {
    const r: ServerReport = { entry: e, findings: checkEntry(e) };
    const key = keyOf(e);
    const was = old?.[key];
    const config = configPrint(e);
    if (old && !was) r.findings.push(finding("MS006", "Server was added since the last accepted scan"));
    else if (was && was.config !== config) r.findings.push(finding("MS006", "Command, arguments, URL or environment changed since the last accepted scan"));

    let tools: string | undefined;
    let server: string | undefined;
    if (opts.connect) {
      try {
        const got = await fetchTools(e, opts.timeoutMs ?? 20_000);
        r.tools = got.tools.length;
        r.serverInfo = server = got.serverInfo;
        for (const t of got.tools) r.findings.push(...checkToolDefinition(t));
        const caps = capabilities(got.tools);
        if (caps.includes("shell") || caps.includes("payments") || caps.length >= 3) {
          r.findings.push(finding("MW039", `Tools can: ${caps.join(", ")}`));
        }
        tools = fp(got.tools.map((t) => [t.name, t.description ?? "", t.inputSchema ?? {}]).sort());
        if (was?.tools && was.tools !== tools) r.findings.push(finding("MW024", "Tool definitions changed since the last accepted scan"));
        if (was?.server && was.server !== server) r.findings.push(finding("MW038", `Server was ${was.server}, is now ${server}`));
      } catch (err) {
        r.error = (err as Error).message;
      }
    }
    // The first scan is trusted (as with pins). After that, additions and changes keep being reported
    // until --accept; only tool fingerprints missing from an unchanged entry are filled in.
    if (!old || opts.accept) next[key] = { config, tools, server, acceptedAt: new Date().toISOString() };
    else if (was && was.config === config && !was.tools && tools) next[key] = { ...was, tools, server };
    reports.push(r);
  }

  const seen = new Set(entries.map(keyOf));
  const removed = old ? Object.keys(old).filter((k) => !seen.has(k)) : [];
  if (opts.accept) for (const k of removed) delete next[k];
  if (!old || opts.accept || JSON.stringify(next) !== JSON.stringify(old)) saveBaseline(opts.baselineFile, next);
  return { reports, baselineCreated: !old, removed };
}

// The command line with secrets and home folder masked, safe to print or send.
export function displayCommand(e: ServerEntry): string {
  if (e.url) return redactSecrets(e.url);
  const parts = [e.command ?? "", ...(e.args ?? [])].map((a, i, all) =>
    /^--?(?:token|api-?key|password|secret)=/i.test(a) ? a.replace(/=.*/, "=***")
      : /^--?(?:token|api-?key|password|secret)$/i.test(all[i - 1] ?? "") ? "***" : tilde(a));
  return redactSecrets(parts.join(" "));
}

export function toEvents(reports: ServerReport[]): McpEvent[] {
  return reports.map((r) => {
    const high = r.findings.some((f) => f.severity === "high");
    return {
      time: new Date().toISOString(), server: r.entry.name, session: "scan", client: r.entry.client, clientName: r.entry.client,
      direction: "local", method: "scan", tool: r.entry.name, mode: "scan", action: "allow", enforceAction: high ? "block" : "allow",
      score: r.findings.reduce((n, f) => n + f.points, 0), findings: r.findings,
      snippet: `${displayCommand(r.entry)}${r.serverInfo ? ` · ${r.serverInfo}, ${r.tools} tools` : ""}${r.error ? ` · connect failed: ${r.error}` : ""}`,
    };
  });
}

const COLORS = { high: "\x1b[31m", medium: "\x1b[33m", low: "\x1b[36m", reset: "\x1b[0m", dim: "\x1b[2m" };

export function printReport(result: Awaited<ReturnType<typeof scan>>, color = process.stdout.isTTY): number {
  const c = (k: keyof typeof COLORS, s: string) => (color ? COLORS[k] + s + COLORS.reset : s);
  const { reports, baselineCreated, removed } = result;
  const files = new Set(reports.map((r) => r.entry.file));
  console.log(`MCPWatch scan: ${reports.length} server(s) in ${files.size} config file(s)\n`);
  let lastFile = "";
  for (const r of reports) {
    if (r.entry.file !== lastFile) {
      lastFile = r.entry.file;
      console.log(`${r.entry.client}  ${c("dim", tilde(r.entry.file))}`);
    }
    const status = r.findings.length ? "" : c("dim", "  ok");
    console.log(`  ${r.entry.name}${status}  ${c("dim", displayCommand(r.entry))}`);
    if (r.serverInfo) console.log(`    ${c("dim", `${r.serverInfo}, ${r.tools} tools`)}`);
    if (r.error) console.log(`    ${c("dim", `could not connect: ${r.error}`)}`);
    for (const f of r.findings) {
      console.log(`    ${c(f.severity, f.severity.toUpperCase().padEnd(6))} ${f.rule} ${RULES[f.rule].title}\n           ${c("dim", f.detail)}`);
    }
  }
  for (const k of removed) console.log(`  ${c("low", "LOW   ")} MS006 removed since the last accepted scan: ${k}`);
  const all = reports.flatMap((r) => r.findings);
  const count = (s: string) => all.filter((f) => f.severity === s).length;
  console.log(`\n${count("high")} high, ${count("medium")} medium, ${count("low")} low.`);
  if (baselineCreated) console.log("Baseline saved: later scans report servers added or changed since now.");
  else if (all.some((f) => f.rule === "MS006" || f.rule === "MW024" || f.rule === "MW038") || removed.length) {
    console.log("Review the changes, then run `mcpwatch scan --accept` to make them the new baseline.");
  }
  return count("high") + count("medium") > 0 ? 1 : 0;
}

// --watch: scan again whenever a config file changes; report only what's new.
export function watchConfigs(opts: ScanOptions, onResult: (r: Awaited<ReturnType<typeof scan>>) => void) {
  const files = opts.files?.length ? opts.files.map((f) => path.resolve(f)) : defaultConfigFiles().map((c) => c.file);
  let running = false;
  const rescan = async () => {
    if (running) return;
    running = true;
    try {
      onResult(await scan(opts));
    } finally {
      running = false;
    }
  };
  for (const f of files) watchFile(f, { interval: 2000 }, () => void rescan());
  return () => files.forEach((f) => unwatchFile(f));
}

export function reportTo(server: string, key: string, events: McpEvent[]) {
  const sink = new HeaderwatchSink(server, key);
  for (const e of events) sink.write(e);
  return sink.flush();
}
