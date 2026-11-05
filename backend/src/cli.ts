#!/usr/bin/env node
import path from "node:path";
import { DEFAULT_POLICY, HOME } from "@vedhaai/mcpwatch";
import { runDashboard } from "./dashboard.js";

const USAGE = `MCPWatch dashboard: projects, keys and the requests your guards report

  mcpwatch-dashboard [--port 9100] [--data <dir>] [--events <file>]

  --port <n>       port on 127.0.0.1 (default 9100)
  --data <dir>     accounts, projects and events (default ~/.mcpwatch/server)
  --events <file>  local events from guards without a project key, shown under Local events
                   (default ~/.mcpwatch/events.jsonl, or MCPWATCH_EVENTS)
`;

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// The same local events file the guards write to, so Local events shows what they logged.
const eventsFile = opt("events") ?? process.env.MCPWATCH_EVENTS ?? DEFAULT_POLICY.eventsFile;
runDashboard(Number(opt("port") ?? 9100), opt("data") ?? path.join(HOME, "server"), eventsFile);
