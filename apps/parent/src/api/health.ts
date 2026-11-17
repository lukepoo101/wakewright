import type { Database } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { schemaVersion } from "../db/db.ts";
import { migrations } from "../db/migrate.ts";
import { version } from "../version.ts";

const Health = z.object({ status: z.literal("ok"), version: z.string() }).openapi("Health");

const Ready = z
  .object({ status: z.literal("ready"), schemaVersion: z.number().int() })
  .openapi("Ready");

const NotReady = z
  .object({ status: z.literal("not_ready"), reason: z.string() })
  .openapi("NotReady");

const healthz = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["health"],
  summary: "Liveness: the process is running",
  responses: {
    200: { description: "Alive", content: { "application/json": { schema: Health } } },
  },
});

const readyz = createRoute({
  method: "get",
  path: "/readyz",
  tags: ["health"],
  summary: "Readiness: the database is migrated and writable",
  responses: {
    200: { description: "Ready", content: { "application/json": { schema: Ready } } },
    503: { description: "Not ready", content: { "application/json": { schema: NotReady } } },
  },
});

export function healthRoutes(db: Database) {
  const latest = migrations.at(-1)?.version ?? 0;
  return new OpenAPIHono()
    .openapi(healthz, (c) => c.json({ status: "ok" as const, version }, 200))
    .openapi(readyz, (c) => {
      try {
        const current = schemaVersion(db);
        if (current !== latest) {
          return c.json(
            { status: "not_ready" as const, reason: `schema ${current}, expected ${latest}` },
            503,
          );
        }
        // Taking and releasing the write lock proves the DB is writable.
        db.run("BEGIN IMMEDIATE");
        db.run("ROLLBACK");
        return c.json({ status: "ready" as const, schemaVersion: current }, 200);
      } catch (error) {
        return c.json({ status: "not_ready" as const, reason: (error as Error).message }, 503);
      }
    });
}
