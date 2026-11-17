<img src="https://raw.githubusercontent.com/vedhaai/MCP-Watch/main/frontend/src/assets/logo.png" alt="MCPWatch" width="96">

# MCPWatch for .NET (C#, VB.NET, .NET Framework)

The [MCPWatch](https://github.com/vedhaai/MCP-Watch) security guard for MCP servers written in C# or VB.NET, **including .NET Framework**. It checks every JSON-RPC message between any MCP client and your server, in both directions, and blocks, throttles, strips or redacts what's dangerous: command and SQL injection, path traversal, SSRF, leaked secrets, poisoned tool definitions, rug pulls, prompt injection in tool output, and more.

Clients need no changes.

## Install

```powershell
dotnet add package Vedhaai.MCPWatch
```

```powershell
Install-Package Vedhaai.MCPWatch      # Package Manager Console, classic .NET Framework projects
```

The checks themselves run in the MCPWatch engine, which this package starts as a small child process (`mcpwatch engine`). The same engine provides the AI reviewer, the dashboard reporting and the live settings, so a .NET server gets exactly the verdicts a Node, Python or Java one would. **Node.js 20+ must be installed** on the machine running the server:

```powershell
npm install -g @vedhaai/mcpwatch     # without it, the package falls back to npx (slower first start)
```

### Requirements

| | |
|---|---|
| .NET Framework | 4.6.1 or newer (4.7.2+ recommended) |
| .NET | 6, 8 or any later version (the package targets `netstandard2.0`) |
| Node.js | 20 or newer, on the same machine |

The package has **no dependencies at all**. JSON is handled by its own small codec, so MCPWatch can never force a Newtonsoft.Json or System.Text.Json version (or a binding redirect) on the application it is injected into. A guard that caused an assembly conflict would be self-defeating.

## Use

You hand the guard every JSON-RPC message that crosses your server, in each direction, and send on what comes back. This works for any server, however it reads and writes messages: a hand-written stdio loop, a Windows service, an HTTP handler, or an SDK's transport hook.

```csharp
using Vedhaai.MCPWatch;

using (var guard = McpWatchGuard.CreateIfEnabled("my-tools", new McpWatchOptions
{
    ProjectKey = "mw_...",          // from the dashboard
    Mode = "enforce",
    DenyTools = new[] { "run_command" },
}))
{
    string line;
    while ((line = Console.In.ReadLine()) != null)
    {
        // client -> server
        Outcome o = await guard.FromClientLineAsync("session-1", line);
        if (o.ReplyJson != null)   Console.Out.WriteLine(o.ReplyJson);    // refused: the tool never runs
        if (o.ForwardJson != null) await HandleInYourServer(o.ForwardJson);
    }
}

// server -> client: every message your server sends back
Outcome r = await guard.FromServerLineAsync("session-1", responseJson);
if (r.ForwardJson != null) Console.Out.WriteLine(r.ForwardJson);          // possibly rewritten or redacted
```

- `Reply` is a JSON-RPC answer for the **sender** (a blocked call gets `-32001`, a throttled one `-32002`). Send it back and do not pass the message on.
- `Forward` is the message to **pass on**. It may have been changed: a poisoned tool removed from `tools/list`, an injected tool result replaced with an error result, secrets in output redacted. It is `null` when the message was refused.
- Both `FromClient…` and `FromServer…` exist as typed (`Dictionary<string, object>`) and raw-line (`…LineAsync`) versions, and the engine is also available directly as `Engine` (`FromClient`, `FromServer`, and async twins).
- Call `guard.DropSession(id)` when a connection closes.
- stdout is the protocol channel on a stdio server, so the guard only ever logs to **stderr**.

When MCPWatch is off (`Enabled = false` or `MCPWATCH_ENABLED=0`), `CreateIfEnabled` returns `null`, so the server runs untouched: guard with `guard?.…`.

### Order is kept

Messages of one session in one direction are checked strictly in the order they were submitted, however long a check takes (the AI reviewer needs about a second). A `tools/list` never overtakes its own `initialize`. Submit messages without awaiting each one if you like; the guard queues them.

If you call `Engine.FromClient`/`FromServer` directly instead of the guard, keeping that order is your job.

### Classic ASP.NET and other synchronous code

`Engine.FromClient` and `Engine.FromServer` are synchronous and safe to call anywhere. The async methods never resume on the caller's context, so waiting on them (`.Result`) from a classic ASP.NET request thread cannot deadlock, although the sync versions are the better choice there.

## Modes

New dashboard projects start in `observe`. Without a dashboard the default is `enforce`.

| Mode | Behaviour |
|---|---|
| `off` | Pass everything through and record nothing |
| `observe` | Forward everything; events record what `enforce` would have done |
| `protect` | Block high-severity findings only |
| `enforce` | Block high severity; throttle at session score 3, block at 6 (60 s window) |

Changing the mode at runtime, with no restart:

```csharp
guard.SetMode("observe");
guard.Mode;      // the mode in force
guard.Engine;    // the underlying Engine
```

## Settings

Options in code are the Node middleware's, as properties of `McpWatchOptions`. What you leave out comes from the same `MCPWATCH_*` environment variables as the Node, Python and Java packages, read by the engine itself. **With a project key, the dashboard's settings win over both** and reach the guard within 5 seconds.

| Property | Environment | Default | Meaning |
|---|---|---|---|
| `ProjectKey` | `MCPWATCH_PROJECT_KEY` | none | Dashboard project key. Events go there, and the project's mode, AI choice and client lists apply live |
| `Server` | `MCPWATCH_SERVER` | `http://127.0.0.1:9100` | Dashboard URL |
| `Enabled` | `MCPWATCH_ENABLED=0` | `true` | `false` leaves the server untouched |
| `Mode` | `MCPWATCH_MODE` | `enforce` | `off`, `observe`, `protect`, `enforce` |
| `FailOpen` | | `false` | If the engine can't run: refuse requests with `-32001` (default), or pass messages unchecked |
| `DenyTools` | | none | Tools that may never be called (MW009) |
| `AllowTools` | | none | If set, only these may be called |
| `AllowedOrigins` | `MCPWATCH_ALLOWED_ORIGINS` | none | HTTP: web origins allowed to call the server (MW030) |
| `AllowedHosts` | `MCPWATCH_ALLOWED_HOSTS` | not checked | HTTP: host names the server answers to |
| `RequireAuth` | `MCPWATCH_REQUIRE_AUTH=1` | `false` | HTTP: refuse requests with no `Authorization` or `X-API-Key` (MW031) |
| `ExpectedAudience` | `MCPWATCH_AUDIENCE` | none | HTTP: refuse JWTs whose `aud` doesn't include this (MW036) |
| `WindowSeconds` | | `60` | Behaviour-rule window |
| `ThrottleAt` / `BlockAt` | | `3` / `6` | Session score at which calls are throttled / blocked |
| `MaxCallsPerWindow` | | `30` | Call flood threshold (MB001) |
| `MaxArgBytes` | | `100000` | Oversized arguments (MW008) |
| `MaxResultBytes` | | `5000000` | Oversized response, withheld (MW023) |
| `AiEnabled` / `Ai` | `MCPWATCH_AI=1` | off | AI reviewer; `Ai` takes `enabled`, `url`, `model`, `apiKey`, … |
| `BlockClients` / `AllowClients` | | none | Clients to block or always allow, overriding the rules in every mode |
| `EventsFile`, `PinsFile`, `RegistryFile` | `MCPWATCH_EVENTS`, … | `~/.mcpwatch/…` | Local event log, pinned tool definitions, shared registry |
| `EngineCommand` | `MCPWATCH_ENGINE` | `mcpwatch` on PATH, else `npx` | How to start the engine, e.g. `new[] { "node", @"C:\mcpwatch\engine\dist\cli.js" }` |
| `StartTimeout` | | 120 s | How long to wait for the engine to start |
| `CallTimeout` | | 60 s | How long to wait for one message to be checked |
| `Extra["name"] = value` | | | Any other engine option, by its own name |

### Connecting to the dashboard

1. Start the dashboard (`npx @vedhaai/mcpwatch-dashboard`) and open http://127.0.0.1:9100.
2. Create an account, click **New project**, and copy the project key.
3. Put it in `ProjectKey` or `MCPWATCH_PROJECT_KEY`.

Without a project key, events go to `~/.mcpwatch/events.jsonl` and show under **Local events** on the dashboard's Projects page.

### AI reviewer

```csharp
new McpWatchOptions { AiEnabled = true };    // local Ollama, qwen2.5:7b
new McpWatchOptions { Ai = new Dictionary<string, object> {
    ["enabled"] = true, ["url"] = "http://127.0.0.1:11434/v1", ["model"] = "qwen2.5:7b" } };
```

It can **add findings, never remove them**. With a project key, the project's **AI review** choice in the dashboard wins. Details in the [main README](https://github.com/vedhaai/MCP-Watch#ai-reviewer-local-model).

## What it detects

The full catalog is the engine's; run `mcpwatch rules` for it. See the [main README](https://github.com/vedhaai/MCP-Watch#readme).

## How it works

```
MCP client ──► your .NET server ───────────────────────────────────────────────┐
               McpWatchGuard                                                     │
                 │ each JSON-RPC message, one JSON line   ▲ forward / reply     │
                 ▼                                        │                     │
               mcpwatch engine (Node child process): rules, AI reviewer, ───────┼──► dashboard
               sessions, pins, registry, reporting                               │
                 allowed messages ──► your tools ───────────────────────────────┘
```

- **One engine per guarded server**, shared by every connection to it, started on first use or eagerly by `Engine.Start()` (`CreateIfEnabled` does this for you).
- **If the engine stops,** the next message starts it again, at most once every 10 seconds. Session scores start over.
- **If the engine can't be reached,** `FailOpen` decides, and the error is logged to stderr at most once a minute rather than per message.
- **If your process exits,** the engine sees its input close, sends its queued events and exits.

## Limits of this release

- **No wrapper for a specific SDK or web stack yet.** The official C# SDK (`ModelContextProtocol`) and ASP.NET (System.Web, OWIN, ASP.NET Core) have no ready-made adapter here, the way the Java package has one for the Java SDK and the servlet API. You wire the guard in where your server reads and writes messages, as shown above. The Python and Java adapters are the reference for what an HTTP adapter would add (transport rules MW030–MW036 need request headers).
- **JSON-RPC batches** (arrays) are refused with `-32600` by the line helpers. The current MCP specification does not allow them.
- **The transport rules** (origin, host, auth, token audience) only work if you pass the request headers in `http` to `FromClient`, which is up to the caller.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `could not start …: The system cannot find the file specified` | Node isn't installed, or the engine isn't on the PATH. Install it, or set `EngineCommand` / `MCPWATCH_ENGINE` |
| Every request is refused with `MCPWatch failed closed` | The engine can't start and `FailOpen` is off. The reason is on stderr |
| Nothing appears in the dashboard | No project key, or the dashboard isn't running. Without a key, events go to `~/.mcpwatch/events.jsonl` |
| Attacks get through | The project is in `observe` mode, the default for new dashboard projects. Switch to `enforce` on the Settings tab |
| A legitimate call is blocked | The Requests tab shows the rule and the evidence. Trust the client on the Clients tab, or allow the tool |

## Tests

```powershell
cd dotnet
dotnet test tests/Vedhaai.MCPWatch.Tests
```

The suite runs on **.NET Framework 4.8 and .NET 6**. It runs against the **real engine** built in this repository (`engine/dist/cli.js`), so it checks actual verdicts rather than a stand-in; build it first with `npm run build -w engine` in the repository root. Without it, the tests that need verdicts are skipped rather than failed. Running the `net48` target needs Windows.

| File | What it covers |
|---|---|
| `JsonTests` | The package's own JSON codec: round trips, id types, one-line output, lone surrogates, malformed and hostile input, the nesting limit |
| `EngineTests` | The sidecar protocol: real MW001/002/003/009 verdicts, tool stripping, withheld results, mode changes at runtime, `FailOpen` both ways, async and concurrent callers, option names, command quoting |
| `GuardTests` | Raw-line checks, message order per session, non-object lines |

## Publishing

Published by hand from a maintainer's machine, like the npm, PyPI and Maven packages. Only nuget.org's own account and key are needed.

**One time:** sign in at [nuget.org](https://www.nuget.org) (with two-factor authentication on), then **API Keys → Create** with scope *Push new packages and package versions* and glob `Vedhaai.MCPWatch*`. Copy the key when it is shown; it appears only once.

**Each release:**

```powershell
npm run build -w engine                 # in the repository root: the tests run against the real engine
cd dotnet
# bump <Version> in src/Vedhaai.MCPWatch/Vedhaai.MCPWatch.csproj
dotnet test tests/Vedhaai.MCPWatch.Tests
dotnet pack src/Vedhaai.MCPWatch -c Release -o dist
dotnet nuget push dist/Vedhaai.MCPWatch.<version>.nupkg --api-key <key> --source https://api.nuget.org/v3/index.json
```

`dist/` is git-ignored, like the other packages' build output. Keep the key out of your shell history by putting it in an environment variable rather than typing it in the command.

A published NuGet version is permanent (it can be unlisted, not removed), so bump `<Version>` in [the project file](src/Vedhaai.MCPWatch/Vedhaai.MCPWatch.csproj) for every release. After the push it takes about 5-15 minutes to appear in search.

## Licence

MIT, as the rest of MCP-Watch. See [LICENSE](LICENSE).
