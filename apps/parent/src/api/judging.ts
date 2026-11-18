import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { Judging } from "../judging.ts";
import { type ApiEnv, newApi } from "./common.ts";

// Judging at a glance, for Home: whether it is set up, the workers seen,
// how many clips wait for a judge, and the disagreements. /api/v1/judging.

const Worker = z
  .object({
    name: z.string(),
    version: z.string(),
    judges: z.array(
      z.object({
        name: z.string(),
        version: z.string(),
        wakeWords: z.array(z.string()).nullable(),
      }),
    ),
    lastSeenAt: z.string(),
    /** Waiting for work now, or seen in the last two minutes. */
    connected: z.boolean(),
  })
  .openapi("Worker");

const Status = z
  .object({
    /** A worker token is configured, so workers can connect. */
    configured: z.boolean(),
    workers: z.array(Worker),
    /** Clips still missing a result from a judge that recent workers offer. */
    waiting: z.number().int(),
    /** Clips at least one judge has answered for. */
    judged: z.number().int(),
    disagree: z.number().int(),
    /** The device fired but the judges agree it was not the wake word. */
    falseWake: z.number().int(),
    /** A near miss the judges agree was the wake word. */
    missedWake: z.number().int(),
  })
  .openapi("JudgingStatus");

const status = createRoute({
  method: "get",
  path: "/judging",
  tags: ["judging"],
  summary: "Workers, clips waiting to be judged, and disagreement counts",
  responses: {
    200: { description: "Status", content: { "application/json": { schema: Status } } },
  },
});

export function judgingRoutes(judging: Judging, guard: MiddlewareHandler<ApiEnv>) {
  const app = newApi();
  app.use("/judging", guard);
  return app.openapi(status, (c) => c.json(judging.status(), 200));
}
