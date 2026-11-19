import type { Database } from "bun:sqlite";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { type InstanceRow, JUDGE_KINDS } from "../db/judges.ts";
import { SETTING_TYPES, type SettingValue } from "../judge-settings.ts";
import { DAILY_LIMIT_MAX, type JudgeFailure, type Judges, NAME_MAX } from "../judges.ts";
import type { Judging } from "../judging.ts";
import { DEFAULT_RULE, DEFAULT_WEIGHT, MAX_WEIGHT } from "../outcome.ts";
import { type ApiEnv, errorContent, newApi } from "./common.ts";

// The Judges page, /api/v1/judges (ADR 0019): the judge types workers offer
// with their settings forms, the judges configured from them (add, edit,
// turn on or off, delete, test on one clip) and the rule that turns their
// weighted votes into an outcome. Secret settings are never returned: a
// judge says only which are set.

const SettingValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const Field = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.enum(SETTING_TYPES),
    help: z.string(),
    default: SettingValueSchema,
    required: z.boolean(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
    minimum: z.number().nullable(),
    maximum: z.number().nullable(),
    placeholder: z.string(),
    affectsVerdict: z.boolean(),
  })
  .openapi("JudgeSettingField");

const Kind = z.enum(JUDGE_KINDS);

const TypeView = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: Kind,
    description: z.string(),
    /** Sends clips to a service outside the worker. */
    external: z.boolean(),
    version: z.string(),
    wakeWords: z.array(z.string()).nullable(),
    settings: z.array(Field),
    /** False: known only from earlier verdicts; no worker has offered it yet. */
    advertised: z.boolean(),
    /** Workers that offer it and may run it. */
    workers: z.array(z.string()),
  })
  .openapi("JudgeType");

const Health = z.enum(["ok", "idle", "off", "failing", "limited", "no_worker", "no_type"]);

export const JudgeView = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    typeName: z.string(),
    kind: Kind,
    external: z.boolean(),
    /** The non-secret settings. */
    settings: z.record(z.string(), SettingValueSchema),
    /** Each secret setting: whether it is set. Its value is never returned. */
    secrets: z.record(z.string(), z.boolean()),
    weight: z.number(),
    enabled: z.boolean(),
    /** At most this many clips in any 24 hours; null for no limit. */
    dailyLimit: z.number().int().nullable(),
    /**
     * ok; idle (has not judged yet); off; failing (paused after a temporary
     * failure until retryAt); limited (daily limit reached); no_worker (no
     * connected worker offers its type and may run it); no_type (no worker
     * has offered its type).
     */
    health: Health,
    lastError: z
      .object({ message: z.string(), reason: z.string().nullable(), at: z.string().nullable() })
      .nullable(),
    retryAt: z.string().nullable(),
    lastResultAt: z.string().nullable(),
    /** Workers that can run it now. */
    workers: z.array(z.string()),
    /** Runs in the last 24 hours (which count against the daily limit), and answers among them. */
    attempts24h: z.number().int(),
    judged24h: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Judge");

const Rule = z
  .object({
    margin: z.number().min(0).max(1),
    minimum: z.number().min(0).max(100),
  })
  .openapi("OutcomeRule");

const List = z.object({
  judges: z.array(JudgeView),
  types: z.array(TypeView),
  rule: Rule,
  defaults: z.object({
    rule: Rule,
    weight: z.object({
      speech_to_text: z.number(),
      wake_word_model: z.number(),
      listening: z.number(),
    }),
    maxWeight: z.number(),
  }),
});

const Name = z
  .string()
  .trim()
  .min(1, "Give the judge a name.")
  .max(NAME_MAX, `At most ${NAME_MAX} characters.`);
const Weight = z.number().min(0).max(MAX_WEIGHT);
const DailyLimit = z.number().int().min(1).max(DAILY_LIMIT_MAX).nullable();
const Settings = z.record(z.string(), z.unknown()).openapi({
  description:
    "Values by key, checked against the type's schema. A secret left out keeps its value; a secret sent as null or an empty string is removed.",
});

const CreateBody = z
  .object({
    name: Name,
    type: z.string().min(1).max(64),
    settings: Settings.optional(),
    weight: Weight.optional(),
    enabled: z.boolean().optional(),
    dailyLimit: DailyLimit.optional(),
  })
  .openapi("NewJudge");

const UpdateBody = z
  .object({
    name: Name.optional(),
    settings: Settings.optional(),
    weight: Weight.optional(),
    enabled: z.boolean().optional(),
    dailyLimit: DailyLimit.optional(),
  })
  .openapi("JudgeChanges");

