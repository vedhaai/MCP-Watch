---
paths:
  - "python/**"
  - "java/**"
  - "dotnet/**"
---

# Python, Java and .NET adapter rules

- Adapters only move messages to and from the Node engine (`mcpwatch engine`, one JSON line per message). Do not re-implement rules, scoring or policy here; change `engine/` instead.
- Keep message order per direction and per session (Python: promise-queue equivalent; Java and .NET: `Sequencer`).
- `fail_open` / `failOpen` decides what happens if the engine cannot start. Keep it configurable and documented.
- Java: no dependencies beyond SLF4J; MCP SDK, Reactor and servlet API stay `provided`. Keep the small built-in JSON codec; do not add Jackson.
- The Python and Java HTTP adapters are ports of `engine/src/http-proxy.ts`, as the Rust one in `rust/src/http/` is. When the proxy's behaviour changes, update all three.
- .NET: `netstandard2.0` with no package dependencies (keep the small built-in JSON codec; do not add Newtonsoft.Json or System.Text.Json). Logs go to stderr only, never stdout. Tests run on net48 and net6.0.
- Tests: `npm run test:python`, `npm run test:java` and `npm run test:dotnet`.
