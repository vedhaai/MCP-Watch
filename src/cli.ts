#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkAi } from "./ai-check.js";
import { CATALOG } from "./catalog.js";
import { runDashboard } from "./dashboard.js";
import { runEngineServer } from "./engine-server.js";
import { DEFAULT_SERVER, type Reporting } from "./headerwatch.js";
import { runHttpProxy } from "./http-proxy.js";
import { HOME, aiFromEnv, loadPolicy, withEnv, type Mode, type Policy, type PolicyOverrides } from "./policy.js";
import { printReport, reportTo, scan, toEvents, watchConfigs, type ScanOptions, type ServerEntry } from "./scan.js";
import { runStdioProxy } from "./stdio-proxy.js";

const USAGE = `MCPWatch: security guard for MCP

  mcpwatch dashboard [--port 9100] [--data <dir>] run the dashboard (projects, keys, events)
  mcpwatch [options] -- <command> [args...]       guard a stdio MCP server (proxy)
  mcpwatch http --listen 8800 --upstream <url>    guard a Streamable HTTP MCP server (proxy)
  mcpwatch scan [scan options]                     check the MCP servers configured on this machine
  mcpwatch scan [scan options] -- <command> [args] check one server command before you install it
  mcpwatch ai [--ai-model <m>] [--ai-url <url>]     check the local AI reviewer with a few sample messages
  mcpwatch engine [--name <server>] [options]      the engine as a sidecar for other languages (Python),
                                                   JSON lines on stdin/stdout
  mcpwatch rules                                   list the rules
  mcpwatch pins reset                              forget pinned tool definitions

Proxy options:
  --project-key <key>              report to a dashboard project (or MCPWATCH_PROJECT_KEY)
  --server <url>                   dashboard URL (default ${DEFAULT_SERVER}, or MCPWATCH_SERVER)
  --mode off|observe|protect|enforce   (default enforce; a project's mode overrides it)
  --config <file.json>             policy file
  --events <file>                  local events log (default ~/.mcpwatch/events.jsonl)
  --pins <file>                    pinned tool definitions (default ~/.mcpwatch/pins.json)
  --ai                             AI review of every message by a local model (or MCPWATCH_AI=1)
  --ai-model <name>                model (default qwen2.5:7b, or MCPWATCH_AI_MODEL)
  --ai-url <url>                   OpenAI-compatible endpoint (default Ollama, http://127.0.0.1:11434/v1)
  --ai-advise                      AI findings add to the score but never block on their own

Scan options:
  --file <config.json>             scan this config instead of the clients' default ones (repeatable)
  --connect                        also start each server and check its tools (runs the server's code)
  --accept                         accept the current configs as the new baseline
  --watch                          scan again whenever a config file changes
  --json                           print JSON
  --baseline <file>                default ~/.mcpwatch/scan-baseline.json
  --project-key / --server         also send the results to a dashboard project
  Exits 1 when anything high or medium is found, for use in CI.
`;

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const own = dash === -1 ? argv : argv.slice(0, dash);
const target = dash === -1 ? [] : argv.slice(dash + 1);

function opt(name: string): string | undefined {
  const i = own.indexOf(`--${name}`);
  return i === -1 ? undefined : own[i + 1];
}

const overrides: PolicyOverrides = {};
if (opt("mode")) overrides.mode = opt("mode") as Mode;
if (opt("events")) overrides.eventsFile = opt("events");
if (opt("pins")) overrides.pinsFile = opt("pins");
overrides.ai = aiFromEnv();
if (own.includes("--ai") || own[0] === "ai") overrides.ai.enabled = true;
if (opt("ai-model")) overrides.ai.model = opt("ai-model");
if (opt("ai-url")) overrides.ai.url = opt("ai-url");
if (own.includes("--ai-advise")) overrides.ai.authority = "advise";

let policy: Policy;
try {
  policy = loadPolicy(opt("config"), overrides);
} catch (e) {
  console.error(`[mcpwatch] ${(e as Error).message}`);
  process.exit(2);
}

