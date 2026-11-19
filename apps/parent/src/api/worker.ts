import type { Database } from "bun:sqlite";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { BlobStore } from "../blobs.ts";
import { getClipRow } from "../db/clips.ts";
import { JUDGE_KINDS } from "../db/judges.ts";
import { SETTING_TYPES } from "../judge-settings.ts";
import { type Judging, PROTOCOL } from "../judging.ts";
import type { WorkerIdentity, Workers } from "../workers.ts";
import { type ApiEnv, errorContent, newApi } from "./common.ts";

// The worker API, /api/worker/v1 (protocol 3; protocol 2 workers too): workers advertise the judge
// types they offer and claim clips to judge (a long poll), download their
// audio and send back each judge's result. It is
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

/** The protocol versions this parent speaks, in words: "2 to 3". */
const SPOKEN: string =
  (PROTOCOL.min as number) === PROTOCOL.max
    ? String(PROTOCOL.min)
    : `${PROTOCOL.min} to ${PROTOCOL.max}`;

const TypeId = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_.-]{0,63}$/,
    "1–64 lower-case letters, digits, dots, dashes or underscores",
  )
  .openapi({ example: "openai-compatible" });
const Version = z.string().min(1).max(100).openapi({ example: "openai-compatible+1" });
const InstanceId = z.string().min(1).max(100).openapi({
  description: "A judge (instance) the owner configured on the parent's Judges page.",
  example: "0198f6a2-7c41-7b8e-9d1a-4f2b3c5d6e7f",
});

const SettingValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const SettingField = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .openapi({ example: "model" }),
    label: z.string().min(1).max(100).openapi({ example: "Model" }),
    type: z.enum(SETTING_TYPES).openapi({
      description:
        "How the form shows it. `long_text` is text on several lines (protocol 3). A secret (an API key) is stored encrypted and never shown again.",
    }),
    help: z.string().max(1000).default(""),
    default: SettingValue.default(null),
    required: z.boolean().default(false),
    options: z
      .array(z.object({ value: z.string().max(200), label: z.string().max(200) }))
      .max(100)
      .default([])
      .openapi({ description: "The choices of a select." }),
    minimum: z.number().nullable().default(null),
    maximum: z.number().nullable().default(null),
    placeholder: z.string().max(8000).default("").openapi({
      description: "Shown in the empty field, for example the text an empty value stands for.",
    }),
    affectsVerdict: z.boolean().default(true).openapi({
      description:
        "Whether changing it can change a verdict. If so, changing it judges every clip again. Ignored for a secret, which never does.",
    }),
  })
  .transform((f) => ({ ...f, affectsVerdict: f.type !== "secret" && f.affectsVerdict }))
  .openapi("SettingField");

const OfferedType = z
  .object({
    id: TypeId,
    version: Version.openapi({
      description:
        "Changes whenever the type's model or logic changes in a way that can change a verdict; every clip is then judged again.",
    }),
    name: z.string().min(1).max(100).openapi({ example: "OpenAI-compatible transcription" }),
    kind: z.enum(JUDGE_KINDS).openapi({
      description:
        "`wake_word_model`; `speech_to_text`: transcribes, then looks for the wake word in the transcript; `listening` (protocol 3): asks an audio model directly whether someone says the wake word.",
    }),
    description: z.string().max(1000).default(""),
    external: z.boolean().default(false).openapi({
      description:
        "True when the type sends clips to a service outside the worker; the UI warns before such a judge is turned on.",
    }),
    wakeWords: z.array(z.string().min(1).max(64)).max(200).nullable().openapi({
      description: "The wake words this type has a model for, or null for any wake word.",
      example: null,
    }),
    settings: z
      .array(SettingField)
      .max(30)
      .default([])
      .refine((fs) => new Set(fs.map((f) => f.key)).size === fs.length, {
        message: "Each setting key may appear once.",
      })
      .openapi({ description: "The form the Judges page shows for a judge of this type." }),
  })
  .openapi("OfferedType");

