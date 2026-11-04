# MCPWatch Architecture

A guard inside your MCP server checks every JSON-RPC message in both directions: tool calls going in, tool lists and results coming out. A small Node dashboard stores what it saw and hands back your settings. A local AI model reviews each message alongside the rules.

See the [README](README.md) for setup, and for the full rule and option lists.

## The whole system

```
                              every tool call, tool definition and result
                              (the guard waits for the verdict, ~0.4–1 s)
                    ┌─────────────────────────────────────────────────────────────┐
                    │                                                             ▼
┌────────────┐   ┌──┴──────────── your MCP server ─────────────┐        ┌──────────────────┐
│ MCP client │   │ ┌──────── MCPWatch guard ─────────────────┐ │        │ Ollama :11434    │
│ Claude,    │──►│ │ Engine (36 rules, score,  ◄──► AI        │ │        │ qwen2.5:7b       │
│ Cursor, …  │◄──│ │ mode, lists)                  reviewer   │ │        └──────────────────┘
└────────────┘   │ │   ▲                                      │ │
 message /       │ │   ▼                Event sender ─────────┼─┼──► events, ~1 s ──┐
 −32001/−32002   │ │ Sessions           Settings poller ◄─────┼─┼─── settings, 5 s ─┤
                 │ │ (in memory)        Pins + registry       │ │                   │
                 │ └─────┬──────▲───────(~/.mcpwatch)─────────┘ │     ┌─────────────┴──────────────┐
                 │ allowed│      │results                       │     │ dashboard 127.0.0.1:9100   │
                 │       ▼      │                               │     │ /api/agent/*  project key  │◄── mcpwatch scan
                 │ ┌──────────────────────────────┐            │     │ /api/*        login cookie │◄─► browser (2 s refresh)
                 │ │ your tools / the real server │            │     │ JSON files in              │
                 │ └──────────────────────────────┘            │     │ ~/.mcpwatch/server/        │
                 └──────────────────────────────────────────────┘     └────────────────────────────┘
```

Unlike Headerwatch, the AI reviewer sits on the message path. The guard waits for its verdict, so a high AI finding can block a call before the tool runs. The two background links (events out, settings back) are the only connection to the dashboard. If the dashboard is down, the MCP server keeps working.

## The parts

| Part | Code | What it does |
|---|---|---|
| **Guard** | [src](src): [engine.ts](src/engine.ts), [rules.ts](src/rules.ts), [state.ts](src/state.ts), [transport.ts](src/transport.ts) | One engine, three ways in (below). Runs the rules, keeps session state in memory, decides allow / throttle / block / strip / redact, and reports in the background. |
| **AI reviewer** | [ai.ts](src/ai.ts) | Calls any OpenAI-compatible endpoint (Ollama by default) with the relevant slice of the rule catalog. Answers are checked, cached and merged into the rule findings. |
| **Dashboard** | [dashboard.ts](src/dashboard.ts), [auth.ts](src/auth.ts), [public/dashboard.html](public/dashboard.html) | Plain Node HTTP server on 127.0.0.1:9100. `/api/agent/*` for guards (project key), `/api/*` for the page (login cookie). Stores everything as JSON files. |
| **Reporting** | [headerwatch.ts](src/headerwatch.ts), [events.ts](src/events.ts) | Batches events to `POST /api/agent/events` about once a second and polls `GET /api/agent/config` every 5 s. It uses the same agent API as Headerwatch, so a Headerwatch server works too. |
| **Scan** | [scan.ts](src/scan.ts) | `mcpwatch scan` runs before any server starts. It checks the MCP server lists of Claude Desktop, Claude Code, Cursor, VS Code and Windsurf (MS001–MS007). |
| **Demo server** | [test/fixtures/demo-server](test/fixtures/demo-server) | A safe-to-attack server with 10 tools and the middleware built in. The tests run against it; any MCP client can connect to it. |

### Three ways in

All three run the same `Engine`. Only the wrapping differs.

| Mode | File | Sits between | Use when |
|---|---|---|---|
| Middleware | [middleware.ts](src/middleware.ts) | The SDK's protocol layer and its transport (`GuardedTransport`) | You own a Node/TypeScript server: add `mcpwatch(server)` before `connect()` |
| stdio proxy | [stdio-proxy.ts](src/stdio-proxy.ts) | The client's stdin/stdout and a child process | A local server you can't edit (`npx …`) |
| HTTP proxy | [http-proxy.ts](src/http-proxy.ts) | The client and a remote Streamable HTTP URL, including SSE streams | A remote server |

`Engine.fromClient` and `Engine.fromServer` are async because of the AI reviewer. Each wrapper keeps a promise queue per direction, so a slow review never lets a later message overtake an earlier one.

## One tool call, step by step

Everything here happens inside the guard, before your tool handler runs (`Engine.fromClient`).

1. **Queue in order.** The message waits for the one before it in the same direction.
2. **Find the session.** stdio: one session per connection. HTTP: the `Mcp-Session-Id`, else a hash of the caller's token, else one shared bucket.
3. **Transport rules (HTTP only).** MW030–MW036: foreign origin or host, missing auth, token passthrough, session hijacking, plain HTTP, impersonation, wrong token audience.
4. **Call rules.** These catch a denied or unknown tool, injection and traversal in arguments, a schema mismatch, secrets and a rug-pulled tool (MW001–MW010, MW024).
5. **Behaviour rules.** MB001–MB006 read the session: floods, enumeration, replays, a secret read followed by an outbound tool, another server's sensitive output.
6. **AI review, if on.** The model reports the rules the call breaks, or MA001 for anything else. Its findings are added; it can't remove one. If the model is down, the rules alone decide, unless the reviewer is required (MA002).
7. **Mode decides.**
   - `observe`: always allow.
   - `protect`: refuse high severity with `−32001`.
   - `enforce`: also throttle (`−32002`) at session score 3 and block at 6, within a 60 s window.
