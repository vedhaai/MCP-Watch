---
name: security-hardening-review
description: Review a change to the MCPWatch dashboard backend or engine against the project's hardening properties (loopback bind, encrypted secrets, SSRF-safe URLs, auth, rate limits, fail behaviour). Use on any diff touching backend/ or engine/.
---

# Hardening review

This is a security product, so check the diff against these properties and flag any regression:

- **Dashboard binds to 127.0.0.1** by default; no wildcard CORS; security headers from `backend/src/http/security-headers.ts` stay applied.
- **Auth**: `/api/agent/*` needs the project key, `/api/*` needs the login cookie (`http/authentication.ts`, `session-cookie.ts`). No new route without an auth decision. Login and agent routes stay rate-limited (`http/rate-limit.ts`).
- **Stored secrets** (AI API keys etc.) go through `data/secret-box.ts`; never written or logged in plaintext; never returned by the API.
- **Outbound URLs** supplied by users (AI endpoint, webhooks) go through `services/safe-url.ts`; no direct `fetch` of user input.
- **Input validation** through tsoa models; no unchecked `JSON.parse` of request data into storage; file paths never built from request input (`data/json-files.ts`).
- **Engine failure modes**: Node engine `failOpen` defaults to refusing; adapters' `fail_open` / `failOpen` stays configurable and documented. A guard error must never crash the host server.
- **Message ordering**: per-direction promise queue preserved so a slow AI review cannot let a later message overtake an earlier one.
- **Logging and events**: snippets stay short and secret-redacted; no PII or full tool results in events.
- **Tests**: a security change needs a test in `engine/test/security.test.mjs` or `backend/test/`.

Output: a list of findings with file and line, severity, and a concrete fix; or "no regressions found" with the properties you actually checked.
