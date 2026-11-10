---
name: verify
description: Build and run all MCPWatch tests (engine, backend, optionally Python and Java) and report results. Use before committing, before opening a PR, or when asked "does it still work?".
---

# Verify the repo

Run from the repo root, in this order, and stop at the first failure to diagnose it:

1. `npm run build` (engine, then frontend, then backend; backend needs the engine build and generates tsoa routes)
2. `npm test` (engine tests, then backend tests; both compile first)
3. Only if `python/` changed: `npm run test:python`
4. Only if `java/` changed: `npm run test:java` (needs Java 17+ and Maven)

Report per step: passed or failed, with the failing test names and the first error. If a step was skipped, say why. Do not claim success for steps that did not run. Do not edit tests to make them pass without telling the user.
