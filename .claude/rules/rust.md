---
paths:
  - "rust/**"
---

# Rust adapter rules

- The adapter only moves messages to and from the Node engine (`mcpwatch engine`, one JSON line per message). Do not re-implement rules, scoring or policy here; change `engine/` instead.
- The engine answers each message as soon as it is checked, so answers arrive **out of order**. Match by `id`, never by arrival. Each spawned child gets its own pending map, so a dead engine can only fail the calls made to it.
- Keep message order per direction and per session. Head-of-line blocking in a direction is the guarantee, not a bug.
- `fail_open` decides what happens if the engine cannot start. Keep it configurable and documented. Fail-closed refuses **requests** only: a notification has nothing to answer.
- Keep the dependency surface minimal — this crate is injected into someone else's server. `serde`, `serde_json`, `tokio` and the `log` facade are the only unconditional dependencies; everything else sits behind the feature that needs it.
- `rmcp` stays **off by default**: it has changed major version three times in 73 releases, and a default-on dependency would put our `rmcp` beside the host's.
- `rust-version` is the minimum a consumer needs, not what we build with. Raise it only when the code actually requires it, and check by building with that toolchain.
- `src/http/` is a port of `engine/src/http-proxy.ts`, like Python's and Java's. When the proxy's behaviour changes, update all three. The tower and actix adapters share it: put logic in the core, not in either adapter.
- Builder methods must reach the thing they configure. Build the `HttpGuard` when the layer is applied, not when it is constructed — a setting that silently does nothing is the worst way for a security option to be wrong.
- Tests: `npm run test:rust`. They run against this checkout's `engine/dist/cli.js`, never `npx`, so nothing reaches the network. Prefer a stub (`Verdicts`) where the behaviour under test is framing rather than a verdict.
- Never run `cargo publish`; prepare the release and hand it over.
