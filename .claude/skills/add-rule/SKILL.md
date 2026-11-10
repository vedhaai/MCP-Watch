---
name: add-rule
description: Add or change an MCPWatch detection rule (MW, MB, MA or MS id) in the engine, with its catalog entry, AI hint, test and docs. Use when asked to detect a new attack or tune an existing rule.
---

# Add a detection rule

Rules live in the engine only. Python and Java adapters never re-implement them.

1. **Pick the id and group.** Ids are `MWnnn` (single message), `MBnnn` (session behaviour), `MAnnn` (AI reviewer), `MSnnn` (`mcpwatch scan`). Read the end of [engine/src/catalog.ts](../../../engine/src/catalog.ts) and use the next free number.
2. **Catalog entry** in `engine/src/catalog.ts`: `{ id, title, severity, points, group }`. Points: high = 5, medium = 2, low = 1 (MB002 uses 3).
3. **Detection**:
   - MW message rules: `engine/src/rules.ts` (patterns in `engine/src/patterns.ts`). Return findings via `finding("MWxxx", detail, where)`; keep snippets short and secret-redacted.
   - MB behaviour rules: `engine/src/state.ts`.
   - MS scan rules: `engine/src/scan.ts`.
4. **AI hint**: if the rule applies to model review, add a one-line description in the rule map in `engine/src/ai.ts` (next to the `MW001` entry).
5. **Test**: add a case to the closest file in `engine/test/` (`engine.test.mjs`, `security.test.mjs`, `gaps.test.mjs`, `transport.test.mjs`). Cover one attack that fires and one benign input that does not. Use obviously fake secrets that scanners will not flag.
6. **Docs**: update the rule list in [README.md](../../../README.md) and the rule count in [ARCHITECTURE.md](../../../ARCHITECTURE.md) (the diagram text says "38 rules").
7. **Verify**: run `npm test -w engine`. Also run `npm test -w backend` if the catalog shape changed, since the dashboard reads it.
