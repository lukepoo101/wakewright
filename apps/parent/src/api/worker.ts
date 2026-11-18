import type { Database } from "bun:sqlite";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { BlobStore } from "../blobs.ts";
import { getClip } from "../db/clips.ts";
import { type Judging, PROTOCOL } from "../judging.ts";
import type { WorkerIdentity, Workers } from "../workers.ts";
import { type ApiEnv, errorContent, newApi } from "./common.ts";

// The worker API, /api/worker/v1: workers claim clips to judge (a long
// poll), download their audio and send back each judge's verdict. It is
// authenticated only by a worker's own token (ADR 0018), never by a user
// session. docs/workers.md describes it for people writing a worker;
// docs/api/worker-v1.openapi.json is the committed document
// (scripts/worker-openapi.ts).

export const WORKER_BASE = "/api/worker/v1";
/** The security scheme name in the OpenAPI document. */
export const WORKER_AUTH = "workerToken";
export const workerSecurityScheme = {
  type: "http",
  scheme: "bearer",
  description:
    "The worker's own token, shown once when the worker is created in the parent's Workers tab, or set in the parent's configuration for a declared worker.",
} as const;

interface WorkerEnv extends ApiEnv {
  Variables: ApiEnv["Variables"] & { worker: WorkerIdentity };
}

const Name = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_.-]{0,63}$/,
    "1–64 lower-case letters, digits, dots, dashes or underscores",
  )
  .openapi({ example: "openwakeword" });
const Version = z.string().min(1).max(100).openapi({ example: "alexa_v0.1+1" });

const OfferedJudge = z
  .object({
    name: Name,
    version: Version,
    wakeWords: z
      .array(z.string().min(1).max(64))
      .max(200)
      .nullable()
      .openapi({
        description: "The wake words this judge has a model for, or null for any wake word.",
        example: ["alexa"],
      }),
  })
  .openapi("OfferedJudge");

const ClaimRequest = z
  .object({
    protocol: z
      .number()
      .int()
      .openapi({
        description: `The worker protocol version the worker speaks. A parent answers 426 to a version it does not speak; this one speaks ${PROTOCOL.min === PROTOCOL.max ? PROTOCOL.min : `${PROTOCOL.min} to ${PROTOCOL.max}`}.`,
        example: 1,
      }),
    worker: z
      .object({
        name: z.string().min(1).max(100).openapi({ example: "judge-laptop" }),
        version: z.string().min(1).max(100).openapi({ example: "0.2.0" }),
      })
      .openapi({
        description:
          "What the worker says about itself, shown in the UI beside the worker's own name: usually its host name and its version. The token, not this name, identifies the worker.",
      }),
    judges: z
      .array(OfferedJudge)
      .min(1)
      .max(20)
      .refine((js) => new Set(js.map((j) => j.name)).size === js.length, {
        message: "Each judge may be offered once.",
      }),
    max: z
      .number()
      .int()
      .min(1)
      .max(32)
      .default(8)
      .openapi({ description: "The most jobs to hand out." }),
    waitSeconds: z.number().min(0).max(60).default(25).openapi({
      description: "How long to wait for work when there is none now.",
    }),
  })
  .openapi("ClaimRequest");

const Job = z
  .object({
    id: z.string().openapi({ description: "The job id, for posting its results." }),
    clipId: z.string(),
    wakeWord: z.string().openapi({ example: "alexa" }),
    judges: z.array(Name).openapi({
      description: "The offered judges to run on this clip, at the versions offered.",
    }),
    leaseExpiresAt: z.string().openapi({
      description: "Results after this time are refused with 409.",
      example: "2026-11-18T12:02:00.000Z",
    }),
  })
  .openapi("Job");

const Unsupported = z
  .object({
    error: z.literal("unsupported_protocol"),
    message: z.string(),
    supported: z.object({ min: z.number().int(), max: z.number().int() }),
  })
  .openapi("UnsupportedProtocol");

const Result = z
  .object({
    judge: Name,
    version: Version,
    verdict: z.enum(["yes", "no", "abstain"]).openapi({
      description:
        "Does the clip contain its wake word? Abstain, with a detail, when the judge cannot say (no model, or it failed on this clip).",
    }),
    score: z.number().nullable(),
    threshold: z.number().nullable(),
    transcript: z.string().max(2000).nullable(),
    detail: z.string().max(2000).nullable(),
    durationMs: z.number().min(0).openapi({ description: "How long the judge took." }),
  })
  .openapi("JudgeResult");

const Results = z.object({ results: z.array(Result).min(1).max(20) }).openapi("JobResults");

const JobParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const ClipParam = z.object({
  clipId: z.string().openapi({ param: { name: "clipId", in: "path" } }),
});

const security = [{ [WORKER_AUTH]: [] }];
const unauthorised = errorContent(
  "No token, or a token that is not a worker's: wrong, replaced, or its worker was deleted",
);

