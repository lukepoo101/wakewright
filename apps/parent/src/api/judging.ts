import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { Judging } from "../judging.ts";
import { type ApiEnv, newApi } from "./common.ts";
import { WorkerSchema } from "./workers.ts";

// Judging at a glance, for Home: the workers and whether they are
// connected, how many clips wait for a judge, and the weighted outcomes.
// /api/v1/judging.

const Status = z
  .object({
    /** Every worker, declared ones first, with whether it is connected. */
    workers: z.array(WorkerSchema),
    /** Clips still missing a result from a judge that recent, enabled workers may run. */
    waiting: z.number().int(),
    /** The outcome rule in force. */
    rule: z.object({ margin: z.number(), minimum: z.number() }),
    /** Clips with an outcome other than waiting. */
    judged: z.number().int(),
    yes: z.number().int(),
    no: z.number().int(),
    uncertain: z.number().int(),
    notEnough: z.number().int(),
    /** Clips whose outcome waits for a judge (or that no judge has answered). */
    pending: z.number().int(),
    /** A counted judge voted against the clip's outcome. */
    dissent: z.number().int(),
    /** The device fired but the outcome is no. */
    falseWake: z.number().int(),
    /** A near miss the outcome says yes to. */
    missedWake: z.number().int(),
  })
  .openapi("JudgingStatus");

const status = createRoute({
  method: "get",
  path: "/judging",
  tags: ["judging"],
  summary: "Workers, clips waiting to be judged, and outcome counts",
  responses: {
    200: { description: "Status", content: { "application/json": { schema: Status } } },
  },
});

export function judgingRoutes(judging: Judging, guard: MiddlewareHandler<ApiEnv>) {
  const app = newApi();
  app.use("/judging", guard);
  return app.openapi(status, (c) => c.json(judging.status(), 200));
}
