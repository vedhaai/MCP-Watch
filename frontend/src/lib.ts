import { useEffect, useRef, useState } from "react";
import type { McpEvent, Mode, Project, ProjectKind } from "./types";

export const KINDS: Record<ProjectKind, [string, string]> = {
  "middleware": ["Node.js / TypeScript MCP server", "Add one line to your server code. Any client that connects is scanned."],
  "middleware-python": ["Python MCP server", "MCP SDK, Django, Flask or FastAPI: add one line to your server code. Needs Node 20+ installed."],
  "middleware-java": ["Java MCP server", "MCP Java SDK, Spring Boot, Quarkus: add one line or a servlet filter. Needs Node 20+ installed."],
  "proxy-stdio": ["Any local (stdio) MCP server", "For servers you can't edit (npx, uvx, Python…). Change the client config only."],
  "proxy-http": ["Any remote (HTTP) MCP server", "Run a local proxy in front of the server's URL."],
};

export const MODES: Record<Mode, string> = {
  off: "Pass everything through, record nothing.",
  observe: "Never block. Record what Enforce would do. Good for a first look.",
  protect: "Block high-severity findings only.",
  enforce: "Block high-severity findings, then throttle and block by session score.",
};

export const AI_CHOICES = {
  off: ["Rules only", "No AI. Every message is handled by the rules."],
  local: ["Local model", "Ollama or another model server on this machine."],
  api: ["Model with an API key", "A hosted model such as OpenAI, Claude or Gemini."],
} as const;

// True when a model URL is not on this machine, so message text would leave it. Mirrors the guard's own check.
export function isHostedUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return !(h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h));
  } catch {
    return true;
  }
}

// [name, OpenAI-compatible URL, suggested model]
export const AI_PROVIDERS: [string, string, string][] = [
  ["Custom", "", ""],
  ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
  ["Anthropic (Claude)", "https://api.anthropic.com/v1", "claude-haiku-5-5"],
  ["Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.0-flash"],
  ["Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
  ["OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini"],
];

export function ago(iso: string | null | undefined) {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

export function status(p: Project) {
  if (!p.lastSeenAt) return { cls: "st-wait", text: "Waiting for first connection", on: false };
  const s = (Date.now() - Date.parse(p.lastSeenAt)) / 1000;
  return s < 30 ? { cls: "st-on", text: "Connected", on: true } : { cls: "st-off", text: `Last seen ${ago(p.lastSeenAt)}`, on: false };
}

// The guard reports failures every 5 s while they last, so a report older than this means it recovered.
const ISSUE_WINDOW_S = 120;

// The engine's current trouble, or null when its checks are working.
export function engineIssue(p: Project) {
  const issue = p.engineIssue;
  if (!issue) return null;
  return (Date.now() - Date.parse(issue.at)) / 1000 < ISSUE_WINDOW_S ? issue : null;
}

// Events are whatever a guard reported. The dashboard now checks them on the way in, but events
// stored before that are still on disk, and one bad finding would break every render of the page
// they are on — including the button that clears them. So the shape is enforced again on the way out.
const SEVERITIES = ["high", "medium", "low"];

export function asEvents(raw: unknown): McpEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is McpEvent => !!e && typeof e === "object" && !Array.isArray(e)).map((e) => ({
    ...e,
    findings: (Array.isArray(e.findings) ? e.findings : [])
      .filter((f) => !!f && typeof f === "object" && !Array.isArray(f))
      .map((f) => ({
        ...f,
        rule: typeof f.rule === "string" && f.rule ? f.rule : "unknown",
        severity: SEVERITIES.includes(f.severity as string) ? f.severity : "low",
        detail: typeof f.detail === "string" ? f.detail : "",
        points: Number.isFinite(Number(f.points)) ? Number(f.points) : 0,
      })),
  }));
}

export const flagged = (e: McpEvent) => e.findings.length > 0 || e.action !== "allow";
export const eventKey = (e: McpEvent) => `${e.time}|${e.session}|${e.direction}|${e.id}|${e.method}`;
export const direction = (e: McpEvent) => (e.direction === "client->server" ? "→ server" : e.direction === "local" ? "scan" : "← client");

// The current hash route, e.g. "#/p/abc/requests" -> ["p", "abc", "requests"].
export function useRoute() {
  const parse = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

// Runs fn now and every ms while mounted (and again when deps change). A failed refresh, e.g. after
// signing out, is ignored; the next tick tries again.
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const runRef = useRef(() => {});
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
    const run = () => {
      fnRef.current().then((d) => live && (setData(d), setError(null)), (e: Error) => live && setError(e));
    };
    runRef.current = run;
    run();
    const t = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, deps);
  return { data, error, refresh: () => runRef.current(), setData };
}
