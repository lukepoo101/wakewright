# 0004 Hono API with a React SPA

- Status: accepted
- Date: 2026-11-17

## Context

The parent needs a versioned, documented API (for the UI now, for workers
later), long-polling, ranged downloads and background loops that start
exactly once. The UI sits behind a login, so server rendering buys nothing.

## Decision

- **Hono 4** on `Bun.serve`, with **zod 4** and **`@hono/zod-openapi`**:
  every route is validated by zod and described in the OpenAPI 3.1 document
  served at `/api/openapi.json`. Runner-up: Elysia (smaller community, more
  magic).
- A **React 19 SPA** in `apps/web`, routed by TanStack Router (code-based
  routes) with TanStack Query for server state, styled with CSS Modules on
  shared custom properties. Its API client is `hc<AppType>()`, typed from
  the server's routes with no code generation.
- In production the server serves the SPA's static build (`bun build`) from
  the same origin. In development `dev.ts` imports `index.html` through Bun's
  HTML import for hot reloading, with no separate dev server or proxy.

Full-stack frameworks (Next.js, TanStack Start and similar) were rejected:
they optimise for server rendering, have no first-class OpenAPI and give no
obvious home for a loop that must run once.

## Consequences

API areas are sub-apps mounted with `.route()` so `AppType` carries their
types. Bun's full-stack bundle emits relative asset URLs, so the SPA is
built separately with `--public-path=/`.
