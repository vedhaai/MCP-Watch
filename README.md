# MCPWatch (POC)

A security guard for MCP servers. It checks every JSON-RPC message between any MCP client and your server, in both directions. You manage it from a dashboard. It works the way Headerwatch does for APIs:
1. Create a project in the dashboard.
2. Follow its setup steps to add one line to your MCP server.
3. Every request from any client shows up in the dashboard. Clients need no changes.

```
Any MCP client (Claude, Cursor, …)          ← no changes
        │ stdio or HTTP
        ▼
┌──────── your MCP server ─────────┐
│ transport                        │
│   ▼                              │      events (~1 s, background)
│ mcpwatch(server)  ◄── one line   │ ───────────────────────────────►  MCPWatch dashboard (:9100)
│   ▼  allowed / blocked / cleaned │ ◄───────────────────────────────  projects · keys · requests
│ your tools                       │   mode + block/trust lists (5 s)  clients · settings · setup
└──────────────────────────────────┘
```

MCPWatch works with any MCP server and any MCP client. It needs no matching client or server of its own. A small [demo server](#demo-server) for trying it out ships in [test/fixtures/demo-server](test/fixtures/demo-server).

| Folder | What it is |
|---|---|
| [src/](src) | The guard (middleware `mcpwatch(server)`, plus a proxy for servers you can't edit), the rules, the scanner and the dashboard server |
| [public/](public) | The dashboard page |
| [test/](test) | Tests, plus the demo MCP server they run against |

## Run it

Needs Node 20+.

```powershell
git clone https://github.com/vedhaai/MCP-Watch.git
cd MCP-Watch
npm install
npm run dev
```

This opens the dashboard at http://127.0.0.1:9100. `npm run dev` builds the TypeScript, then starts. `npm start` starts without building. Use it once you've built and haven't changed the code.

Every script:

| Script | What it does |
|---|---|
| `npm start` / `npm run dev` | Dashboard on :9100. Pass options after `--`, e.g. `npm start -- --port 9200` |
| `npm test` | All tests |
| `npm run scan` | Check the MCP servers configured on this machine. Pass options after `--`, e.g. `npm run scan -- --connect` |
| `npm run ai` | Check the local AI reviewer (Ollama) with sample messages |
| `npm run rules` / `npm run pins:reset` | List the rules / forget pinned tool definitions |
| `npm run demo` | Demo server over HTTP on http://127.0.0.1:3001/mcp, with the middleware built in |
| `npm run demo:stdio` | Demo server over stdio, for a client that starts it itself |

To report the demo server to a dashboard project, or to turn on AI review, set the variables in a second terminal before starting:

```powershell
$env:MCPWATCH_PROJECT_KEY = "mw_..."
$env:MCPWATCH_AI = "1"
npm run demo
```

### Connect a server through the dashboard

1. Open **http://127.0.0.1:9100** and **create an account** (or sign in). Click **New project**, enter a name, and pick how your server is built:
   - **Node/TypeScript server:** middleware.
   - **Any local server:** stdio proxy.
   - **Any remote server:** HTTP proxy.
2. The **Setup** tab shows the steps with your project key filled in. It says *Waiting…* until your server first contacts the dashboard, then turns **Connected**.
3. To try it with the demo server, follow **Try it with the demo server** on the Setup tab. It gives a ready-made command for stdio (e.g. `claude mcp add …`) and for HTTP, with your key filled in.
4. Call tools from your MCP client, including attacks such as `read_file` with `../../.ssh/id_rsa`. They appear on the project's **Requests** tab.

The project tabs:

| Tab | What it does |
|---|---|
| **Requests** | Every message checked, with its action, findings, score and redacted evidence (click a row) |
| **Clients** | MCP clients that connected. **Block** refuses everything from a client; **Trust** lets it through |
| **Settings** | Mode (`off` / `observe` / `protect` / `enforce`), scoring thresholds, denied tools, transport settings (allowed web origins, require auth, expected token audience), rename, rotate key, clear requests, delete |
| **Setup** | Connection steps and the project key |

New projects start in **observe** mode: nothing is blocked, and each request shows what enforce would have done. Changes on the Clients and Settings tabs reach the guard within 5 seconds, with no restart.

**Accounts:** each user signs in with a username and password, and sees only their own projects. Users can have any number of projects, each with its own key. Passwords are stored as scrypt hashes, and sessions use an HttpOnly cookie that lasts 14 days. After 5 wrong passwords, sign-in for that username pauses for 5 minutes. Projects created before accounts existed go to the first account. Guards don't sign in; they use the project key.

Data lives in `~/.mcpwatch/server/`: `users.json`, `sessions.json`, `projects.json`, plus one events file per project. The dashboard listens on 127.0.0.1 only.

## Add it to your MCP server (middleware)

```powershell
npm install <path>/MCP-Watch    # after npm install and npm run build in MCP-Watch
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpwatch } from "mcpwatch";

const server = new McpServer({ name: "my-tools", version: "1.0.0" });
// ... registerTool(...) as usual

mcpwatch(server);                              // ← the only line added, before connect()
await server.connect(new StdioServerTransport());
```

It works with stdio and Streamable HTTP transports. When a call is blocked, the client gets a JSON-RPC error and your tool handler never runs.

Settings come from options (`mcpwatch(server, { projectKey, server, mode })`) or environment variables:

| Variable | Meaning |
|---|---|
| `MCPWATCH_PROJECT_KEY` | Project key from the dashboard. Events go to that project, and its mode and client lists apply live |
| `MCPWATCH_SERVER` | Dashboard URL (default `http://127.0.0.1:9100`) |
| `MCPWATCH_ENABLED=0` | Disconnect: the server runs untouched |
| `MCPWATCH_MODE` | `off`, `observe`, `protect`, `enforce` (default). With a project key, the project's mode wins |
| `MCPWATCH_ALLOWED_ORIGINS` | HTTP: comma-separated web origins allowed to call the server (others are refused, MW030) |
| `MCPWATCH_ALLOWED_HOSTS` | HTTP: host names the server answers to (default: not checked) |
| `MCPWATCH_REQUIRE_AUTH=1` | HTTP: refuse requests without an `Authorization` or `X-API-Key` header (MW031) |
| `MCPWATCH_AUDIENCE` | HTTP: refuse JWT bearer tokens whose `aud` doesn't include this (MW036) |
| `MCPWATCH_AI=1` | Turn on the [AI reviewer](#ai-reviewer-local-model). With a project key, the project's **AI review** choice (model, URL and key included) wins |
| `MCPWATCH_AI_MODEL`, `MCPWATCH_AI_URL` | Model (default `qwen2.5:7b`) and OpenAI-compatible endpoint (default Ollama, `http://127.0.0.1:11434/v1`) |
| `MCPWATCH_AI_AUTHORITY`, `MCPWATCH_AI_REQUIRED=1`, `MCPWATCH_AI_TIMEOUT_MS`, `MCPWATCH_AI_KEY` | `block` (default) or `advise`; block when the model is down; review timeout (default 8000); API key for servers that need one |
| `MCPWATCH_EVENTS`, `MCPWATCH_PINS`, `MCPWATCH_CONFIG` | Local events file (used when there's no key), pinned tools file, policy file |

Events are sent in the background, about once a second. If the dashboard is down, the MCP server keeps working.

**Headerwatch server:** the guard uses the same agent API as Headerwatch (`GET /api/agent/config`, `POST /api/agent/events`). To report to Headerwatch instead, set `MCPWATCH_SERVER=http://127.0.0.1:9000` and use a Headerwatch project key. MCP events show there as generic requests: method `CALL`, path `mcp → tools/call read_file`.

### Other ways to test

- Start the demo server with `MCPWATCH_ENABLED=0` to see the same attacks reaching the server.
- Without a project key, events go to `~/.mcpwatch/events.jsonl`. Open them under **Local events** on the dashboard's Projects page.
- For HTTP, run `npm run demo`, setting `$env:MCPWATCH_PROJECT_KEY` first to report to a project. Then point any MCP client (or the MCP Inspector, `npx @modelcontextprotocol/inspector`) at http://127.0.0.1:3001/mcp.

## Proxy: for MCP servers you can't edit

For third-party servers (e.g. `npx` packages), put `mcpwatch` in front of the server command in the client's config (Claude Desktop, Cursor, Claude Code…). The proxy runs the same engine and rules as the middleware:

```json
"my-server": {
  "command": "node",
  "args": ["C:/path/to/MCP-Watch/dist/cli.js", "--project-key", "mw_...", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/mcp-test"]
}
```

For a remote server, use `node dist/cli.js http --listen 8800 --upstream <url> --project-key mw_...`, then point the client at `http://127.0.0.1:8800/mcp`. A project created as a proxy project shows these steps on its Setup tab with the key filled in. Without `--project-key`, the proxy writes to the local events file.

## Modes

| Mode | Behaviour |
|---|---|
| `off` | Pass everything through and record nothing |
| `observe` | Forward everything; events record what `enforce` would have done |
| `protect` | Block high-severity findings only |
| `enforce` (default) | Block high-severity findings; throttle at session score 3, block at 6 (60 s window) |

What the guard does to each message:
- **Blocked call:** answered with a JSON-RPC error (`-32001` blocked, `-32002` throttled) and never forwarded.
- **Poisoned or rug-pulled tool:** removed from `tools/list`.
- **Injected tool result:** replaced with an error.
- **Secrets in output:** redacted.

## AI reviewer (local model)

With the AI reviewer on, a local model reviews every message against the rules below, on top of the pattern checks. It covers tool calls, resource reads, prompts, tool definitions, tool results, sampling and elicitation. Pings, list requests and notifications are not reviewed. It catches what patterns can't, such as instructions to the model hidden in an email body. Nothing leaves the machine.

```powershell
ollama pull qwen2.5:7b                             # any model works; this one is the default
node dist/cli.js ai                       # check: sends 6 sample messages, shows what the model finds
node dist/cli.js --ai -- npx -y some-mcp-server     # proxy with AI review
```

**From the dashboard** (projects with a key): the Settings tab's **AI review** section has three choices. Guards pick the choice up within 5 seconds, with no restart.

| Choice | What reviews each message |
|---|---|
| **Rules only** (default) | The rules alone. No model is called |
| **Local model** | A model server on the guard's machine. Leave the URL and model empty for Ollama with `qwen2.5:7b`; any OpenAI-compatible server works (LM Studio, llama.cpp, vLLM) |
| **Model with an API key** | A hosted model through its OpenAI-compatible API. Presets for OpenAI, Anthropic (Claude), Google Gemini, Groq and OpenRouter, or a custom URL |

- **Test AI:** sends one sample attack to the chosen model, before or after saving. It shows the response time and whether the model caught the attack, or why it failed (for example, a refused key).
- **The API key:** stored in the dashboard's `projects.json` and passed to the project's guards with their settings. After saving, the browser only ever sees its last 4 characters. Leave the key field empty to keep the saved one.
- **Data leaving the machine:** with an API model, messages go to that provider, with secrets masked. With a local model, nothing leaves the machine.
- **Timeouts:** 8 s for a local model, 15 s for an API model.
- **JSON mode:** some providers reject it. The guard then asks again without it.

**Without a dashboard**, for the middleware, set `MCPWATCH_AI=1` or pass `mcpwatch(server, { ai: { enabled: true } })`. Set `--ai-url` / `MCPWATCH_AI_URL`, `--ai-model` / `MCPWATCH_AI_MODEL`, and `MCPWATCH_AI_KEY` for an API model.

How it decides:
- **It can add, never remove.** The pattern rules still run and still block on their own. A payload that talks the model into "this is safe" can't undo a rule's finding.
- **Same rule ids.** The model reports the rules a message breaks (MW001, MW020, MW022, …), or **MA001** for a threat no rule covers. The model's answers are checked:
  - A rule id it wasn't given becomes MA001.
  - A finding under 0.6 confidence counts one severity lower.
- **Authority:** with `block` (the default), a high AI finding blocks like a rule. With `advise` (`--ai-advise`), AI findings count at most medium: they add to the session score but never block alone.
- **Fallback:** if the model is down, times out or answers nonsense, the rules alone decide, and the event shows `ai: error`. With `required: true`, the message is blocked instead (MA002).
- **Privacy:** secrets and the caller's own token are masked before the text goes to the model. Text is cut at 6,000 characters. Unchanged tool definitions and repeated messages are answered from a cache.
- **Latency:** with `qwen2.5:7b` on a typical laptop GPU, about 0.4–1 s per reviewed message once the model is loaded. The guard loads the model when it starts. Messages are still delivered in order.

The Requests tab marks AI findings with ✦ and shows each message's AI verdict and review time.

Policy file (all fields optional):

```json
{ "ai": { "enabled": true, "url": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b", "timeoutMs": 8000,
          "minConfidence": 0.6, "authority": "block", "required": false, "maxChars": 6000 } }
```

## Rules

Run `node dist/cli.js rules` for the full list.

- **Tool calls:**
  - MW001 command injection
  - MW002 path traversal or sensitive file
  - MW003 SSRF
  - MW004 SQL injection
  - MW005 secret in arguments
  - MW006 schema violation
  - MW007 unknown tool
  - MW008 oversized
  - MW009 denied tool
  - MW010 NoSQL, LDAP, template or XML (XXE) injection
- **Tool definitions:**
  - MW020 tool poisoning
  - MW021 invisible characters
  - MW024 rug pull (definition changed after it was pinned)
  - MW027 tool name collision: another server on this machine offers the same tool
  - MW028 tool shadowing: a description names another server's tools (high when it also gives the model instructions; the tool is removed)
  - MW038 server changed: its name or version differs from the pinned one (reported, not blocked)
  - MW039 over-privileged server: shell, file-write, network, messaging or payment tools (reported once per tool list)
- **Server output:**
  - MW022 prompt injection
  - MW023 oversized response (over `maxResultBytes`, default 5 MB; withheld)
  - MW025 secret leak
  - MW026 sampling request
  - MW029 elicitation phishing: a form or message asking the user for passwords, keys, codes or card details
- **Transport, auth and sessions** (HTTP only; the middleware reads the request headers, the proxy the whole request):
  - MW030 DNS rebinding or cross-site request: a browser `Origin` that isn't loopback or allowed, or a `Host` that isn't one of the server's names
  - MW031 request without authentication (when `requireAuth` is on; otherwise a request from another machine is noted once, low)
  - MW032 token passthrough: the caller's own credential appears in tool arguments or in server output (refused, and never written to events)
  - MW033 session hijacking: an `Mcp-Session-Id` used with a different credential than the one that opened it (a changed user agent or a guessable id is noted)
  - MW034 plain HTTP between machines, inbound or to the proxy's upstream (noted once, low)
  - MW035 client impersonation: a session re-initializes claiming to be a different client
  - MW036 confused deputy: a JWT bearer token that has expired, or whose audience isn't `expectedAudience`. Claims only; checking the signature is the server's auth layer's job
  - MW037 event stream abuse (HTTP proxy): a response to a request the client never sent, or a stream resumed with another session's event id
- **Behaviour:**
  - MB001 call flood
  - MB002 repeated blocked attempts
  - MB003 enumeration
  - MB004 exfiltration chain (secret read, then outbound tool)
  - MB005 replay
  - MB006 cross-server leakage: lines of sensitive output (with secrets or a "confidential" label) from one server, sent to another server's tool
- **AI reviewer** (when on):
  - MA001 a threat the model found that no pattern rule covers
  - MA002 the model couldn't be reached while `required` is on

Collisions, shadowing and cross-server leakage need to know about the *other* MCP servers on the machine. Every guard shares a small registry for that: `~/.mcpwatch/registry.json` holds the tool names per server and hashes (not the text) of sensitive output lines for one hour.

Pinned tool definitions live in `~/.mcpwatch/pins.json`. After you deliberately update a server, run `mcpwatch pins reset`.

Policy file (`--config policy.json`), all fields optional:

```json
{ "mode": "enforce", "windowSeconds": 60, "throttleAt": 3, "blockAt": 6,
  "denyTools": ["run_command"], "allowTools": [], "failOpen": true,
  "allowedOrigins": ["https://app.example.com"], "allowedHosts": [], "requireAuth": false, "expectedAudience": "" }
```

## Scan: before a server runs

Some attacks happen before any MCP message is sent: a typosquatted package, a config someone edited, a server with the whole disk. `mcpwatch scan` reads the server lists of Claude Desktop, Claude Code, Cursor, VS Code and Windsurf (only the server entries) and checks each one:

| Rule | What it finds |
|---|---|
| MS001 | Typosquatted package: a name one or two characters away from a well-known MCP server, or one with its scope dropped |
| MS002 | Suspicious launch command: download-and-run (`curl … \| sh`), encoded PowerShell, inline scripts, temp-folder programs, `NODE_OPTIONS=--require`, `LD_PRELOAD` |
| MS003 | Unpinned package or image (`npx -y pkg`, `:latest`): every start may run new code |
| MS004 | Plaintext secrets in `env`, headers or arguments (only the key name is shown, never the value) |
| MS005 | Over-broad access: `/`, `C:\`, the home folder, `--privileged`, `docker.sock`, host network |
| MS006 | Config tampering: a server added or changed since the last accepted scan |
| MS007 | Remote server over plain HTTP |

```powershell
node dist/cli.js scan                              # all MCP clients on this machine
node dist/cli.js scan -- npx -y some-mcp-server     # one command, before you install it
node dist/cli.js scan --connect                     # also start each server and check its tools
node dist/cli.js scan --accept                      # after reviewing changes: new baseline
node dist/cli.js scan --watch                       # re-scan whenever a config file changes
```

- **Baseline:** the first scan saves one in `~/.mcpwatch/scan-baseline.json`. After that, added or changed servers (command, arguments, URL or environment) keep being reported until you run `--accept`.
- **`--connect`:** runs each server (which executes its code) and checks its tool definitions (MW020, MW021, MW039). The baseline also remembers the tools and version, so a later update shows up as MW024 or MW038.
- **CI and dashboard:** the exit code is 1 when anything high or medium is found, for CI. Add `--json` for machine-readable output, or `--project-key mw_…` to send the results to a dashboard project, where they appear with direction *scan*.

## Demo server

[test/fixtures/demo-server/server.mjs](test/fixtures/demo-server/server.mjs) is a demo MCP server with 10 tools and the middleware built in. The tests run against it, and `npm run demo` / `npm run demo:stdio` start it (build first). It is safe to attack:
- File tools are confined to `test/fixtures/demo-server/sandbox/` (or `MCP_DEMO_SANDBOX`).
- `run_command` and `send_email` are simulated.
- `sandbox/docs/deploy-notes.txt` contains AWS's published example key, not real credentials. `.env` files are git-ignored, so a local `sandbox/config/.env` (for path-traversal demos) is never committed.

Environment switches for response-side tests:
- `MCP_DEMO_POISON=1` adds a poisoned tool (`add_numbers`) and a tool whose result carries a prompt injection (`get_news`).
- `MCP_DEMO_RUGPULL=1` swaps `read_file`'s description after its first call.

## Tests

```powershell
npm run build; npm test
```

53 tests, most of them end to end with a real MCP SDK client against the demo server:
- [dashboard.test.mjs](test/dashboard.test.mjs) covers accounts (register rules, sign in and out, lockout, per-user projects) and the full flow: create a project, connect the server with its key, see its requests, switch mode and block a client from the dashboard, report from the proxy, and revoke the key by deleting the project.
- [middleware.test.mjs](test/middleware.test.mjs) covers the middleware over stdio and HTTP: on/off, modes, poisoning, rug pull, and a stand-in Headerwatch server for events, live mode changes and client block lists.
- [proxy.test.mjs](test/proxy.test.mjs) covers the proxy.
- [gaps.test.mjs](test/gaps.test.mjs) covers MW010, MW023, MW027–MW029, MW037–MW039 and MB006 on the engine (two engines sharing a registry stand in for two servers), and `mcpwatch scan`: every MS rule, tampering until `--accept`, `--connect` against the poisoned demo server, and scanning a single command.
- [ai.test.mjs](test/ai.test.mjs) covers the AI reviewer against a stand-in model server. It checks that a finding the patterns miss is blocked and that the model can't clear a rule. It also covers answer checks, advise mode, model down and required, tool definitions and caching, withheld output, secrets masked before the model sees them, and live on/off. It ends with a run through the stdio proxy. It needs no real model.
- [transport.test.mjs](test/transport.test.mjs) covers MW030–MW036 on the engine, then over HTTP against the demo server: a foreign origin, missing auth and a leaked token are refused.