const Invalid = z
  .object({
    error: z.string(),
    message: z.string(),
    /** For invalid settings: the message for each setting key. */
    fields: z.record(z.string(), z.string()).optional(),
  })
  .openapi("JudgeError");
const invalid = (description: string) => ({
  description,
  content: { "application/json": { schema: Invalid } },
});

const TestView = z
  .object({
    id: z.string(),
    judgeId: z.string(),
    clipId: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    /** waiting: no worker has taken it yet; running; done; expired: no worker took it in time. */
    state: z.enum(["waiting", "running", "done", "expired"]),
    result: z
      .object({
        verdict: z.enum(["yes", "no", "abstain", "failed"]),
        score: z.number().nullable(),
        threshold: z.number().nullable(),
        transcript: z.string().nullable(),
        detail: z.string().nullable(),
        failure: z
          .object({ reason: z.string(), retryAfterSeconds: z.number().nullable() })
          .nullable(),
        durationMs: z.number().int(),
        worker: z.string(),
        version: z.string(),
      })
      .nullable(),
  })
  .openapi("JudgeTest");

const IdParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });
const missing = errorContent("No such judge");

const routes = {
  list: createRoute({
    method: "get",
    path: "/judges",
    tags: ["judges"],
    summary: "Every judge, the judge types workers offer, and the outcome rule",
    responses: {
      200: { description: "Judges", content: { "application/json": { schema: List } } },
    },
  }),
  create: createRoute({
    method: "post",
    path: "/judges",
    tags: ["judges"],
    summary: "Add a judge of a type a worker offers",
    request: { body: { required: true, content: { "application/json": { schema: CreateBody } } } },
    responses: {
      201: {
        description: "Added",
        content: { "application/json": { schema: z.object({ judge: JudgeView }) } },
      },
      400: invalid("The request or a setting is not valid, or no worker has offered the type"),
      404: missing,
      409: errorContent("Another judge has that name"),
    },
  }),
  update: createRoute({
    method: "patch",
    path: "/judges/{id}",
    tags: ["judges"],
    summary: "Rename, change settings, weight or daily limit, or turn on or off",
    description:
      "Changing a setting that can change a verdict judges every clip again with this judge. A new name, weight or limit judges nothing again: outcomes follow at once.",
    request: {
      params: IdParam,
      body: { required: true, content: { "application/json": { schema: UpdateBody } } },
    },
    responses: {
      200: {
        description: "Changed",
        content: { "application/json": { schema: z.object({ judge: JudgeView }) } },
      },
      400: invalid("The request or a setting is not valid"),
      404: missing,
      409: errorContent("Another judge has that name"),
    },
  }),
  remove: createRoute({
    method: "delete",
    path: "/judges/{id}",
    tags: ["judges"],
    summary: "Delete a judge: it stops running and counting; its verdicts stay visible",
    request: { params: IdParam },
    responses: { 204: { description: "Deleted" }, 404: missing },
  }),
  rule: createRoute({
    method: "put",
    path: "/judging/rule",
    tags: ["judges"],
    summary: "Set the margin and minimum weight that decide outcomes",
    request: { body: { required: true, content: { "application/json": { schema: Rule } } } },
    responses: {
      200: {
        description: "Set; every outcome follows at once",
        content: { "application/json": { schema: z.object({ rule: Rule }) } },
      },
      400: errorContent("Not valid"),
    },
  }),
  test: createRoute({
    method: "post",
    path: "/judges/{id}/test",
    tags: ["judges"],
    summary: "Run the judge on one stored clip, through a worker, and keep what it says",
    description:
      "The next claim from a worker that offers the judge's type and may run it takes the test, even if the judge is off, paused or at its limit. Poll the test for its result. A verdict is stored like any other.",
    request: {
      params: IdParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              clipId: z.string().optional().openapi({
                description: "Default: the newest clip whose wake word the type covers.",
              }),
            }),
          },
        },
      },
    },
    responses: {
      202: {
        description: "Waiting for a worker",
        content: { "application/json": { schema: z.object({ test: TestView }) } },
      },
      404: errorContent("No such judge or clip, or no clips yet"),
    },
  }),
  getTest: createRoute({
    method: "get",
    path: "/judge-tests/{id}",
    tags: ["judges"],
    summary: "A test run and its result",
    request: { params: IdParam },
    responses: {
      200: {
        description: "The test",
        content: { "application/json": { schema: z.object({ test: TestView }) } },
      },
      404: errorContent("No such test"),
    },
  }),
};

