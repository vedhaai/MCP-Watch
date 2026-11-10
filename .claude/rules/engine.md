---
paths:
  - "engine/**"
---

# Engine rules

- The engine must not import anything from `backend/`, `frontend/`, `python/` or `java/`. It has to work with no dashboard.
- `Engine.fromClient` and `Engine.fromServer` stay async and ordered per direction. Never add a code path that lets a later message finish before an earlier one in the same direction.
- A rule's severity and points come from `src/catalog.ts`. Do not hard-code points in `rules.ts`.
- The AI reviewer can add findings but never remove one. If the model is down, the rules alone decide (unless MA002 "required" is set).
- A guard error follows `failOpen`, which defaults to refusing the request. Do not change that default.
- Snippets sent in events must be short and secret-redacted.
- Tests are `.mjs` files in `engine/test/` run with `node --test` against the compiled `dist/`. Use fake secrets that do not match real key formats.
