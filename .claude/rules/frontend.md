---
paths:
  - "frontend/**"
---

# Frontend rules

- React + TypeScript + MUI. Shared pieces live in `src/components/ui.tsx` and `Shell.tsx`; reuse them before adding new ones.
- Support System, Light and Dark themes through `src/theme.ts`. Do not hard-code colours.
- All API calls go through `src/api.ts`; types live in `src/types.ts`.
- Never render stored secrets; show only that one is set.
- The build goes to `backend/public/` (git-ignored). Do not commit it.
- Dev server on :5173 proxies `/api` to the dashboard on :9100.
