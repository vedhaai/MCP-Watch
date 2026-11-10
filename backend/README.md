# @vedhaai/mcpwatch-dashboard

The dashboard for [MCPWatch](https://www.npmjs.com/package/@vedhaai/mcpwatch), the security guard for MCP servers. Create a project, follow its setup steps, and every request that reaches your MCP server shows up here: what was allowed, blocked, throttled or redacted, and why. Change a project's mode, block or trust clients, and turn on AI review; guards pick up changes within 5 seconds.

Needs Node 20+.

```powershell
npx @vedhaai/mcpwatch-dashboard
```

Then open http://127.0.0.1:9100 and create an account.

```
mcpwatch-dashboard [--port 9100] [--data <dir>] [--events <file>]

  --port <n>       port on 127.0.0.1 (default 9100, or MCPWATCH_PORT)
  --data <dir>     accounts, projects and events (default ~/.mcpwatch/server, or MCPWATCH_DATA)
  --events <file>  local events from guards without a project key, shown under Local events
                   (default ~/.mcpwatch/events.jsonl, or MCPWATCH_EVENTS)
```

The dashboard listens on 127.0.0.1 only and stores everything as JSON files in the data folder. Project keys and AI API keys are encrypted in `projects.json`: with `MCPWATCH_DATA_KEY` if set (keep it outside the data folder), else with a generated `secret.key` in it. Settings sent to guards are signed with the project key (`X-MCPWatch-Signature`).

Full documentation: https://github.com/vedhaai/MCP-Watch
