# CLAUDE.md

Project context for Claude Code. Keep it short; deeper detail lives in [README.md](../README.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

## Claude config in this folder

- `settings.json`: shared permissions plus hooks.
- `hooks/guard-edits.mjs`: blocks edits to generated or secret files (`generated/`, `public/`, `dist/`, `secret.key`, `.env*`, lockfile).
- `hooks/guard-bash.mjs`: blocks force-push, push to `main`, `--no-verify`, hard reset and publish commands.
- `hooks/typecheck.mjs`: runs `tsc --noEmit` on the package after you edit a `.ts`/`.tsx` file.
- `skills/`: `add-rule`, `verify`, `release-check`, `security-hardening-review`.

## What this is

**MCPWatch** is a security guard for MCP servers (by vedhaai). It checks every JSON-RPC message between any MCP client and a server, in both directions, using rules (MW/MB/MA ids), session behaviour tracking and an optional local AI reviewer (Ollama by default). A dashboard shows projects, keys, requests, clients and settings. It is modelled on Headerwatch for APIs and uses the same agent API.

Repo: https://github.com/vedhaai/MCP-Watch · License: MIT · Node >= 20.

## Layout (npm workspaces: engine, frontend, backend)

| Folder | Package | Role |
|---|---|---|
| `engine/` | `@vedhaai/mcpwatch` | The guard: middleware, stdio/HTTP proxies, rules, AI reviewer, scanner, `mcpwatch` CLI. Depends on nothing else in the repo. |
| `backend/` | `@vedhaai/mcpwatch-dashboard` | Dashboard server (Express + tsoa, 127.0.0.1:9100). Layers: controllers -> services -> data (JSON files in `~/.mcpwatch/server/`). Depends on the engine's public exports. |
| `frontend/` | private | Dashboard web app (React, TypeScript, MUI, Vite). Builds into `backend/public/`. |
| `python/` | `vedhaai-mcpwatch` (PyPI) | Python adapter; spawns `mcpwatch engine` as a child process. |
| `java/` | `ai.vedha:mcpwatch` (Maven) | Java adapter (MCP Java SDK, servlet filter); also spawns the engine. |
| `docs/` | | `architecture.svg` |

Key engine files: `engine.ts` (`fromClient` / `fromServer`), `rules.ts`, `state.ts`, `ai.ts`, `policy.ts`, `pins.ts`, `scan.ts`, `middleware.ts`, `stdio-proxy.ts`, `http-proxy.ts`, `engine-server.ts`, `headerwatch.ts`/`events.ts` (reporting).
Key backend files: `app.ts`, `controllers/`, `services/`, `data/` (including `secret-box.ts`), `http/` (auth, rate limit, security headers), `services/safe-url.ts`.

## Commands (run from repo root)

```
npm install
npm run build          # engine, then frontend, then backend
npm start              # dashboard on :9100 from last build
npm run dev            # all three in watch mode; open http://localhost:5173
npm test               # engine + backend tests
npm run test:python    # cd python && pytest
npm run test:java      # cd java && mvn -B test (Java 17+)
npm run scan | rules | ai | pins:reset
```

One package: `npm test -w engine`, `npm run build -w backend`, etc. Tests are `*.test.mjs` in each package's `test/` folder and run against built output, so build first.

## Conventions and gotchas

- Engine never depends on the dashboard. A guard must keep working if the dashboard is down (events fall back to `~/.mcpwatch/events.jsonl`).
- Python and Java do not re-implement rules; they only move messages to the Node engine. Change rule behaviour in `engine/`, not in the adapters.
- `Engine.fromClient`/`fromServer` are async (AI reviewer). Wrappers keep a per-direction promise queue so messages never overtake each other; preserve this.
- Verdicts: `-32001` blocked, `-32002` throttled. Modes: `observe`, `protect`, `enforce`. User block/trust lists override mode.
- Fail-open: Python/Java adapters pass messages unchecked if the engine can't start (configurable); the Node engine's `failOpen` defaults to refusing.
- Generated or ignored, never commit: `backend/src/generated/` (tsoa output), `backend/public/` (frontend build), `dist/`, `secret.key` (dashboard encryption key), `.env*`, Java `target/`, Python venvs and caches.
- Fake secrets in tests/docs must not look like real keys (they trigger secret scanners); see commit 3ee2a88.
- Dashboard binds to 127.0.0.1; secrets are stored encrypted (`secret-box.ts`); outbound URLs go through `safe-url.ts`. Keep these hardening properties when changing the backend.
- Package versions are managed per package and must stay above published versions (see sync-main-versions merge).
- Keep user-facing README/ARCHITECTURE in sync when adding rules, options or modes.

## Git workflow

- Default/PR target branch: `main`. Day-to-day work happens on `develop`; feature branches (e.g. `engine-security`) merge via PRs.
- Commit message style: short imperative sentence, e.g. "Harden the engine, dashboard link and stored secrets".

## Current state (as of 2026-11-10)

- Branch `develop`, working tree clean, latest merge is PR #14 (engine-security: engine, dashboard link and stored-secrets hardening).
- Engine version 0.3.1. Status is labelled POC in the README.
- Never include customer PII in code, docs, fixtures or commit messages (organization policy).