const sub = own[0] && !own[0].startsWith("--") ? own[0] : undefined;
const reporting: Reporting = {
  key: opt("project-key") ?? process.env.MCPWATCH_PROJECT_KEY,
  server: opt("server") ?? process.env.MCPWATCH_SERVER ?? DEFAULT_SERVER,
};

if (sub === "scan") {
  const files = own.flatMap((a, i) => (a === "--file" && own[i + 1] ? [own[i + 1]] : []));
  const opts: ScanOptions = {
    files, baselineFile: opt("baseline") ?? path.join(HOME, "scan-baseline.json"),
    accept: own.includes("--accept"), connect: own.includes("--connect"), timeoutMs: Number(opt("timeout") ?? 20) * 1000,
  };
  const extra: ServerEntry[] = target.length
    ? [{ client: "command line", file: "(command line)", name: target.join(" ").slice(0, 60), command: target[0], args: target.slice(1), env: {} }]
    : [];
  const report = async (result: Awaited<ReturnType<typeof scan>>) => {
    let code: number;
    if (own.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      code = result.reports.some((r) => r.findings.some((f) => f.severity !== "low")) ? 1 : 0;
    } else {
      code = printReport(result);
    }
    if (reporting.key) await reportTo(reporting.server!, reporting.key, toEvents(result.reports));
    return code;
  };
  if (own.includes("--connect")) console.error("[mcpwatch] --connect starts each configured server to read its tools.");
  const first = await report(await scan(opts, extra));
  if (own.includes("--watch")) {
    console.log("\nWatching the config files for changes (Ctrl+C to stop)…");
    watchConfigs(opts, (r) => void report(r));
  } else {
    process.exit(first);
  }
} else if (target.length) {
  runStdioProxy(policy, target[0], target.slice(1), reporting);
} else if (sub === "http") {
  const upstream = opt("upstream");
  if (!upstream) {
    console.error("[mcpwatch] http needs --upstream <url>");
    process.exit(2);
  }
  runHttpProxy(policy, Number(opt("listen") ?? 8800), new URL(upstream), reporting);
} else if (sub === "engine") {
  // Options from the guard's own code arrive as JSON; they outrank the environment, as in the middleware.
  let fromGuard: PolicyOverrides & Reporting & { name?: string } = {};
  try {
    fromGuard = JSON.parse(process.env.MCPWATCH_ENGINE_OPTIONS || "{}");
    const { name, key, server, localLog, pollMs, ...rest } = fromGuard;
    const guardPolicy = loadPolicy(opt("config") ?? process.env.MCPWATCH_CONFIG, withEnv({ ...overrides, ...rest, ai: { ...overrides.ai, ...rest.ai } }));
    runEngineServer(guardPolicy, opt("name") ?? name ?? "mcp-server", {
      key: key ?? reporting.key, server: server ?? reporting.server, localLog, pollMs: pollMs ?? Number(process.env.MCPWATCH_POLL_MS ?? 5000),
    });
  } catch (e) {
    console.error(`[mcpwatch] ${(e as Error).message}`);
    process.exit(2);
  }
} else if (sub === "dashboard") {
  runDashboard(Number(opt("port") ?? 9100), opt("data") ?? path.join(HOME, "server"), policy.eventsFile);
} else if (sub === "ai") {
  process.exit(await checkAi(policy));
} else if (sub === "rules") {
  for (const r of CATALOG) console.log(`${r.id}  ${r.severity.padEnd(6)}  ${r.title}`);
} else if (sub === "pins" && own[1] === "reset") {
  try {
    readFileSync(policy.pinsFile);
    writeFileSync(policy.pinsFile, "{}");
  } catch {
    // nothing pinned yet
  }
  console.log(`Cleared ${policy.pinsFile}`);
} else {
  console.error(USAGE);
  process.exit(sub ? 2 : 0);
}