const routes = {
  claim: createRoute({
    method: "post",
    path: "/jobs/claim",
    tags: ["worker"],
    summary: "Lease clips to judge, waiting for one when there are none (long poll)",
    description:
      "Hands out up to `max` clips, newest first, that lack a result from any offered judge at its offered version and that no other worker holds. Only judges the worker is allowed to run are asked for, and a paused worker gets no jobs. Each clip is leased to this claim for about two minutes. With nothing to do, the request waits up to `waitSeconds` and answers an empty list. Every claim records the worker as seen.",
    security,
    request: {
      body: { required: true, content: { "application/json": { schema: ClaimRequest } } },
    },
    responses: {
      200: {
        description: "Jobs, possibly none",
        content: { "application/json": { schema: z.object({ jobs: z.array(Job) }) } },
      },
      400: errorContent("The request is not valid"),
      401: unauthorised,
      426: {
        description: "The parent does not speak this protocol version",
        content: { "application/json": { schema: Unsupported } },
      },
    },
  }),
  audio: createRoute({
    method: "get",
    path: "/clips/{clipId}/audio",
    tags: ["worker"],
    summary: "A clip's audio: 16 kHz mono 16-bit PCM WAV",
    security,
    request: { params: ClipParam },
    responses: {
      200: {
        description: "The WAV file",
        content: { "audio/wav": { schema: z.string().openapi({ format: "binary" }) } },
      },
      401: unauthorised,
      404: errorContent("No such clip"),
    },
  }),
  results: createRoute({
    method: "post",
    path: "/jobs/{id}/results",
    tags: ["worker"],
    summary: "Send a job's verdicts; ends its lease",
    description:
      "One result per judge the job named. A judge left out is offered again on a later claim. A judge that failed on the clip reports `abstain` with a `detail`, so the clip is not retried forever.",
    security,
    request: {
      params: JobParam,
      body: { required: true, content: { "application/json": { schema: Results } } },
    },
    responses: {
      204: { description: "Stored" },
      400: errorContent("The request is not valid, or names a judge the job did not ask for"),
      401: unauthorised,
      409: errorContent(
        "The lease has expired, was released (the worker was paused or changed) or belongs to another worker: claim again",
      ),
    },
  }),
};

export function workerRoutes(deps: {
  db: Database;
  blobs: BlobStore;
  judging: Judging;
  workers: Workers;
}) {
  const { db, blobs, judging } = deps;
  const app = newApi<WorkerEnv>();
  app.use("*", workerAuth(deps.workers));
  // The protocol is checked before the body is validated, so a newer
  // worker whose request this parent cannot parse still learns why.
  app.use("/jobs/claim", async (c, next) => {
    const body = (await c.req.json().catch(() => null)) as { protocol?: unknown } | null;
    const p = body?.protocol;
    if (typeof p === "number" && (p < PROTOCOL.min || p > PROTOCOL.max)) {
      return c.json(
        {
          error: "unsupported_protocol" as const,
          message: `This Wakewright speaks worker protocol ${PROTOCOL.min} to ${PROTOCOL.max}; the worker sent ${p}. Upgrade the older of the two.`,
          supported: { ...PROTOCOL },
        },
        426,
      );
    }
    await next();
  });

  return app
    .openapi(routes.claim, async (c) => {
      const body = c.req.valid("json");
      // A long poll outlasts Bun's default 10 s idle timeout.
      const server = c.env as { timeout?: (req: Request, seconds: number) => void } | undefined;
      server?.timeout?.(c.req.raw, Math.ceil(body.waitSeconds) + 15);
      const jobs = await judging.claim(c.get("worker"), body, c.req.raw.signal);
      return c.json({ jobs }, 200);
    })
    .openapi(routes.audio, async (c) => {
      const clip = getClip(db, c.req.valid("param").clipId);
      if (!clip) return c.json({ error: "not_found", message: "No such clip." }, 404);
      const file = blobs.file(clip.audio_sha256);
      return c.body(await file.arrayBuffer(), 200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(file.size),
        "Cache-Control": "private, no-store",
      });
    })
    .openapi(routes.results, (c) => {
      const outcome = judging.submit(
        c.get("worker"),
        c.req.valid("param").id,
        c.req.valid("json").results,
      );
      if (outcome.ok) return c.body(null, 204);
      if (outcome.reason === "stale") {
        return c.json(
          {
            error: "lease_expired",
            message:
              "This job's lease has expired, was released or is not this worker's. Claim again.",
          },
          409,
        );
      }
      return c.json({ error: "invalid_request", message: outcome.message }, 400);
    });
}

// Bearer token check: the token must be a worker's (Workers.authenticate
// checks it against every worker in constant time). Never logged.
function workerAuth(workers: Workers): MiddlewareHandler<WorkerEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    const worker = given ? workers.authenticate(given) : null;
    if (!worker) {
      c.header("WWW-Authenticate", 'Bearer realm="wakewright-worker"');
      return c.json(
        {
          error: "unauthenticated",
          message:
            "Send this worker's token. A worker's token stops working when it is replaced or the worker is deleted.",
        },
        401,
      );
    }
    c.set("worker", worker);
    await next();
  };
}

/**
 * The worker API alone as an OpenAPI 3.1 document, as committed in
 * docs/api/worker-v1.openapi.json. Its version is the protocol's, so it
 * changes only when the wire format does.
 */
export function workerOpenApiDocument() {
  const unused = undefined as never;
  const app = newApi().route(
    WORKER_BASE,
    workerRoutes({ db: unused, blobs: unused, judging: unused, workers: unused }),
  );
  app.openAPIRegistry.registerComponent("securitySchemes", WORKER_AUTH, workerSecurityScheme);
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Wakewright worker API",
      version: String(PROTOCOL.max),
      description:
        "How a worker claims clips from a Wakewright parent, downloads their audio and returns each judge's verdict. See docs/workers.md.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
  });
}