8. **Your lists override.** A blocked client is refused and a trusted client is allowed, in every mode.
9. **Forward and report.** Allowed calls reach your tool. Every non-trivial message is queued for the dashboard with a short, secret-redacted snippet.

## The way back

Messages from the server are checked in `Engine.fromServer`. The guard can only withhold or clean them, so `protect` and `enforce` act the same here.

| Message | Checked for | What the guard does |
|---|---|---|
| `tools/list` | Poisoning, invisible characters, shadowing, collisions, rug pulls against the pinned definition, AI review per tool | Strips the tool or cleans hidden characters. Each unchanged definition is reviewed only once (cached). |
| `tools/call` result | Prompt injection, secrets, the caller's own token, oversize, AI review | Withholds injections as an error result and redacts secrets |
| `resources/read`, `prompts/get` | Same as tool results | Same as tool results |
| `sampling/createMessage` | Always noted (MW026), injection in the prompt, AI review | Refused with a JSON-RPC error to the server when high |
| `elicitation/create` | Forms or links asking for passwords, keys or card details (MW029), AI review | Refused before the user sees it |
| `initialize` | Server name or version changed since it was pinned (MW038) | Reported only |

## The AI reviewer

[ai.ts](src/ai.ts) and its wiring in `Engine.review`:

- **What it sees.** Each kind of message is reviewed against its own slice of the catalog, with a hint per rule:
  - tool calls: MW001–MW005 and MW010
  - tool definitions: MW020, MW021 and MW028
  - server output: MW022, MW025 and MW029
  - every kind also gets MA001

  The message is wrapped in randomly named `<untrusted-…>` tags. The model is told to treat the content as data.
- **What leaves the process.** Text with secrets masked and the caller's token removed, cut at 6,000 characters.
- **Answers are checked.**
  - The reply must be JSON.
  - A rule ID the model wasn't given becomes MA001.
  - A finding under 0.6 confidence counts one severity lower.
  - In `advise` mode, findings are capped at medium.
  - A "block" with no finding counts as a medium MA001.
- **Merge, never subtract.** AI findings are added unless the rules already raised the same rule at the same or higher severity. Rule findings are never removed. This matters because the payload being reviewed can address the model directly.
- **Cache and warm-up.** Answers are cached (LRU, 1,000 entries) by model, kind and content. The guard sends a tiny request when it starts or when AI is switched on, so the first real message doesn't wait for the model to load.
- **Failure.** On a timeout (default 8 s), an error or an answer that isn't JSON, the event records `ai.verdict: "error"` and the rules decide. With `required: true`, the message is blocked as MA002.

## The settings loop

When you change **AI review** (rules only, a local model, or a model with an API key), change the mode, or block a client:

| When | What happens |
|---|---|
| 0 s | The page sends `PATCH /api/projects/…` or posts to the client list. |
| 0 s | The dashboard writes `projects.json` and raises the project's settings version. |
| ≤ 5 s | The guard's poller reads `/api/agent/config`, and `policyFromConfig` passes the new settings to `engine.updatePolicy`. Turning AI on also warms up the model. |
| next message | The new settings apply. No restart. |

With a project key, the project's settings win over the guard's local options and environment (for example `MCPWATCH_MODE`, `MCPWATCH_AI`).

## Where things live

| What | Where | Notes |
|---|---|---|
| `:9100` | Dashboard | `npm start`, on 127.0.0.1 only |
| `:3001` | Demo server (HTTP) | `npm run demo` |
| `:11434` | Ollama | `ollama serve` with `qwen2.5:7b`; any OpenAI-compatible server via `MCPWATCH_AI_URL` |
| `~/.mcpwatch/server/` | Dashboard data | `users.json`, `sessions.json`, `projects.json`, `events/<id>.jsonl` per project (rotated at 20 MB) |
| `~/.mcpwatch/pins.json` | Every guard | Pinned tool definitions and server versions; `mcpwatch pins reset` after a deliberate update |
| `~/.mcpwatch/registry.json` | Every guard | Tool names per server, and hashes of sensitive output lines for one hour (MW027, MW028, MB006) |
| `~/.mcpwatch/events.jsonl` | Guards without a key | Local event log, shown under Local events on the dashboard |
| `~/.mcpwatch/scan-baseline.json` | `mcpwatch scan` | The accepted configs, for MS006 tampering |
| memory | Each guard | Sessions, scores, call history, the AI cache. Reset on restart. |

## Limits of this proof of concept

- **One computer.** The dashboard listens on 127.0.0.1, so only guards on this machine can report to it.
- **Keys in plain JSON.** Project keys and AI API keys are stored unencrypted in `projects.json`. Any guard with the project key receives the AI key with its settings, over plain HTTP on loopback.
- **JSON files, not a database.** Fine for a few projects. Many busy servers need real storage.
- **State per process.** Each guard keeps its own sessions and scores. Only pins and the registry are shared, through files.
- **The AI adds latency and misses things.** A 7B model takes about 0.4–1 s per reviewed message, longer while it loads. In testing it missed a metadata-URL SSRF that MW003 caught. That's why the rules keep the final say.
- **Polling, not streaming.** The page refreshes every 2 seconds and guards fetch settings every 5.
