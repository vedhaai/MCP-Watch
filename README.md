# MCPWatch

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

MCPWatch works with any MCP server and any MCP client. It needs no matching client or server of its own.

Each part has its own folder and its own npm package (npm workspaces):

| Folder | Package | What it is |
|---|---|---|
| [engine/](engine) | `@vedhaai/mcpwatch` | The guard (middleware `mcpwatch(server)`, plus a proxy for servers you can't edit), the rules, the AI reviewer, the scanner and the `mcpwatch` CLI |
| [backend/](backend) | `@vedhaai/mcpwatch-dashboard` | The dashboard server: accounts, projects, keys and the events guards report. Started with `mcpwatch-dashboard`; depends on the engine |
| [frontend/](frontend) | private | The dashboard web app (React, TypeScript, MUI). Its build goes into `backend/public/`, which the backend serves and ships |
| [python/](python) | `vedhaai-mcpwatch` (PyPI) | The Python package: the official MCP SDK, Django, Flask, FastAPI, any ASGI or WSGI app |
| [java/](java) | `ai.vedha:mcpwatch` (Maven) | The Java package: the official MCP Java SDK, and a servlet filter for Spring Boot, Quarkus, Jetty or Tomcat |

Each package keeps its tests in its own `test/` folder.

## Run it

Needs Node 20+.

```powershell
git clone https://github.com/vedhaai/MCP-Watch.git
cd MCP-Watch
npm install
npm run build
npm start
```

Without a clone, the dashboard runs with `npx @vedhaai/mcpwatch-dashboard`.

This opens the dashboard at http://127.0.0.1:9100. `npm run build` builds the engine, the frontend and the backend; `npm start` starts without building.

To work on the code, run `npm run dev` and open http://localhost:5173. It runs all three packages in watch mode in one terminal: the engine recompiles, the backend rebuilds and restarts on :9100, and the web app reloads as you save. To work on one package, run `npm run dev` in its folder (`engine/`, `backend/` or `frontend/`) instead. In dev mode, set `MCPWATCH_PORT` or `MCPWATCH_DATA` to change the dashboard's port or data folder (the web app's dev server always sends `/api` to :9100).

Every script:

| Script | What it does |
|---|---|
| `npm start` | Dashboard on :9100 from the last build. Pass options after `--`, e.g. `npm start -- --port 9200` |
| `npm run dev` | Engine, backend and web app together in watch mode; open http://localhost:5173 |
| `npm run dev:web` | The dashboard web app with hot reload on :5173, using the API of a dashboard running on :9100 |
| `npm test` | All tests (engine, then backend). One package: `npm test -w engine` or `npm test -w backend` |
| `npm run test:java` | The Java package's tests (needs Java 17+ and Maven) |
| `npm run scan` | Check the MCP servers configured on this machine. Pass options after `--`, e.g. `npm run scan -- --connect` |
| `npm run ai` | Score the AI reviewer's model on 50 labelled messages (attacks caught, false alarms) |
| `npm run rules` / `npm run pins:reset` | List the rules / forget pinned tool definitions |

### Connect a server through the dashboard

1. Open **http://127.0.0.1:9100** and **create an account** (or sign in). Click **New project**, enter a name, and pick how your server is built:
   - **Node/TypeScript server:** middleware.
   - **Python server** (MCP SDK, Django, Flask, FastAPI): Python middleware.
   - **Java server** (MCP Java SDK, Spring Boot, Quarkus): Java middleware.
   - **Any local server:** stdio proxy.
   - **Any remote server:** HTTP proxy.
2. The **Setup** page shows the steps with your project key filled in. It says *Waiting…* until your server first contacts the dashboard, then turns **Connected**.
3. Call tools from your MCP client, including attacks such as `read_file` with `../../.ssh/id_rsa`. They appear on the project's **Requests** page.

After sign-in, the sidebar has each project's pages, the top bar switches projects, and **Ctrl+K** jumps to any page, project or action. The theme button (and Ctrl+K) switches between **System**, **Light** and **Dark**; the choice is saved in the browser.

The project pages:

| Page | What it does |
|---|---|
| **Requests** | Totals at the top, then every message checked: filter by action or search, and select one to see its findings, AI review and redacted excerpt |
| **Clients** | MCP clients that connected, with their sessions and recent messages. **Block** refuses everything from a client; **Trust** lets it through |
| **Setup** | Connection steps and the project key |
| **Settings** | Mode (`off` / `observe` / `protect` / `enforce`), scoring thresholds, denied tools, AI review (rules only, a local model, or a model with an API key, plus Test AI), transport settings (allowed web origins, require auth, expected token audience), rename, rotate key, clear requests, delete |

New projects start in **observe** mode: nothing is blocked, and each request shows what enforce would have done. Changes on the Clients and Settings pages reach the guard within 5 seconds, with no restart.

**Accounts:** each user signs in with a username and password, and sees only their own projects. Users can have any number of projects, each with its own key. Passwords are stored as scrypt hashes, and sessions use an HttpOnly cookie that lasts 14 days. After 5 wrong passwords, sign-in for that username pauses for 5 minutes. Projects created before accounts existed go to the first account. Guards don't sign in; they use the project key.

Data lives in `~/.mcpwatch/server/`: `users.json`, `sessions.json`, `projects.json`, plus one events file per project. The dashboard listens on 127.0.0.1 only. Project keys and AI API keys are stored encrypted (AES-256-GCM) in `projects.json`. The encryption key is `MCPWATCH_DATA_KEY` if you set it (keep it outside the data folder and a copy of `projects.json` is useless without it), else a random one generated into `secret.key` in the data folder, which only protects the file on its own. Keys saved in the clear by an older version are encrypted at the next start.

## Add it to your MCP server (middleware)

```powershell
npm install @vedhaai/mcpwatch
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpwatch } from "@vedhaai/mcpwatch";

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
| `MCPWATCH_PROJECT_KEY_FILE` | Read the project key from this file instead (also `--project-key-file`): it then shows in neither the process listing nor the environment |
| `MCPWATCH_REQUIRE_SIGNED` | `1`: refuse settings from the dashboard that aren't signed with the project key, even the first time |
| `MCPWATCH_STRICT_PINS` | `1`: never pin a new tool; one that isn't pinned already is refused (see below) |
| `MCPWATCH_PINS_KEY` | Signs `pins.json` and `registry.json` with an HMAC, so an edited or replaced file isn't believed |
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
| `MCPWATCH_AI_ALLOW_HOSTED=1`, `MCPWATCH_AI_HOSTED_MAX_CHARS` | Allow a model on another machine or a hosted API (message text goes there; default: only a model on this machine is used), and the most text sent to it per message (default 3000) |
| `MCPWATCH_AI_INPUT_PRICE`, `MCPWATCH_AI_OUTPUT_PRICE` | Price in US dollars per million tokens, to put a cost on each review (default 0) |
| `MCPWATCH_AI_MAX_TOKENS_PER_DAY`, `MCPWATCH_AI_MAX_COST_PER_DAY` | Daily caps (UTC day). Once reached, the model isn't called until the next day and the rules decide (default 0 = no cap) |
| `MCPWATCH_AI_CIRCUIT_FAILURES`, `MCPWATCH_AI_CIRCUIT_COOLDOWN_MS` | Stop calling a failing model after this many failures in a row (default 3, 0 = never), for this long (default 30000) |
| `MCPWATCH_AI_REQUIRE_VERIFIED=1`, `MCPWATCH_AI_VERIFIED_FILE` | Only a model that passed `mcpwatch ai` may block on its own, and where passes are recorded (default `~/.mcpwatch/ai-verified.json`) |
| `MCPWATCH_EVENTS`, `MCPWATCH_PINS`, `MCPWATCH_CONFIG` | Local events file (used when there's no key), pinned tools file, policy file |

Events are sent in the background, about once a second. If the dashboard is down, the MCP server keeps working.

**Headerwatch server:** the guard uses the same agent API as Headerwatch (`GET /api/agent/config`, `POST /api/agent/events`). To report to Headerwatch instead, set `MCPWATCH_SERVER=http://127.0.0.1:9000` and use a Headerwatch project key. MCP events show there as generic requests: method `CALL`, path `mcp → tools/call read_file`.

### Other ways to test

- Start your server with `MCPWATCH_ENABLED=0` to see the same attacks reaching the server.
- Without a project key, events go to `~/.mcpwatch/events.jsonl`. Open them under **Local events** on the dashboard's Projects page.
- For an HTTP server, point any MCP client (or the MCP Inspector, `npx @modelcontextprotocol/inspector`) at its `/mcp` URL.

## Python servers (MCP SDK, Django, Flask, FastAPI)

The [Python package](python) adds the same guard to a server written in Python, with one line:

```python
mcpwatch(server)                                         # official MCP SDK: MCPServer / FastMCP, stdio, SSE, HTTP
MIDDLEWARE = ["mcpwatch.django.McpWatchMiddleware", ...]  # Django settings.py
McpWatch(app)                                            # Flask (from mcpwatch.flask import McpWatch)
app.add_middleware(McpWatchASGI)                         # FastAPI / Starlette; McpWatchWSGI for any WSGI app
```

The checks run in this package's engine, which the Python package starts as a child process (`mcpwatch engine`, JSON lines over stdin/stdout). So Python servers get the same rules, AI reviewer, dashboard reporting and live settings as Node servers, and **Node 20+ must be installed** next to Python. It takes the same `MCPWATCH_*` variables. Options in code are the middleware's in snake_case (`project_key`, `deny_tools`, …). Setup, options and tests: [python/README.md](python/README.md).

## Java servers (MCP Java SDK, Spring Boot, Quarkus, Jetty, Tomcat)

The [Java package](java) adds the same guard to a server written in Java, with one line:

```java
McpServer.sync(McpWatch.guard(transport))        // official MCP Java SDK: stdio, HTTP+SSE
new McpWatchFilter("my-tools", options, "/mcp")  // any servlet app, and Streamable HTTP
```

```xml
<dependency><groupId>ai.vedha</groupId><artifactId>mcpwatch</artifactId><version>0.1.1</version></dependency>
```

As for Python, the checks run in this package's engine, which the Java package starts as a child process (`mcpwatch engine`, JSON lines over stdin/stdout), so Java servers get the same rules, AI reviewer, dashboard reporting and live settings as Node servers, and **Node 20+ must be installed** next to Java. It needs Java 17+, takes the same `MCPWATCH_*` variables, and brings no dependencies of its own beyond SLF4J. Setup, options and tests: [java/README.md](java/README.md).

## Proxy: for MCP servers you can't edit

For third-party servers (e.g. `npx` packages), put `mcpwatch` in front of the server command in the client's config (Claude Desktop, Cursor, Claude Code…). The proxy runs the same engine and rules as the middleware:

```json
"my-server": {
  "command": "npx",
  "args": ["-y", "@vedhaai/mcpwatch", "--project-key", "mw_...", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/mcp-test"]
}
```

For a remote server, use `npx -y @vedhaai/mcpwatch http --listen 8800 --upstream <url> --project-key mw_...`, then point the client at `http://127.0.0.1:8800/mcp`. A project created as a proxy project shows these steps on its Setup page with the key filled in. Without `--project-key`, the proxy writes to the local events file.

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

With the AI reviewer on, a model reviews every message against the rules below, on top of the pattern checks. It covers tool calls, resource reads, prompts, tool definitions, tool results, sampling and elicitation. Pings, list requests and notifications are not reviewed. It catches what patterns can't, such as instructions to the model hidden in an email body. With a model on the guard's machine (the default), nothing leaves the machine. A hosted model is possible, but only when you allow it (see [Hosted models](#hosted-models)).

```powershell
ollama pull qwen2.5:7b                             # any model works; this one is the default
node engine/dist/cli.js ai                       # score the model on 50 labelled messages
node engine/dist/cli.js --ai -- npx -y some-mcp-server     # proxy with AI review
```

### Choosing and checking a model

`mcpwatch ai` sends 50 labelled messages to the model: 15 ordinary ones that must pass, and 35 attacks across six groups (injection, paths and URLs, secrets, poisoned tool definitions, poisoned tool output, and attacks that hide in encoding, unicode, other languages or several fields). It prints what was caught and missed per group, the false alarms, and the tokens and cost used.

| | Pass mark |
|---|---|
| Attacks caught | at least 80% |
| Ordinary messages flagged | at most 10% |

A model that passes is recorded in `~/.mcpwatch/ai-verified.json`. The command exits 0 on a pass, so it can run in CI. The first sample includes loading the model, so a local run takes a minute or two.

Rules of thumb for picking a model. These are not measurements: this project publishes no scores, so run the check on the model you intend to use.

| Class | Speed and cost | What to expect |
|---|---|---|
| Small (about 3B) | Fastest; free locally | Usually fine on plain attacks, often misses the hidden ones; likely to fall short of the pass mark |
| 7B–8B (`qwen2.5:7b` is the default) | About 0.4–1 s per message on a laptop GPU; free locally | A reasonable starting point for inline review. Expect misses in the hidden-attack group |
| 14B and up, or a small hosted model | Slower or paid | Better on the hidden attacks. Hosted models send message text off the machine and cost tokens |

Until a model has passed, treat it as an extra opinion on top of the rules: run it with `--ai-advise` (its findings add to the session score but never block alone), or set `MCPWATCH_AI_REQUIRE_VERIFIED=1` so an unchecked model is held to that automatically. `requireVerified` is off by default so existing setups keep blocking. The pattern rules never depend on the model either way.

**From the dashboard** (projects with a key): the Settings tab's **AI review** section has three choices. Guards pick the choice up within 5 seconds, with no restart.

| Choice | What reviews each message |
|---|---|
| **Rules only** (default) | The rules alone. No model is called |
| **Local model** | A model server on the guard's machine. Leave the URL and model empty for Ollama with `qwen2.5:7b`; any OpenAI-compatible server works (LM Studio, llama.cpp, vLLM) |
| **Model with an API key** | A hosted model through its OpenAI-compatible API. Presets for OpenAI, Anthropic (Claude), Google Gemini, Groq and OpenRouter, or a custom URL |

- **Test AI:** sends one sample attack to the chosen model, before or after saving. It shows the response time and whether the model caught the attack, or why it failed (for example, a refused key).
- **The API key:** stored encrypted in the dashboard's `projects.json` and passed to the project's guards with their settings. After saving, the browser only ever sees its last 4 characters. Leave the key field empty to keep the saved one.
- **Data leaving the machine:** with an API model, messages go to that provider, so saving one asks you to confirm it (see [Hosted models](#hosted-models)). With a local model, nothing leaves the machine.
- **Timeouts:** 8 s for a local model, 15 s for an API model.
- **JSON mode:** some providers reject it. The guard then asks again without it.

**Without a dashboard**, for the middleware, set `MCPWATCH_AI=1` or pass `mcpwatch(server, { ai: { enabled: true } })`. Set `--ai-url` / `MCPWATCH_AI_URL`, `--ai-model` / `MCPWATCH_AI_MODEL`, and `MCPWATCH_AI_KEY` for an API model.

How it decides:
- **It can add, never remove.** The pattern rules still run and still block on their own. A payload that talks the model into "this is safe" can't undo a rule's finding.
- **Same rule ids.** The model reports the rules a message breaks (MW001, MW020, MW022, …), or **MA001** for a threat no rule covers. The model's answers are checked:
  - A rule id it wasn't given becomes MA001.
  - A finding under 0.6 confidence counts one severity lower.
- **Authority:** with `block` (the default), a high AI finding blocks like a rule. With `advise` (`--ai-advise`), AI findings count at most medium: they add to the session score but never block alone. With `requireVerified`, a model that hasn't passed `mcpwatch ai` is held to `advise`.
- **Fallback:** if the model is down, times out or answers nonsense, the rules alone decide, and the event shows `ai: error` with the kind of failure (`timeout`, `unreachable`, `http`, `auth`, `parse`, `busy`, `budget`, `circuit` or `consent`). With `required: true`, the message is blocked instead (MA002).
- **Privacy:** secrets and the caller's own token are masked before the text goes to the model. Text is cut at 6,000 characters (3,000 for a hosted model). Unchanged tool definitions and repeated messages are answered from a cache.
- **Latency:** with `qwen2.5:7b` on a typical laptop GPU, about 0.4–1 s per reviewed message once the model is loaded. The guard loads the model when it starts. Messages are still delivered in order.

The Requests page marks AI findings with ✦ and shows each message's AI verdict, review time, and the tokens and cost it used.

### Hosted models

A model that is not on the guard's machine (a hosted API, or a server elsewhere on the network) sees the text of every reviewed message. So it is **not used until you allow it**:

- **Dashboard:** saving an API model, or a "local" model at another address, requires ticking *Allow sending message text to this model*. Projects saved before this existed keep working.
- **Without a dashboard:** `--ai-allow-hosted`, `MCPWATCH_AI_ALLOW_HOSTED=1` or `"allowHosted": true`. Without it the review is skipped (`ai.failure: "consent"`), the rules decide, and with `required` the message is blocked (MA002). Not even the warm-up request is sent.

A hosted model also gets less than a local one. On top of secrets, the guard masks emails (the domain stays, since it shows where data would go), card numbers (checked with the Luhn test, so order numbers stay readable), US social security numbers and user names in file paths. It sends at most 3,000 characters per message (`hostedMaxChars`). The first review to a hosted endpoint prints a notice saying so, and the startup line shows the model's host and whether it is allowed.

### Usage and cost

Each reviewed message's event records the tokens used (as the model server reports them, or estimated at about 4 characters per token and marked with `~` when it reports none) and, if you set a price, the cost. Cached answers cost nothing. `Engine.aiStats()` returns today's totals: reviews, cache hits, failures by kind, tokens and cost.

To cap spend, set `maxTokensPerDay` or `maxCostPerDay` (UTC day). Once a cap is reached, the model isn't called until the next day, events show `ai.failure: "budget"`, and the rules decide.

### When the model keeps failing

After 3 failures in a row (`circuitFailures`) the reviewer stops calling the model for 30 seconds (`circuitCooldownMs`), so a model that is down costs one timeout, not one per message. Events show `ai.failure: "circuit"` and no waiting. After the pause a single review goes through as a probe: if it works, reviews resume; if not, the pause starts again. Cached answers are still used meanwhile. Changing the model, URL or key starts afresh. Set `circuitFailures` to 0 to turn it off.

Policy file (all fields optional):

```json
{ "ai": { "enabled": true, "url": "http://127.0.0.1:11434/v1", "model": "qwen2.5:7b", "timeoutMs": 8000,
          "minConfidence": 0.6, "authority": "block", "required": false, "maxChars": 6000,
          "allowHosted": false, "hostedMaxChars": 3000,
          "inputPricePerMTok": 0, "outputPricePerMTok": 0, "maxTokensPerDay": 0, "maxCostPerDay": 0,
          "circuitFailures": 3, "circuitCooldownMs": 30000, "requireVerified": false } }
```

## Rules

Run `node engine/dist/cli.js rules` for the full list.

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
  - MW027 tool name collision: another server on this machine offers the same tool (a server with the exact same tool list is treated as this server under another name, e.g. after a rename, and is not a collision)
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

Collisions, shadowing and cross-server leakage need to know about the *other* MCP servers on the machine. Every guard shares a small registry for that: `~/.mcpwatch/registry.json` holds the tool names per server, a digest of each server's whole tool list (names, descriptions and schemas, so a renamed server is still recognized as itself), and hashes (not the text) of sensitive output lines for one hour.

Pinned tool definitions live in `~/.mcpwatch/pins.json`. After you deliberately update a server, run `mcpwatch pins reset`.

By default the first definition seen for a tool is trusted (trust on first use). Two options tighten that:

- **Strict pinning** (`strictPins: true`, or `MCPWATCH_STRICT_PINS=1`): nothing new is pinned. A tool that isn't in `pins.json` is refused like a changed one (MW024), and a changed server name or version (MW038) keeps being reported instead of being accepted after the first time. Run once normally to learn your tools, then switch it on.
- **Signed pin files** (`MCPWATCH_PINS_KEY`): `pins.json` and `registry.json` carry an HMAC. A file that was edited, or swapped for an unsigned one, is not believed: every tool counts as changed until you check your servers and run `mcpwatch pins reset`. Keep the key out of the data folder. When you turn it on for the first time, run `mcpwatch pins reset` once so the file is signed.

Policy file (`--config policy.json`), all fields optional:

```json
{ "mode": "enforce", "windowSeconds": 60, "throttleAt": 3, "blockAt": 6,
  "denyTools": ["run_command"], "allowTools": [], "failOpen": false,
  "allowedOrigins": ["https://app.example.com"], "allowedHosts": [], "requireAuth": false, "expectedAudience": "" }
```

Settings about the guard itself:

| Setting | Default | What it does |
|---|---|---|
| `failOpen` | `false` | If a check throws, refuse the request with `-32001`. `true` forwards it unchecked. Notifications and responses have no id to answer, so they pass either way. (The Python and Java adapters have their own `fail_open` / `failOpen` for the case where the engine process can't run; it now defaults to `false` there too.) |
| `maxBodyBytes` | 10 000 000 | HTTP proxy: the largest request body it reads (413 beyond), and the largest single SSE event it buffers |
| `upstreamTimeoutMs` | 60 000 | HTTP proxy: how long the upstream has to start answering |
| `aiMaxConcurrent` | 8 | Most reviews with the model at once; up to 64 more wait, the rest skip the review (rules only, or MA002 when `required`) |
| `maxSessions` | 10 000 | Most sessions one guard keeps; the least recently used go first |
| `strictPins` | `false` | Never pin new tools; an unpinned tool is refused |

The guard's own files (`pins.json`, `registry.json`, `events.jsonl`, `scan-baseline.json`) are created readable by their owner only (`0600`, directory `0700`). `events.jsonl` rotates to `events.jsonl.1` at 20 MB.

**The dashboard link.** A project key is only sent over `https://` or to a loopback address; any other plain-HTTP dashboard URL is refused with a warning and the guard logs to the local events file instead. An AI endpoint pushed from the dashboard must also be `https://` or loopback. The dashboard signs the settings it sends with the project key (header `X-MCPWatch-Signature`), so something else answering on port 9100 can't hand a guard settings of its own: a wrong signature is ignored, and once a guard has seen a signed answer it refuses unsigned or older ones. Prefer `--project-key-file` or `MCPWATCH_PROJECT_KEY` to `--project-key`: command lines are visible to other users. The server a guard wraps (and any server `scan --connect` starts) gets the guard's environment without `MCPWATCH_PROJECT_KEY`, `MCPWATCH_PROJECT_KEY_FILE`, `MCPWATCH_AI_KEY`, `MCPWATCH_PINS_KEY` and `MCPWATCH_ENGINE_OPTIONS`.

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
node engine/dist/cli.js scan                              # all MCP clients on this machine
node engine/dist/cli.js scan -- npx -y some-mcp-server     # one command, before you install it
node engine/dist/cli.js scan --connect                     # also start each server and check its tools
node engine/dist/cli.js scan --accept                      # after reviewing changes: new baseline
node engine/dist/cli.js scan --watch                       # re-scan whenever a config file changes
```

- **Baseline:** the first scan saves one in `~/.mcpwatch/scan-baseline.json`. After that, added or changed servers (command, arguments, URL or environment) keep being reported until you run `--accept`.
- **`--connect`:** runs each server (which executes its code) and checks its tool definitions (MW020, MW021, MW039). The baseline also remembers the tools and version, so a later update shows up as MW024 or MW038.
- **CI and dashboard:** the exit code is 1 when anything high or medium is found, for CI. Add `--json` for machine-readable output, or `--project-key mw_…` to send the results to a dashboard project, where they appear with direction *scan*.

## Tests

```powershell
npm run build; npm test
```

31 tests. The engine's 28, in [engine/test](engine/test):
- [gaps.test.mjs](engine/test/gaps.test.mjs) covers MW010, MW023, MW027–MW029, MW037–MW039 and MB006 on the engine (two engines sharing a registry stand in for two servers), and `mcpwatch scan`: every MS rule, tampering until `--accept`, and scanning a single command.
- [ai.test.mjs](engine/test/ai.test.mjs) covers the AI reviewer against a stand-in model server. It checks that a finding the patterns miss is blocked and that the model can't clear a rule. It also covers answer checks, advise mode, model down and required, tool definitions and caching, withheld output, secrets masked before the model sees them, and live on/off. It also covers token and cost tracking, daily caps, failure kinds, the circuit breaker, hosted-model consent and masking, and `requireVerified`. It needs no real model.
- [ai-eval.test.mjs](engine/test/ai-eval.test.mjs) covers the model check behind `mcpwatch ai`: the sample set, the scoring and pass marks, the command itself and the record of checked models.
- [transport.test.mjs](engine/test/transport.test.mjs) covers MW030–MW036 on the engine.
- [engine.test.mjs](engine/test/engine.test.mjs) covers `mcpwatch engine`, the sidecar the Python package uses: verdicts, redaction, HTTP refusals, mode changes and options.

The backend's 3, in [backend/test](backend/test):
- [dashboard.test.mjs](backend/test/dashboard.test.mjs) covers accounts (register rules, sign in and out, lockout, per-user projects) and projects: settings validated and passed to the guards' config, a guard showing as connected, and revoking the key by deleting the project.
- [ai-settings.test.mjs](backend/test/ai-settings.test.mjs) covers each project's AI settings: rules only, a local model or an API model, what the guards receive, the key never going back to the browser, and Test AI.

The Python package has its own tests (`npm run test:python`, after installing it as shown in [python/README.md](python/README.md#tests)). They cover an SDK server over stdio and Streamable HTTP, Flask, Django, plain ASGI and WSGI apps, and the engine being unavailable.

The Java package has 59, in [java/src/test](java/src/test/java/ai/vedha/mcpwatch) (`npm run test:java`, needs Java 17+ and Maven). They run against the engine built in this repository, so they check real verdicts: the JSON codec, the sidecar protocol, the HTTP guard's JSON and SSE handling, the servlet filter end to end through a real Jetty server, and the SDK transport and session wrapper.
