---
paths:
  - "python/**"
  - "java/**"
---

# Python and Java adapter rules

- Adapters only move messages to and from the Node engine (`mcpwatch engine`, one JSON line per message). Do not re-implement rules, scoring or policy here; change `engine/` instead.
- Keep message order per direction and per session (Python: promise-queue equivalent; Java: `Sequencer`).
- `fail_open` / `failOpen` decides what happens if the engine cannot start. Keep it configurable and documented.
- Java: no dependencies beyond SLF4J; MCP SDK, Reactor and servlet API stay `provided`. Keep the small built-in JSON codec; do not add Jackson.
- The Python and Java HTTP adapters are ports of `engine/src/http-proxy.ts`. When the proxy's behaviour changes, update both.
- Tests: `npm run test:python` and `npm run test:java`.
