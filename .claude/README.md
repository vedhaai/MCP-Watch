# .claude folder

Shared Claude Code setup for MCPWatch. Commit everything here except `settings.local.json` (personal, git-ignored).

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Project context loaded every session |
| `settings.json` | Shared permissions and hook wiring |
| `rules/` | Path-scoped guidance (engine, backend, frontend, python-java), loaded when matching files are touched |
| `hooks/` | Node scripts run by hooks: block edits to generated or secret files, block risky git and publish commands, typecheck after edits |
| `skills/` | Workflows: `add-rule`, `verify`, `release-check`, `security-hardening-review` |
| `agents/` | Subagents: `rule-reviewer`, `test-writer` |

Hooks need Node 20+ (already required by the repo) and use `$CLAUDE_PROJECT_DIR`, so they work from any folder.