export function judgeRoutes(
  deps: { db: Database; judges: Judges; judging: Judging },
  guard: MiddlewareHandler<ApiEnv>,
) {
  const { db, judges, judging } = deps;
  const app = newApi();
  for (const path of ["/judges", "/judges/*", "/judging/rule", "/judge-tests/*"]) {
    app.use(path, guard);
  }

  const view = async (row: InstanceRow, states = judging.judgeStates()) => {
    const type = judges.type(row.type);
    const state = states.get(row.id);
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      typeName: type?.name ?? row.type,
      kind: type?.kind ?? "wake_word_model",
      external: type?.external ?? false,
      settings: JSON.parse(row.settings_json) as Record<string, SettingValue>,
      secrets: await judges.secretsSet(row),
      weight: row.weight,
      enabled: row.enabled === 1,
      dailyLimit: row.daily_limit,
      health: state?.health ?? "no_type",
      lastError:
        row.last_error === null
          ? null
          : { message: row.last_error, reason: row.last_error_reason, at: row.last_error_at },
      retryAt: row.retry_at,
      lastResultAt: row.last_result_at,
      workers: state?.workers ?? [],
      attempts24h: state?.attempts24h ?? 0,
      judged24h: state?.judged24h ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  return app
    .openapi(routes.list, async (c) => {
      const states = judging.judgeStates();
      const offers = judging.recentOffers();
      const list = await Promise.all(judges.list().map((row) => view(row, states)));
      const types = judges.types().map((t) => ({
        ...t,
        workers: [...new Set(offers.filter((o) => o.type === t.id).map((o) => o.worker))].sort(),
      }));
      return c.json(
        {
          judges: list,
          types,
          rule: judges.rule(),
          defaults: { rule: DEFAULT_RULE, weight: DEFAULT_WEIGHT, maxWeight: MAX_WEIGHT },
        },
        200,
      );
    })
    .openapi(routes.create, async (c) => {
      const out = await judges.create(c.req.valid("json"));
      if (!out.ok) return c.json(...failure(out));
      return c.json({ judge: await view(out.judge) }, 201);
    })
    .openapi(routes.update, async (c) => {
      const out = await judges.update(c.req.valid("param").id, c.req.valid("json"));
      if (!out.ok) return c.json(...failure(out));
      return c.json({ judge: await view(out.judge) }, 200);
    })
    .openapi(routes.remove, (c) => {
      const out = judges.delete(c.req.valid("param").id);
      if (!out.ok) return c.json({ error: "not_found", message: "No such judge." }, 404);
      return c.body(null, 204);
    })
    .openapi(routes.rule, (c) => {
      const rule = c.req.valid("json");
      judges.setRule(rule);
      return c.json({ rule: judges.rule() }, 200);
    })
    .openapi(routes.test, async (c) => {
      const row = judges.get(c.req.valid("param").id);
      if (!row) return c.json({ error: "not_found", message: "No such judge." }, 404);
      const body = (await c.req.json().catch(() => ({}))) as { clipId?: unknown };
      const clipId =
        typeof body.clipId === "string" ? body.clipId : newestClipFor(db, judges, row.type);
      const test = clipId ? judging.startTest(row.id, clipId) : null;
      if (!test) {
        return c.json(
          { error: "not_found", message: clipId ? "No such clip." : "There are no clips yet." },
          404,
        );
      }
      return c.json({ test }, 202);
    })
    .openapi(routes.getTest, (c) => {
      const test = judging.test(c.req.valid("param").id);
      if (!test) return c.json({ error: "not_found", message: "No such test." }, 404);
      return c.json({ test }, 200);
    });
}

// The newest clip with a wake word the type has a model for.
function newestClipFor(db: Database, judges: Judges, typeId: string): string | null {
  const words = judges.type(typeId)?.wakeWords ?? null;
  const rows = db
    .query<{ id: string; wake_word: string }, []>(
      "SELECT id, wake_word FROM clips ORDER BY captured_at DESC, id DESC LIMIT 200",
    )
    .all();
  const covered = rows.find((r) => words === null || words.includes(r.wake_word.toLowerCase()));
  return (covered ?? rows[0])?.id ?? null;
}

function failure(
  f: JudgeFailure,
): [{ error: string; message: string; fields?: Record<string, string> }, 400 | 404 | 409] {
  switch (f.reason) {
    case "not_found":
      return [{ error: "not_found", message: "No such judge." }, 404];
    case "unknown_type":
      return [
        {
          error: "unknown_type",
          message: "No worker has offered this judge type. Start a worker that offers it first.",
        },
        400,
      ];
    case "name_taken":
      return [
        { error: "name_taken", message: "Another judge has that name. Choose another." },
        409,
      ];
    case "invalid":
      return [
        {
          error: "invalid_settings",
          message: Object.values(f.errors).join(" "),
          fields: f.errors,
        },
        400,
      ];
  }
}
