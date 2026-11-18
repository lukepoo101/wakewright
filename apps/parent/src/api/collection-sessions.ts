import type { Database } from "bun:sqlite";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { getDevice } from "../db/devices.ts";
import { getSession, listSessions, listWrites, type SessionWithCounts } from "../db/sessions.ts";
import { describeError } from "../devices.ts";
import { describeSetting } from "../kiosk/collection-mode.ts";
import { type CollectionSessions, LIMIT_SECONDS, readSnapshot, SessionError } from "../sessions.ts";
import { type ApiEnv, errorContent, newApi } from "./common.ts";

// Collection sessions (ADR 0020): what one would change on a device, start
// one, stop it, the history, and the restores still waiting.
// /api/v1/collection-sessions and /api/v1/devices/{id}/collection-options.

const Note = z.enum(["wake_word", "not_wake_word", "mixed"]);

const Change = z
  .object({
    key: z.string(),
    title: z.string(),
    from: z.unknown(),
    to: z.unknown(),
    fromLabel: z.string(),
    toLabel: z.string(),
  })
  .openapi("CollectionSettingChange");

const Engine = z
  .object({
    value: z.string(),
    label: z.string(),
    current: z.boolean(),
    available: z.boolean(),
    reason: z.string().nullable(),
    recommended: z.boolean(),
    changes: z.array(Change),
  })
  .openapi("CollectionEngine");

const Options = z
  .object({
    ready: z.boolean(),
    problems: z.array(z.string()),
    current: z.object({
      engine: z.string().nullable(),
      engineLabel: z.string(),
      sensitivity: z.string().nullable(),
      sensitivityLabel: z.string(),
      fineTune: z.number().nullable(),
      wakeWords: z.array(z.string()),
    }),
    fleet: z
      .object({ role: z.enum(["leader", "follower"]), leader: z.string().nullable() })
      .nullable(),
    engines: z.array(Engine),
    defaultEngine: z.string().nullable(),
  })
  .openapi("CollectionOptions");

const OptionsResult = z
  .discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), options: Options }),
    z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
  ])
  .openapi("CollectionOptionsResult");

