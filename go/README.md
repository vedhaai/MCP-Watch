# MCPWatch for Go

[![Go Reference](https://pkg.go.dev/badge/github.com/vedhaai/MCP-Watch/go.svg)](https://pkg.go.dev/github.com/vedhaai/MCP-Watch/go)

Security guard for MCP servers written in Go. It checks every JSON-RPC message between any
MCP client and your server, in both directions, for prompt injection, tool poisoning, path
traversal, command injection, SSRF, leaked secrets and rug pulls.

Four ways in:

- **`net/http` middleware** — one `func(http.Handler) http.Handler`, so it fits the standard
  library, chi, gorilla/mux, echo and anything else that takes a handler.
- **The official Go SDK** (`modelcontextprotocol/go-sdk`) — one line at the transport.
- **`mark3labs/mcp-go`** — in place of `server.ServeStdio`, or around its HTTP handler.
- **`mcpwatch-proxy`** — for a server you cannot change.

This module **re-implements no rules**. The checks run in the MCPWatch engine, a Node 20+
process started as a child, so a Go server gets exactly the verdicts a Node, Python, Java,
Rust or .NET one would.

## Install

```bash
go get github.com/vedhaai/MCP-Watch/go
```

The import path has capitals in it, and Go is case-sensitive about module paths even though
GitHub is not about URLs. `go get github.com/vedhaai/mcp-watch/go` clones successfully and
then fails with *"module declares its path as …/MCP-Watch/go"*. Copy the path as written.

The engine needs Node 20+. The module starts it for you — the first start resolves it with
`npx`, which downloads it. To skip that, install it once:

```bash
npm install -g @vedhaai/mcpwatch
```

## Modules

Three, split by what they depend on. The core is **standard library only**: `go list -m all`
for a consumer who uses just the middleware prints one line, theirs.

| Module | What it adds | Minimum Go |
|---|---|---|
| `github.com/vedhaai/MCP-Watch/go` | the engine client, the `net/http` middleware, `mcpwatch-proxy` | 1.23 |
| `github.com/vedhaai/MCP-Watch/go/mcpsdk` | the official Go SDK | 1.25 |
| `github.com/vedhaai/MCP-Watch/go/mcpgo` | `mark3labs/mcp-go` | 1.25.5 |

Go has no equivalent of Cargo's optional features: a `require` lands in every consumer's
module graph, and `go mod tidy` would raise the minimum Go for everybody to whatever the
SDKs demand. Separate modules are how that is avoided. It is the same reasoning that keeps
the Rust crate's `rmcp` support behind a feature and the Java package's MCP SDK `provided`.

## An HTTP server

```go
watch := mcpwatch.Start(ctx, "my-tools", mcpwatch.Options{})
defer watch.Close()

mux := http.NewServeMux()
mux.Handle("/mcp", nethttp.Middleware(watch.Verdicts(), nethttp.Paths("/mcp"))(mcpHandler))
```

Register it **innermost**, inside any compression middleware. Outside one it is handed gzip
bytes and finds nothing in them.

This is the one adapter that also sees `GET` and `DELETE`, the request headers and the SSE
body, so it is the only one that can raise the MW030–MW037 transport rules. Prefer it for
any HTTP server, whichever SDK is underneath.

## The official Go SDK

```go
watch := mcpwatch.Start(ctx, "my-tools", mcpwatch.Options{})
defer watch.Close()

transport, done := mcpsdk.GuardStdio(ctx, watch)   // the only line changed
defer done()
session, err := server.Connect(ctx, transport, nil)
```

## mark3labs/mcp-go

```go
if err := mcpgo.ServeStdio(ctx, watch, s); err != nil {   // in place of server.ServeStdio
    log.Fatal(err)
}

// or, for StreamableHTTPServer / SSEServer:
http.Handle("/mcp", mcpgo.Handler(watch, httpServer))
```

## A server you cannot change

```bash
go install github.com/vedhaai/MCP-Watch/go/cmd/mcpwatch-proxy@latest
mcpwatch-proxy --name my-tools -- node ./some-server.js
```

This does not remove the Node dependency — the checks still run in the engine. What it buys
is a guard for a server whose code you do not own.

## Modes

| Mode | What it does |
|---|---|
| `off` | Pass everything through, record nothing. |
| `observe` | Never block. Record what enforce would have done. |
| `protect` | Block high-severity findings only. |
| `enforce` | Block high-severity findings, then throttle by session score. Default. |

## Settings

`mcpwatch.Options` is a plain struct whose fields map to the engine's own options, so a
mistyped setting is a compile error rather than a key the engine silently ignores. Anything
with no field yet goes through `Extra` by the engine's own name.

| Field | Environment | Default | Meaning |
|---|---|---|---|
| `Mode` | `MCPWATCH_MODE` | `enforce` | how hard to push back |
| `ProjectKey` | `MCPWATCH_PROJECT_KEY` | none | report to a dashboard project |
| `Server` | `MCPWATCH_SERVER` | `http://127.0.0.1:9100` | dashboard URL |
| `FailOpen` | — | `false` | what happens when the engine cannot be reached |
| `Enabled` | `MCPWATCH_ENABLED=0` | on | switch the guard off entirely |
| `EngineCommand` | `MCPWATCH_ENGINE` | resolved | how to start the engine |
| `DenyTools` / `AllowTools` | — | none | tool policy |
| `AllowedOrigins` / `AllowedHosts` | `MCPWATCH_ALLOWED_ORIGINS` | none | transport policy |
| `StartTimeout` | — | 120s | see below |
| `CallTimeout` | — | 60s | one check |

**`StartTimeout` is 120 seconds on purpose.** A local engine completes its handshake in
about 60 milliseconds. The long default is for the cold path, where the command resolves to
`npx -y @vedhaai/mcpwatch` and the first run downloads the package. Shortening it breaks
first starts on a clean machine and nothing else.

### Connecting to the dashboard

```go
watch := mcpwatch.Start(ctx, "my-tools", mcpwatch.Options{
    ProjectKey: os.Getenv("MCPWATCH_PROJECT_KEY"),
})
```

Read the key from the environment or a key file. A key passed on a command line is visible
in process listings to every user on the machine; this module never puts one in the engine's
argv for the same reason.

**A project key hands the dashboard authority over this guard.** Within about five seconds
the project's mode, origins, deny-list and thresholds replace whatever is set in code, and
nothing is logged when they do. A new project starts in `observe`, which blocks nothing — so
a server that sets `ModeEnforce` and then watches an attack sail through is almost always a
project that has not been switched out of `observe`. Without a key, events go to
`~/.mcpwatch/events.jsonl`.

## Limits

- **Node is required.** This module is a thin adapter; the engine is the Node one. Each check
  is a round trip over a local pipe, about 0.3 ms without AI review.
- **Nothing here writes to `os.Stdout`.** On a stdio server stdout *is* the protocol, and one
  stray line disconnects the client with a parse error that points nowhere. Your own code has
  the same constraint: `slog.NewJSONHandler(os.Stdout, …)` will break a stdio MCP server
  whether or not MCPWatch is present.
- **An HTTP response is one-way.** A refused *server→client* request (sampling, elicitation)
  can only be dropped there. Use the stdio adapters if your server sends those.
- **Register the HTTP middleware innermost**, inside any compression.
- **One guard per process.** The engine's pipes cannot be shared across a fork; a process
  that forks and re-executes must start its own.

## Tests

```bash
npm run build -w engine        # from the repo root; the suite uses this build, never npx
npm run test:go
cd go && ./check.sh            # the full gate
```

Tests split in two. Most of the module is framing rather than judgement — batches, SSE
boundaries, content lengths, session naming — and those run against a stub, needing no Node
and no engine build. The verdict tests drive this checkout's `engine/dist/cli.js` directly
and skip, with a message, when it has not been built.

## Releasing

Go has no publish command. **Pushing the tag is the release**, and a version is permanent:
`proxy.golang.org` serves the zip and `sum.golang.org` records its hash, both append-only.
There is no unpublish, no edit, and moving a tag afterwards does not ship the new code — it
gives everyone who already fetched a checksum mismatch, which reads like an attack. A bad
version can only be `retract`ed, and a retraction itself needs a later release to carry it.

The tag **must** carry the directory prefix, because the module lives in a subdirectory:

```
go/v0.1.0          not v0.1.0, and not go-v0.1.0
go/mcpsdk/v0.1.0
go/mcpgo/v0.1.0
```

That breaks this repository's `<name>-v<version>` convention. It is the Go toolchain's rule,
not a choice: a bare `v0.1.0` would name the repository root as a module, and `go-v0.1.0`
matches no version pattern at all and is simply ignored.

```bash
# The real dry run: build from what git has, not from your working tree. This is the only
# thing that catches a file you forgot to `git add` - it compiles here and is missing for
# everyone else.
tmp=$(mktemp -d); git archive HEAD go/ | tar -x -C "$tmp"
cd "$tmp/go" && GOWORK=off ./check.sh

git status --porcelain                      # must be empty
git tag -a go/v0.1.0 -m "Go package v0.1.0"
git push origin go/v0.1.0                   # one tag, by name, never --tags

# Make the version exist, then prove a consumer can resolve it.
GOPROXY=proxy.golang.org go list -m github.com/vedhaai/MCP-Watch/go@v0.1.0
```

The two SDK modules `require` the core, so they are tagged **after** it is on the proxy, with
their `require` lines pointing at the published version and no `replace` left behind — a
`replace` in a tagged `go.mod` is silently ignored by consumers, so the real `require` is
what they get, and if that names an unpublished version the release is dead on arrival.

## Licence

MIT. See [LICENSE](LICENSE).
