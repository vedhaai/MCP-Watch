# Contributing to MCPWatch

Thanks for helping. The easiest and most useful contribution is a new or better detection rule.

## Set up

Needs Node 20+.

```
git clone https://github.com/vedhaai/MCP-Watch.git
cd MCP-Watch
npm install
npm run build
npm test
```

Tests are `*.test.mjs` files in each package's `test/` folder and run against built output, so build first. The Python, Java, Rust, .NET and Go packages have their own test commands; see the scripts table in the [README](README.md#run-it).

## Where changes go

- **Rules and detection:** `engine/`. The other language packages only move messages to the Node engine, so do not re-implement rules there.
- **Dashboard server:** `backend/` (controllers, then services, then data).
- **Dashboard web app:** `frontend/`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the parts fit together.

## Adding a rule

1. Add the rule in `engine/src/rules.ts` (or `patterns.ts` / `state.ts`) with its catalog entry and AI hint.
2. Add a test that shows it catches the attack and one that shows it leaves normal traffic alone.
3. Add it to the Rules section of the README.

Think about how an attacker would evade it (encoding, unicode, splitting across fields) and test one of those.

## Pull requests

- Branch from `develop`; open the PR against `main` unless a maintainer says otherwise.
- Keep commit messages to one short imperative sentence.
- Run `npm run build` and `npm test` before pushing.
- Use fake data only. Fake secrets in tests and docs must not look like real keys, or secret scanners will flag them. Never include customer data.

## Reporting security problems

Use the private process in [SECURITY.md](SECURITY.md), not a public issue.
