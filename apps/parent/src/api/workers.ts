import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { Judges } from "../judges.ts";
import type { Judging } from "../judging.ts";
import { version } from "../version.ts";
import { NOTES_MAX, WORKER_NAME, type WorkerFailure, type Workers } from "../workers.ts";
import { type ApiEnv, errorContent, newApi } from "./common.ts";

// Managing workers, /api/v1/workers (ADR 0018): list every worker with what
// it reports, create one (its token is in the answer, once), edit, pause,
// give it a new token, delete. Signed-in users only, like the rest of
// /api/v1; a worker's token never opens these routes. Declared workers are
// listed but cannot be changed here.

/** Judge types Wakewright's own worker offers, always offered as choices. */
export const KNOWN_TYPES = [
  "openwakeword",
  "microwakeword",
  "stt",
  "openai-compatible",
  "elevenlabs",
] as const;

const JudgeName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "A judge type's id, such as stt");

export const WorkerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    notes: z.string(),
    /** False: paused, it gets no jobs. */
    enabled: z.boolean(),
    /** "config": declared in configuration, read-only here. "ui": created here. */
    source: z.enum(["config", "ui"]),
    /** The judge types it may run; null for every type, including new ones. */
    allowedJudges: z.array(z.string()).nullable(),
    reported: z.object({
      /** What the worker calls itself, usually its host name. */
      name: z.string().nullable(),
      version: z.string().nullable(),
      /** The judge types it offered in its last claim. */
      types: z.array(
        z.object({
          id: z.string(),
          version: z.string(),
          wakeWords: z.array(z.string()).nullable(),
        }),
      ),
      firstSeenAt: z.string().nullable(),
      lastSeenAt: z.string().nullable(),
    }),
    /** `hint`: the start of a generated token, to tell tokens apart. */
    token: z.object({ hint: z.string().nullable(), createdAt: z.string() }),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Waiting for work now, or seen in the last two minutes. */
    connected: z.boolean(),
  })
  .openapi("Worker");

const Name = z
  .string()
  .trim()
  .regex(WORKER_NAME, "1–64 letters, digits, spaces, dots, dashes or underscores");
const Notes = z.string().trim().max(NOTES_MAX);
const Allowed = z
  .array(JudgeName)
  .min(1, "Allow at least one judge type, or every type")
  .max(20)
  .nullable()
  .transform((js) => (js === null ? null : [...new Set(js)].sort()));

const CreateBody = z
  .object({
    name: Name,
    notes: Notes.optional(),
    enabled: z.boolean().optional(),
    allowedJudges: Allowed.optional(),
  })
  .openapi("NewWorker");

const UpdateBody = z
  .object({
    name: Name.optional(),
    notes: Notes.optional(),
    enabled: z.boolean().optional(),
    allowedJudges: Allowed.optional(),
  })
  .openapi("WorkerChanges");

const WithToken = z.object({
  worker: WorkerSchema,
  /** The worker's token. Shown once: the parent keeps only its hash. */
  token: z.string(),
});

const IdParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const List = z.object({
  workers: z.array(WorkerSchema),
  /** Judge type ids to choose from: Wakewright's own and any a worker offers. */
  judges: z.array(z.string()),
  /** Their names, by id. */
  typeNames: z.record(z.string(), z.string()),
  /** WAKEWRIGHT__SERVER__PUBLIC_URL, the address a pairing string suggests. */
  publicUrl: z.string().nullable(),
  /** This parent's version, for the worker image tag in the instructions. */
  version: z.string(),
});

const conflict = errorContent("The name is in use, or the worker is set by configuration");
const missing = errorContent("No such worker");