const Session = z
  .object({
    id: z.string(),
    deviceId: z.string(),
    deviceName: z.string(),
    /**
     * starting; running; restoring: putting the settings back, retried until
     * confirmed; ended; needs_attention: the saved settings cannot be used,
     * put them back by hand.
     */
    state: z.enum(["starting", "running", "restoring", "ended", "needs_attention"]),
    note: Note.nullable(),
    engine: z.string(),
    engineLabel: z.string(),
    limitSeconds: z.number().int(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    restoreStartedAt: z.string().nullable(),
    endReason: z
      .enum(["stopped", "time_limit", "paused", "parent_restart", "start_failed"])
      .nullable(),
    endedAt: z.string().nullable(),
    /** The device was read back with every saved value. */
    restoredAt: z.string().nullable(),
    resolvedByHandAt: z.string().nullable(),
    restoreAttempts: z.number().int(),
    nextRestoreAt: z.string().nullable(),
    lastError: z.string().nullable(),
    counts: z.object({ fired: z.number().int(), nearMiss: z.number().int() }),
    /** What the session changes: from the saved value to the boosted one. */
    changes: z.array(Change),
    /** The saved settings as stored, shown when they cannot be used. */
    snapshotText: z.string().nullable(),
  })
  .openapi("CollectionSession");

const Write = z
  .object({
    at: z.string(),
    purpose: z.enum(["apply", "undo_start", "restore"]),
    values: z.record(z.string(), z.unknown()),
    outcome: z.enum(["ok", "rejected", "failed"]),
    detail: z.string().nullable(),
  })
  .openapi("CollectionSettingsWrite");

const StartRequest = z
  .object({
    deviceId: z.string(),
    /** An engine setting value from the options; default: the recommended one. */
    engine: z.string().max(64).optional(),
    limitSeconds: z.number().int().min(LIMIT_SECONDS.min).max(LIMIT_SECONDS.max),
    note: Note.nullable().optional(),
  })
  .openapi("StartCollectionSession");

const IdParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const routes = {
  options: createRoute({
    method: "get",
    path: "/devices/{id}/collection-options",
    tags: ["collection sessions"],
    summary: "Read the device now and say what a collection session would change",
    request: { params: IdParam },
    responses: { 200: json(OptionsResult, "The outcome"), 404: errorContent("No such device") },
  }),
  list: createRoute({
    method: "get",
    path: "/collection-sessions",
    tags: ["collection sessions"],
    summary: "Collection sessions, newest first",
    request: {
      query: z.object({
        device: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    },
    responses: { 200: json(z.object({ sessions: z.array(Session) }), "Sessions") },
  }),
  get: createRoute({
    method: "get",
    path: "/collection-sessions/{id}",
    tags: ["collection sessions"],
    summary: "One session with every settings write it made",
    request: { params: IdParam },
    responses: {
      200: json(z.object({ session: Session, writes: z.array(Write) }), "The session"),
      404: errorContent("No such session"),
    },
  }),
  start: createRoute({
    method: "post",
    path: "/collection-sessions",
    tags: ["collection sessions"],
    summary: "Start a session: save the device's settings, then raise its sensitivity",
    request: {
      body: { required: true, content: { "application/json": { schema: StartRequest } } },
    },
    responses: {
      201: json(Session, "Running"),
      404: errorContent("No such device"),
      409: errorContent("Collection is paused, or the device has a session already"),
      422: errorContent("The session did not start; nothing is left changed on the device"),
    },
  }),
  stop: createRoute({
    method: "post",
    path: "/collection-sessions/{id}/stop",
    tags: ["collection sessions"],
    summary: "Stop a session and put the device's settings back",
    request: { params: IdParam },
    responses: {
      200: json(Session, "Ended, or still restoring when the device could not be reached"),
      404: errorContent("No such session"),
      409: errorContent("The session is not running"),
    },
  }),
  retry: createRoute({
    method: "post",
    path: "/collection-sessions/{id}/retry",
    tags: ["collection sessions"],
    summary: "Try to put a restoring session's settings back now",
    request: { params: IdParam },
    responses: {
      200: json(Session, "The session after the attempt"),
      404: errorContent("No such session"),
      409: errorContent("The session is not restoring"),
    },
  }),
  resolve: createRoute({
    method: "post",
    path: "/collection-sessions/{id}/resolve",
    tags: ["collection sessions"],
    summary: "Record that the settings of a session needing attention were put back by hand",
    request: { params: IdParam },
    responses: {
      200: json(Session, "Ended"),
      404: errorContent("No such session"),
      409: errorContent("The session does not need attention"),
    },
  }),
};

export function collectionSessionRoutes(
  deps: { db: Database; sessions: CollectionSessions },
  guard: MiddlewareHandler<ApiEnv>,
) {
  const { db, sessions } = deps;
  const app = newApi();
  for (const path of ["/collection-sessions", "/collection-sessions/*", "/devices/*"]) {
    app.use(path, guard);
  }
  const notFound = { error: "not_found", message: "No such collection session." } as const;
  const current = (id: string) => toSession(getSession(db, id) as SessionWithCounts);

  return app
    .openapi(routes.options, async (c) => {
      const device = getDevice(db, c.req.valid("param").id);
      if (!device) return c.json({ error: "not_found", message: "No such device." }, 404);
      try {
        return c.json({ ok: true as const, options: await sessions.options(device) }, 200);
      } catch (error) {
        return c.json({ ok: false as const, error: describeError(error) }, 200);
      }
    })
    .openapi(routes.list, (c) => {
      const q = c.req.valid("query");
      const rows = listSessions(db, { deviceId: q.device, limit: q.limit });
      return c.json({ sessions: rows.map(toSession) }, 200);
    })
    .openapi(routes.get, (c) => {
      const row = getSession(db, c.req.valid("param").id);
      if (!row) return c.json(notFound, 404);
      const writes = listWrites(db, row.id).map((w) => ({
        at: w.at,
        purpose: w.purpose,
        values: JSON.parse(w.values_json) as Record<string, unknown>,
        outcome: w.outcome,
        detail: w.detail,
      }));
      return c.json({ session: toSession(row), writes }, 200);
    })
    .openapi(routes.start, async (c) => {
      const input = c.req.valid("json");
      const device = getDevice(db, input.deviceId);
      if (!device) return c.json({ error: "not_found", message: "No such device." }, 404);
      try {
        const row = await sessions.startSession(device, {
          deviceId: device.id,
          engine: input.engine,
          limitSeconds: input.limitSeconds,
          note: input.note ?? null,
          userId: c.var.user?.id ?? null,
        });
        return c.json(current(row.id), 201);
      } catch (error) {
        if (!(error instanceof SessionError)) throw error;
        const status = error.code === "busy" || error.code === "paused" ? 409 : 422;
        return c.json({ error: error.code, message: error.message }, status);
      }
    })
    .openapi(routes.stop, async (c) => {
      const id = c.req.valid("param").id;
      if (!getSession(db, id)) return c.json(notFound, 404);
      try {
        await sessions.stopSession(id);
      } catch (error) {
        if (!(error instanceof SessionError)) throw error;
        return c.json({ error: error.code, message: error.message }, 409);
      }
      return c.json(current(id), 200);
    })
    .openapi(routes.retry, async (c) => {
      const id = c.req.valid("param").id;
      if (!getSession(db, id)) return c.json(notFound, 404);
      try {
        await sessions.retryNow(id);
      } catch (error) {
        if (!(error instanceof SessionError)) throw error;
        return c.json({ error: error.code, message: error.message }, 409);
      }
      return c.json(current(id), 200);
    })
    .openapi(routes.resolve, (c) => {
      const id = c.req.valid("param").id;
      if (!getSession(db, id)) return c.json(notFound, 404);
      try {
        sessions.resolveByHand(id);
      } catch (error) {
        if (!(error instanceof SessionError)) throw error;
        return c.json({ error: error.code, message: error.message }, 409);
      }
      return c.json(current(id), 200);
    });
}

export function toSession(s: SessionWithCounts): z.infer<typeof Session> {
  const snapshot = readSnapshot(s);
  let target: Record<string, unknown> = {};
  try {
    target = JSON.parse(s.target_json) as Record<string, unknown>;
  } catch {
    // A damaged row still lists what it can.
  }
  const keys = [...new Set([...Object.keys(snapshot ?? {}), ...Object.keys(target)])];
  const changes = keys.map((key) => {
    const from = snapshot?.[key];
    const to = target[key];
    return {
      key,
      title: describeSetting(key, to).title,
      from: from ?? null,
      to: to ?? null,
      fromLabel: snapshot ? describeSetting(key, from).label : "unknown",
      toLabel: describeSetting(key, to).label,
    };
  });
  return {
    id: s.id,
    deviceId: s.device_id,
    deviceName: s.device_name,
    state: s.state,
    note: s.note,
    engine: s.engine,
    engineLabel: describeSetting("voice.wake_word_engine", s.engine).label,
    limitSeconds: s.limit_seconds,
    createdAt: s.created_at,
    startedAt: s.started_at,
    endsAt: s.ends_at,
    restoreStartedAt: s.restore_started_at,
    endReason: s.end_reason,
    endedAt: s.ended_at,
    restoredAt: s.restored_at,
    resolvedByHandAt: s.resolved_by_hand_at,
    restoreAttempts: s.restore_attempts,
    nextRestoreAt: s.next_restore_at,
    lastError: s.last_error,
    counts: { fired: s.fired, nearMiss: s.near_miss },
    changes,
    snapshotText: snapshot === null ? s.snapshot_json : null,
  };
}
