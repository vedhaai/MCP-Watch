---
paths:
  - "backend/**"
---

# Backend rules

- Three layers: controllers (routes, auth, validation) -> services (logic) -> data (JSON files). Controllers never touch files; services never read the request object.
- Routes come from tsoa controllers. Never edit `src/generated/`; change the controller and rebuild.
- Every new route needs an explicit auth choice: project key for `/api/agent/*`, login cookie for `/api/*`.
- User-supplied URLs go through `services/safe-url.ts`. Stored secrets go through `data/secret-box.ts` and are never returned by the API or logged.
- Bind to 127.0.0.1 by default. Keep security headers and rate limits on login and agent routes.
- API shape changes must be mirrored in `frontend/src/types.ts` and `frontend/src/api.ts`.
- Tests: `backend/test/*.test.mjs`, run with `npm test -w backend`.
