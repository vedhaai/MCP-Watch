---
name: release-check
description: Pre-release checklist for MCPWatch packages (npm engine and dashboard, PyPI, Maven). Use when preparing to publish or bump versions. It checks only; it never publishes.
---

# Release check

Never run `npm publish`, `twine upload` or `mvn deploy`. Report readiness and let the user publish.

1. **Versions**: compare `version` in `engine/package.json`, `backend/package.json`, `python/pyproject.toml` and `java/pom.xml` with the published ones (`npm view @vedhaai/mcpwatch version`, `npm view @vedhaai/mcpwatch-dashboard version`, PyPI and Maven Central). Each must be higher than what is published. Check the backend's dependency on the engine version too.
2. **Clean tree on the right branch**: `git status` clean; release PR goes `develop` -> `main`.
3. **Run the `verify` skill**: build and all tests, including Python and Java.
4. **Package contents**: `npm pack --dry-run -w engine` and `-w backend` must contain `dist/` (and `public/` for the backend) and no `secret.key`, `.env`, tests or source maps of secrets.
5. **Secrets scan**: grep the diff against `main` for key-like strings (`sk-`, `AKIA`, `ghp_`, private key headers). Fixtures must use fake values that scanners ignore.
6. **Docs**: README and ARCHITECTURE reflect new rules, options and modes. No customer PII anywhere.

Finish with a short go / no-go list.