const routes = {
  list: createRoute({
    method: "get",
    path: "/workers",
    tags: ["workers"],
    summary: "Every worker: declared ones first, then those created here",
    responses: {
      200: { description: "Workers", content: { "application/json": { schema: List } } },
    },
  }),
  create: createRoute({
    method: "post",
    path: "/workers",
    tags: ["workers"],
    summary: "Create a worker; the answer holds its token, once",
    request: { body: { required: true, content: { "application/json": { schema: CreateBody } } } },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: WithToken } } },
      400: errorContent("The request is not valid"),
      409: conflict,
    },
  }),
  update: createRoute({
    method: "patch",
    path: "/workers/{id}",
    tags: ["workers"],
    summary: "Rename, edit notes, pause or resume, or change the judge types it may run",
    request: {
      params: IdParam,
      body: { required: true, content: { "application/json": { schema: UpdateBody } } },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: z.object({ worker: WorkerSchema }) } },
      },
      400: errorContent("The request is not valid"),
      404: missing,
      409: conflict,
    },
  }),
  token: createRoute({
    method: "post",
    path: "/workers/{id}/token",
    tags: ["workers"],
    summary: "Give the worker a new token; the old one stops working at once",
    request: { params: IdParam },
    responses: {
      200: { description: "The new token", content: { "application/json": { schema: WithToken } } },
      404: missing,
      409: conflict,
    },
  }),
  remove: createRoute({
    method: "delete",
    path: "/workers/{id}",
    tags: ["workers"],
    summary: "Delete the worker: its token stops working; its past verdicts stay",
    request: { params: IdParam },
    responses: { 204: { description: "Deleted" }, 404: missing, 409: conflict },
  }),
};

export function workerAdminRoutes(
  deps: { workers: Workers; judging: Judging; judges: Judges; publicUrl?: URL },
  guard: MiddlewareHandler<ApiEnv>,
) {
  const { workers, judging, judges: judgeTypes } = deps;
  const app = newApi();
  app.use("/workers", guard);
  app.use("/workers/*", guard);

  const view = (id: string) => {
    const w = judging.worker(id);
    if (!w) throw new Error(`worker ${id} vanished`);
    return w;
  };

  return app
    .openapi(routes.list, (c) => {
      const list = judging.workers();
      const judges = new Set<string>(KNOWN_TYPES);
      for (const w of list) {
        for (const t of w.reported.types) judges.add(t.id);
        for (const j of w.allowedJudges ?? []) judges.add(j);
      }
      const typeNames: Record<string, string> = {};
      for (const t of judgeTypes.types()) {
        judges.add(t.id);
        typeNames[t.id] = t.name;
      }
      return c.json(
        {
          workers: list,
          judges: [...judges].sort(),
          typeNames,
          publicUrl: deps.publicUrl ? deps.publicUrl.href.replace(/\/$/, "") : null,
          version,
        },
        200,
      );
    })
    .openapi(routes.create, (c) => {
      const body = c.req.valid("json");
      const out = workers.create(body);
      // Creating can only clash on the name.
      if (!out.ok) return c.json(failure(out)[0], 409);
      return c.json({ worker: view(out.worker.id), token: out.token }, 201);
    })
    .openapi(routes.update, (c) => {
      const out = workers.update(c.req.valid("param").id, c.req.valid("json"));
      if (!out.ok) return c.json(...failure(out));
      return c.json({ worker: view(out.worker.id) }, 200);
    })
    .openapi(routes.token, (c) => {
      const out = workers.regenerateToken(c.req.valid("param").id);
      if (!out.ok) return c.json(...failure(out));
      return c.json({ worker: view(out.worker.id), token: out.token }, 200);
    })
    .openapi(routes.remove, (c) => {
      const out = workers.delete(c.req.valid("param").id);
      if (!out.ok) return c.json(...failure(out));
      return c.body(null, 204);
    });
}

function failure(f: WorkerFailure): [{ error: string; message: string }, 404 | 409] {
  switch (f.reason) {
    case "not_found":
      return [{ error: "not_found", message: "No such worker." }, 404];
    case "managed":
      return [
        {
          error: "managed_by_configuration",
          message:
            "This worker is set by configuration. Change it in the deployment's WAKEWRIGHT__WORKERS__ settings and restart.",
        },
        409,
      ];
    case "name_taken":
      return [
        {
          error: "name_taken",
          message: f.byConfiguration
            ? "A worker set by configuration has that name. Choose another."
            : "Another worker has that name. Choose another.",
        },
        409,
      ];
  }
}
