# @vedhaai/mcpwatch

A security guard for MCP servers. It checks every JSON-RPC message between any MCP client and your server, in both directions, and blocks, throttles, strips or redacts what's dangerous: command and SQL injection, path traversal, SSRF, leaked secrets, poisoned tool definitions, rug pulls, prompt injection in tool output, and more. Clients need no changes.

Needs Node 20+.

## Add it to your server (middleware)

```powershell
npm install @vedhaai/mcpwatch
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpwatch } from "@vedhaai/mcpwatch";

const server = new McpServer({ name: "my-tools", version: "1.0.0" });
// ... registerTool(...) as usual

mcpwatch(server);   // ← the only line added, before connect()
await server.connect(transport);
```

## A server you can't edit (proxy)

```powershell
npx @vedhaai/mcpwatch -- npx -y some-mcp-server                          # stdio
npx @vedhaai/mcpwatch http --listen 8800 --upstream https://host/mcp     # Streamable HTTP
```

## Other commands

```powershell
npx @vedhaai/mcpwatch scan      # check the MCP servers configured on this machine
npx @vedhaai/mcpwatch rules     # list the rules
npx @vedhaai/mcpwatch ai        # check the local AI reviewer
npx @vedhaai/mcpwatch engine    # the engine as a sidecar for other languages (used by the Python package)
```

## Dashboard

Projects, keys and every request your guards report: [`@vedhaai/mcpwatch-dashboard`](https://www.npmjs.com/package/@vedhaai/mcpwatch-dashboard).

```powershell
npx @vedhaai/mcpwatch-dashboard
```

Give a guard its project key with `MCPWATCH_PROJECT_KEY` (and `MCPWATCH_SERVER` for the dashboard URL), or `--project-key` on the proxy. Without a key, events go to `~/.mcpwatch/events.jsonl`.

Python servers (MCP SDK, Django, Flask, FastAPI): `pip install vedhaai-mcpwatch`.

Full documentation, rules and modes: https://github.com/vedhaai/MCP-Watch