const ClaimRequest = z
  .object({
    protocol: z
      .number()
      .int()
      .openapi({
        description: `The worker protocol version the worker speaks. A parent answers 426 to a version it does not speak; this one speaks ${SPOKEN}.`,
        example: PROTOCOL.max,
      }),
    worker: z
      .object({
        name: z.string().min(1).max(100).openapi({ example: "judge-laptop" }),
        version: z.string().min(1).max(100).openapi({ example: "0.3.0" }),
      })
      .openapi({
        description:
          "What the worker says about itself, shown in the UI beside the worker's own name: usually its host name and its version. The token, not this name, identifies the worker.",
      }),
    types: z
      .array(OfferedType)
      .min(1)
      .max(20)
      .refine((ts) => new Set(ts.map((t) => t.id)).size === ts.length, {
        message: "Each judge type may be offered once.",
      })
      .openapi({ description: "The judge types this worker can run now." }),
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

const JobJudge = z
  .object({
    instance: InstanceId,
    type: TypeId,
    settings: z.record(z.string(), SettingValue).openapi({
      description:
        "Every setting of the judge, secrets included, by key. Never log them or keep them after the job.",
      example: {
        base_url: "https://api.example.com/v1",
        api_key: "sk-example",
        model: "whisper-1",
      },
    }),
  })
  .openapi("JobJudge");

const Job = z
  .object({
    id: z.string().openapi({ description: "The job id, for posting its results." }),
    clipId: z.string(),
    wakeWord: z.string().openapi({ example: "alexa" }),
    judges: z.array(JobJudge).openapi({
      description: "The judges to run on this clip, each of a type the worker offered.",
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
    instance: InstanceId,
    type: TypeId,
    version: Version.openapi({ description: "The version of the type that ran." }),
    verdict: z.enum(["yes", "no", "abstain", "failed"]).openapi({
      description:
        "Does the clip contain its wake word? `abstain`, with a detail, when the judge cannot say for this clip (no model for its wake word, unusable audio). `failed`, with a detail and `failure`, when it cannot answer now (rate limited, quota used up, network, a refused key): nothing is recorded, the judge is paused and the clip tried again later.",
    }),
    score: z.number().nullable(),
    threshold: z.number().nullable(),
    transcript: z.string().max(2000).nullable(),
    detail: z.string().max(2000).nullable(),
    failure: z
      .object({
        reason: z.enum(["auth", "rate_limit", "quota", "network", "server", "other"]),
        retryAfterSeconds: z.number().min(0).max(86_400).nullable().openapi({
          description: "When the service said to try again, if it did.",
        }),
      })
      .nullable()
      .default(null)
      .openapi({ description: "For `failed` only." }),
    durationMs: z.number().min(0).openapi({ description: "How long the judge took." }),
  })
  .refine((r) => (r.verdict === "failed") === (r.failure !== null), {
    message: "A failed result needs `failure`, and only a failed one may have it.",
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
      "Records the judge types the worker offers, then hands out up to `max` clips, newest first, that lack a current result (the offered type version and the judge's settings) from an enabled judge of an offered type the worker may run, and that no other worker holds. A judge paused after a failure or at its daily limit is left out; a paused worker gets no jobs. Each clip is leased to this claim for about two minutes. With nothing to do, the request waits up to `waitSeconds` and answers an empty list. Every claim records the worker as seen.",
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
    summary: "Send a job's results; ends its lease",
    description:
      "At most one result per judge the job named. A judge left out is offered again on a later claim. A judge that cannot answer this clip reports `abstain` with a `detail`, so the clip is not retried forever; one that cannot answer now reports `failed`, which pauses the judge.",
    security,
    request: {
      params: JobParam,
      body: { required: true, content: { "application/json": { schema: Results } } },
    },
    responses: {
      204: { description: "Stored" },
      400: errorContent(
        "The request is not valid, or names a judge or version the job did not ask for",
      ),
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
          message: `This Wakewright speaks worker protocol ${SPOKEN}; the worker sent ${p}. Run the worker and the parent from the same release: upgrade the older of the two.`,
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
      const clip = getClipRow(db, c.req.valid("param").clipId);
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
        "How a worker advertises its judge types, claims clips from a Wakewright parent, downloads their audio and returns each judge's result. See docs/workers.md and docs/judges.md.",
      license: { name: "Apache-2.0", url: "https://www.apache.org/licenses/LICENSE-2.0" },
    },
  });
}
