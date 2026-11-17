import type { Database } from "bun:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { version } from "../version.ts";
import { healthRoutes } from "./health.ts";

// The parent's HTTP API. Each area is a sub-app in its own file, mounted
// here with `.route()` so that AppType carries every route's types to the
// SPA's typed client (`hc<AppType>`). Planned for v0.0.1: session.ts
// (login), devices.ts and clips.ts under /api/ui.
export function createApi(deps: { db: Database }) {
  const app = new OpenAPIHono().route("/", healthRoutes(deps.db));

  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Wakewright", version },
  });

  // Unknown API paths answer JSON, never the SPA's index.html.
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  return app;
}

export type AppType = ReturnType<typeof createApi>;
