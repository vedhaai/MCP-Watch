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
npx @vedhaai/mcpwatch ai        # score the AI reviewer's model on 50 labelled messages
npx @vedhaai/mcpwatch engine    # the engine as a sidecar for other languages (used by the Python package)
```

## Dashboard

Projects, keys and every request your guards report: [`@vedhaai/mcpwatch-dashboard`](https://www.npmjs.com/package/@vedhaai/mcpwatch-dashboard).

```powershell
npx @vedhaai/mcpwatch-dashboard
```

Give a guard its project key with `MCPWATCH_PROJECT_KEY` or a file (`MCPWATCH_PROJECT_KEY_FILE`, `--project-key-file`), and `MCPWATCH_SERVER` for the dashboard URL. `--project-key` also works but shows in process listings. Without a key, events go to `~/.mcpwatch/events.jsonl`.

Settings from the dashboard are signed with the project key and checked by the guard. The key is only sent over `https://` or to a loopback address; any other plain-HTTP dashboard is refused with a warning. The guard's own secrets (`MCPWATCH_PROJECT_KEY`, `MCPWATCH_AI_KEY`, `MCPWATCH_PINS_KEY`) are not passed on to the server it wraps.

If a check throws, the request is refused with `-32001` (`failOpen: false`, the default). Set `failOpen: true` in the policy file to forward it unchecked instead. The guard's files in `~/.mcpwatch/` are readable by their owner only. For more: `strictPins` (never pin a new tool) and `MCPWATCH_PINS_KEY` (sign the pin and registry files); see the main README.

Python servers (MCP SDK, Django, Flask, FastAPI): `pip install vedhaai-mcpwatch`.

Full documentation, rules and modes: https://github.com/vedhaai/MCP-Watch
