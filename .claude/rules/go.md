---
paths:
  - "go/**"
---

# Go adapter rules

- The adapter only moves messages to and from the Node engine (`mcpwatch engine`, one JSON line per message). Do not re-implement rules, scoring or policy here; change `engine/` instead.
- The engine answers each message as soon as it is checked, so answers arrive **out of order**. Match by `id`, never by arrival. Each spawned child gets its own pending map, so a dead engine can only fail the calls made to it.
- **Messages are `json.RawMessage`, never `map[string]any`.** `encoding/json` decodes every number into a `float64` under an interface, which corrupts a JSON-RPC id above 2^53 and reorders keys on the way out. Peek at single fields with a typed struct whose id field is itself raw.
- **The engine's echo of a message is not the message.** Node holds every number as a float64, so an unchanged message can come back with a different id. Forward the caller's own bytes; re-serialise only a genuine rewrite, and splice the original id back into it.
- **Omit, never null.** The engine tests `!== undefined`, so an absent key and a JSON null mean opposite things. Every optional field on `HTTPInfo` is a pointer with `omitempty`, the whole `http` object is absent for stdio, and a test asserts the serialised *bytes*. A `"remoteAddress": null` turns MW037 on for a guard that reports no event ids, and every stream resumption is then refused.
- **A `json.RawMessage` field is populated for a JSON null**, with the four-byte literal, not left nil. The engine sends `"reply":null` on every message it allows, so `len(reply) > 0` is true for all of them. Normalise a null to nil before testing it.
- Keep message order per direction and per session. Head-of-line blocking in a direction is the guarantee, not a bug.
- `FailOpen` decides what happens if the engine cannot start. Fail-closed refuses **requests** only: a notification has no id and a response has no method, so neither has anywhere to put a refusal.
- **The core module depends on nothing outside the standard library, and `check.sh` enforces it.** Go has no feature flags: a `require` lands in every consumer's module graph and raises their minimum Go. The SDK adapters are separate modules for exactly that reason. Never add a dependency to `go/go.mod`.
- Lower-case every header name; the engine folds nothing. Go's `http.Header` is canonical-cased, and **`Host` is not in it at all** — net/http moves it to `r.Host`, and MW030, MW034 and MW035 all read it.
- Options must reach the thing they configure. Build the `httpguard.Guard` when the middleware is applied, not when it is constructed — a security setting that silently does nothing is the worst way for one to be wrong.
- **Never write to `os.Stdout`.** On a stdio MCP server stdout is the protocol stream. All logging goes to stderr.
- `go/httpguard` is a port of `engine/src/http-proxy.ts`, like Python's, Java's and Rust's. When the proxy's behaviour changes, update all of them.
- Tests: `npm run test:go`. They run against this checkout's `engine/dist/cli.js`, never `npx`, so nothing reaches the network or a developer's real dashboard. Prefer the stub `Verdicts` where the behaviour under test is framing rather than a verdict.
- **Never push a `go/v*` tag.** Pushing the tag *is* the release, and a Go module version is permanent: there is no unpublish and no edit, and moving the tag gives everyone who already fetched a checksum mismatch. Prepare the release, run `./check.sh` from a `git archive` export, and hand the command over.
