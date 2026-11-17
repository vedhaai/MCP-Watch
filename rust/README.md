# MCPWatch for Rust

[![crates.io](https://img.shields.io/crates/v/mcpwatch.svg)](https://crates.io/crates/mcpwatch)

A guard inside your MCP server. It checks every JSON-RPC message in both
directions — tool calls going in, tool definitions and results coming back — for
prompt injection, tool poisoning, path traversal, command injection, SSRF,
leaked secrets and rug pulls, and refuses what it should.

Clients need no changes. It works with:

- the official Rust MCP SDK (**rmcp**), over stdio or any byte stream
- **axum**, and anything else that speaks **tower**
- **actix-web**
- a server you cannot change at all, through the `mcpwatch-proxy` binary

The checks are the same as for the Node, Python and Java packages, because they
are the same checks: this crate does not re-implement a single rule. It starts
the MCPWatch engine (**Node 20+**) as a child process and asks it about each
message, so a Rust server gets exactly the verdicts a Node one would.

## Install

```toml
[dependencies]
mcpwatch = "0.1"                                     # the tower/axum layer
mcpwatch = { version = "0.1", features = ["rmcp"] }  # the Rust SDK guard
```

```powershell
npm install -g @vedhaai/mcpwatch
```

Without that, the guard falls back to `npx -y @vedhaai/mcpwatch`, which works
but resolves the package on every cold start.

### Features

| Feature | Default | What it adds |
|---|---|---|
| `tower` | **yes** | `McpWatchLayer` for axum and any tower service |
| `rmcp` | no | `guard_stdio()` / `guard_io()` for the official Rust SDK |
| `actix` | no | `McpWatch` middleware for actix-web |
| `proxy` | no | the `mcpwatch-proxy` binary |
| `full` | no | all of the above |

`rmcp` is **off by default on purpose.** It has changed major version three
times in 73 releases, and a default-on dependency would put this crate's `rmcp`
beside yours the day the next major lands — two incompatible `Transport` traits
in one build, for people who never asked for the SDK guard. You opt in, so the
version coupling is yours to see. This is the same reasoning behind the Java
package scoping the MCP SDK as `provided`.

### Requirements

| | |
|---|---|
| Rust | 1.88+ |
| Node.js | 20+, for the engine |
| Dashboard | optional; without one, events go to `~/.mcpwatch/events.jsonl` |

Beyond `serde`, `serde_json`, `tokio` and the `log` facade, every dependency is
behind the feature that needs it. `log` is the counterpart of the Java package's
SLF4J: a facade with no implementation forced on the application it is injected
into.

## Official MCP SDK (stdio)

```rust
use mcpwatch::{McpWatch, McpWatchOptions};
use rmcp::ServiceExt;

let watch = McpWatch::start("my-tools", McpWatchOptions::new()).await;
let running = server.serve(watch.guard_stdio()).await?;   // the only line changed
running.waiting().await?;
```

`guard_io(read, write)` takes any `AsyncRead`/`AsyncWrite` pair if your transport
is not stdin and stdout.

This covers stdio and any byte-stream transport. For **Streamable HTTP**, use the
tower layer below instead: the request headers the transport rules MW030–MW036
need only exist there.

## axum, and anything that speaks tower

```rust
use axum::body::Body;
use mcpwatch::http::tower::McpWatchLayer;
use rmcp::transport::streamable_http_server::StreamableHttpService;

let mcp = StreamableHttpService::new(
    || Ok(MyServer::new()),
    Default::default(),
    Default::default(),
);

let guarded = tower::ServiceBuilder::new()
    .map_response(|r: http::Response<_>| r.map(Body::new))
    .layer(McpWatchLayer::from_watch(&watch))
    .service(mcp);

let app: axum::Router = axum::Router::new().nest_service("/mcp", guarded);
```

**Register the guard as the innermost layer.** A compression layer inside it
would hand the guard gzip bytes, which parse as neither JSON nor SSE, and the
body would pass through unchecked.

## actix-web

```rust
use actix_web::{App, web};
use mcpwatch::http::actix::McpWatch as McpWatchMiddleware;

App::new()
    .wrap(McpWatchMiddleware::from_watch(&watch))
    .route("/mcp", web::post().to(mcp_handler))
```

The same caveat applies: register it inside `middleware::Compress`, not outside.

## A server you cannot change

```powershell
cargo install mcpwatch --features proxy
mcpwatch-proxy --name my-tools -- node ./some-server.js
```

The proxy sits between the client's stdin/stdout and the server it starts.

**It does not remove the Node dependency.** The engine is still a Node sidecar,
exactly as for the Python and Java packages. What it buys is a launch with no
`npx` resolution on every cold start, and one artifact to sign and distribute
instead of an npm tree.

## Modes

| Mode | What happens |
|---|---|
| `off` | Everything passes, unchecked |
| `observe` | Checked and reported, never refused |
| `protect` | High-severity findings refused with `-32001` |
| `enforce` | Also throttles (`-32002`) at session score 3 and blocks at 6 |

`enforce` is the default. On the way back from the server the guard can only
withhold or clean a message, so `protect` and `enforce` act the same there.

## Settings

Options in code are the Node middleware's, on `McpWatchOptions::builder()`. What
you leave out comes from the same `MCPWATCH_*` environment variables as the
other packages, read by the engine itself. **With a project key, the dashboard's
settings win over both** and reach the guard within 5 seconds.

| Builder method | Environment | Default | Meaning |
|---|---|---|---|
| `project_key(..)` | `MCPWATCH_PROJECT_KEY` | — | Dashboard project key. Events go there, and the project's mode, AI choice and client lists apply live |
| `server(..)` | `MCPWATCH_SERVER` | `http://127.0.0.1:9100` | Dashboard URL |
| `enabled(bool)` | `MCPWATCH_ENABLED=0` | `true` | `false` leaves the server untouched |
| `mode(Mode)` | `MCPWATCH_MODE` | `enforce` | `Off`, `Observe`, `Protect`, `Enforce` |
| `fail_open(bool)` | | `false` | If the engine can't run: refuse requests with `-32001` (default), or pass messages unchecked |
| `deny_tools(..)` | | — | Tools that may never be called (MW009) |
| `allow_tools(..)` | | — | If set, only these may be called |
| `allowed_origins(..)` | `MCPWATCH_ALLOWED_ORIGINS` | — | HTTP: web origins allowed to call the server (MW030) |
| `allowed_hosts(..)` | `MCPWATCH_ALLOWED_HOSTS` | not checked | HTTP: host names the server answers to |
| `require_auth(bool)` | `MCPWATCH_REQUIRE_AUTH=1` | `false` | HTTP: refuse requests with no `Authorization` or `X-API-Key` (MW031) |
| `expected_audience(..)` | `MCPWATCH_AUDIENCE` | — | HTTP: refuse JWTs whose `aud` doesn't include this (MW036) |
| `window_seconds(u32)` | | `60` | Behaviour-rule window |
| `throttle_at(u32)` | | `3` | Session score at which calls are throttled |
| `block_at(u32)` | | `6` | Session score at which calls are blocked |
| `max_calls_per_window(u32)` | | `30` | Call flood threshold (MB001) |
| `max_arg_bytes(u64)` | | `100000` | Oversized arguments (MW008) |
| `max_result_bytes(u64)` | | `5000000` | Oversized response, withheld (MW023) |
| `ai(bool)` / `ai_settings(..)` | `MCPWATCH_AI=1` | off | AI reviewer |
| `clients(Clients)` | | — | Clients to block or always allow, overriding the rules in every mode |
| `events_file`, `pins_file`, `registry_file` | `MCPWATCH_EVENTS`, … | `~/.mcpwatch/…` | Local event log, pinned tool definitions, shared registry |
| `engine_command(..)` | `MCPWATCH_ENGINE` | `mcpwatch` on PATH, else `npx` | How to start the engine |
| `start_timeout(Duration)` | | 120 s | How long to wait for the engine to start |
| `call_timeout(Duration)` | | 60 s | How long to wait for one message to be checked |
| `channel_capacity(usize)` | | `64` | Messages queued per direction before the guard pushes back |
| `option(name, value)` | | | Any other engine option, by its own name |

A mistyped option is a **compile error** here, which the engine itself cannot
give you: it accepts unknown keys silently. Use `option(..)` deliberately for an
engine setting newer than this crate.

### Connecting to the dashboard

```rust
let watch = McpWatch::start(
    "my-tools",
    McpWatchOptions::builder().project_key("mw_…").build(),
).await;
```

Without a key the guard still works; events go to `~/.mcpwatch/events.jsonl`.

## How it works

```
your server
├── watch.guard_stdio()        rmcp transport      (stdio, any byte stream)
├── McpWatchLayer              tower / axum        (Streamable HTTP, SSE)
├── McpWatch middleware        actix-web
└── mcpwatch-proxy             a server you can't change
          │
          ▼
   mcpwatch engine (Node)  ──►  38 rules, AI reviewer, dashboard
```

- **One engine per guarded server**, shared by every connection to it, started
  as a child process and spoken to in newline-delimited JSON.
- **Order is kept per direction.** The engine answers each message as soon as it
  is checked, so answers genuinely arrive out of order; calls are matched by id,
  and each direction is checked strictly in sequence. A `tools/list` judged
  before its own `initialize` would be judged without the session state it
  depends on.
- **Checks never fail outwards.** If the engine cannot be reached, `fail_open`
  decides: refuse requests with `-32001` (the default), or pass them unchecked.
  A notification is always passed, because nothing can be answered to one.
- **The SDK guard owns its framing**, so a message the engine rewrote — a tool
  stripped from `tools/list`, a redacted secret — reaches the wire exactly as the
  engine wrote it, rather than being rebuilt through a typed model with nowhere
  to put a field it does not know.

## Limits

- **Node is required.** This crate is an adapter, not a port. No Node, no checks.
- **The SDK guard covers stdio and byte streams.** Streamable HTTP is guarded by
  the tower layer, where the headers the transport rules need still exist.
- **The HTTP adapters cannot answer the server.** When the guard refuses a
  request the *server* sent (`sampling/createMessage`, `elicitation/create`),
  there is no channel back to it from inside a response filter: the message is
  dropped and logged, and the server sees it time out. A server that sends those
  should be guarded at its transport instead. The SDK guard answers properly.
- **Register the guard innermost**, inside any compression middleware.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Node.js 20+ is needed` | Install Node, then `npm install -g @vedhaai/mcpwatch` |
| Every request refused with `-32001` | The engine isn't starting. Its own errors go to stderr; `MCPWATCH_ENGINE` can point at a known path |
| The guard seems to do nothing | `MCPWATCH_ENABLED=0` is set, or the mode is `off`, or the layer is mounted on a path it doesn't match |
| A body passes unchecked | A compression layer is registered inside the guard; move it outside |
| The first message is slow | The engine is starting, and `npx` may be fetching it. Install it globally |

## Publishing

Releases are cut by hand from a maintainer's machine, as the npm, PyPI and Maven
ones are.

```powershell
./check.sh                              # format, clippy, tests, docs, features, MSRV, Windows
cargo package --list --features full
cargo publish --dry-run --features full
cargo publish
```

Read the `--list` output: confirm `README.md` and `LICENSE` are in it, and that
`tests/` and `target/` are not. `cargo publish --dry-run` builds from the
packaged tarball rather than the working tree, so a module excluded by `include`
fails there and nowhere else.

**A published version is immutable.** It can be yanked — which stops new
resolutions picking it while leaving existing `Cargo.lock` files working — but it
can never be edited, replaced or removed. A bad release is fixed by yanking and
shipping a patch. The version must stay above whatever is already on crates.io;
check with `cargo search mcpwatch`.

Publishing needs a crates.io API token. Keep it on the maintainer's machine.

## Tests

```powershell
npm run build -w engine   # from the repository root, once
cd rust
cargo test --features full
./check.sh                # everything a CI job would check, including MSRV and Windows
```

94 tests. Most run against a stub and need neither Node nor a built engine; the
rest run against the **real engine** from this checkout, never `npx`, so no test
can reach the network. If `engine/dist/cli.js` is missing those fail with a
message telling you to build it — `MCPWATCH_SKIP_ENGINE_TESTS=1` turns that into
a visible skip. A suite that passes without checking anything would be worse than
one that fails.

| File | What it covers |
|---|---|
| `src/` unit tests | Option encoding, engine-command resolution, fail-open and fail-closed, SSE boundary scanning, UTF-8 across chunks |
| `tests/engine_real.rs` | Verdicts from the real engine: MW001, MW002, MW009, MW030, tool stripping, out-of-order answers under load, runtime mode changes |
| `tests/sdk_guard.rs` | The rmcp transport guard over a real byte pipe |
| `tests/http_guard.rs` | Batches, refusals, session naming, SSE framing — against a stub |
| `tests/tower_layer.rs` | A real axum server over a real socket, including that SSE still streams |
| `tests/actix_middleware.rs` | The same cases through actix-web |
| `tests/proxy.rs` | The `mcpwatch-proxy` binary against a real child server |
| `tests/readme_api.rs` | That every builder method this README documents actually exists |

## Licence

MIT. See [LICENSE](LICENSE).
