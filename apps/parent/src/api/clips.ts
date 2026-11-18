import type { Database } from "bun:sqlite";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { BlobStore } from "../blobs.ts";
import { isClipped } from "../clipping-rule.ts";
import {
  type ClipFilter,
  type ClipListRow,
  clipEngines,
  clipNeighbours,
  clipSummary,
  getClipRow,
  listClips,
} from "../db/clips.ts";
import { getInstance } from "../db/judges.ts";
import type { Judges } from "../judges.ts";
import type { Judging } from "../judging.ts";
import { confidence, dissent } from "../outcome.ts";
import { type ApiEnv, errorContent, newApi } from "./common.ts";

// Collected clips: list with filters and paging, one clip with its
// neighbours, its audio (with Range support, for seeking) and a summary
// for the home screen. /api/v1/clips.

const Kind = z.enum(["fired", "near_miss"]);
const Outcome = z.enum(["yes", "no", "uncertain", "not_enough", "waiting"]);
const Settled = z.enum(["yes", "no", "uncertain", "not_enough"]);
const Mismatch = z.enum(["false_wake", "missed_wake"]);

/**
 * What the judges said, weighted (ADR 0019, src/outcome.ts): each counted
 * judge's latest yes or no times its weight. mismatch is set when the
 * outcome is against the device (it fired but the outcome is no: a likely
 * false wake; a near miss the outcome says yes to: a likely missed wake word).
 */
const ClipJudging = z
  .object({
    outcome: Outcome,
    /** While waiting: the outcome from the judges that have answered so far. */
    provisional: Settled.nullable(),
    /** -1 (all no) to +1 (all yes); null when no weight voted. */
    score: z.number().nullable(),
    /** 0 to 1: the share of the voting weight on the side the score leans to. */
    confidence: z.number().nullable(),
    yesWeight: z.number(),
    noWeight: z.number(),
    /** Counted judges that said yes, no, or could not tell. */
    yes: z.number().int(),
    no: z.number().int(),
    abstain: z.number().int(),
    /** A counted judge voted against the outcome. */
    dissent: z.boolean(),
    mismatch: Mismatch.nullable(),
  })
  .openapi("ClipJudging");

const JudgeResult = z
  .object({
    judgeId: z.string(),
    name: z.string(),
    type: z.string(),
    typeName: z.string(),
    weight: z.number(),
    /** counted; not_counted (weight 0); off; deleted. */
    status: z.enum(["counted", "not_counted", "off", "deleted"]),
    /** False: judged with earlier settings or an earlier version of its type. */
    current: z.boolean(),
    version: z.string(),
    verdict: z.enum(["yes", "no", "abstain"]),
    score: z.number().nullable(),
    threshold: z.number().nullable(),
    transcript: z.string().nullable(),
    detail: z.string().nullable(),
    durationMs: z.number().int(),
    worker: z.string(),
    judgedAt: z.string(),
  })
  .openapi("ClipJudgeResult");

const PendingJudge = z
  .object({
    judgeId: z.string(),
    name: z.string(),
    typeName: z.string(),
    weight: z.number(),
    /**
     * waiting: not judged yet; rejudging: its settings or version changed;
     * no_model: its type has no model for this wake word; failing: paused
     * after a failure; limited: at its daily limit; no_worker: no worker can
     * run it; not_counted: weight 0.
     */
    reason: z.enum([
      "waiting",
      "rejudging",
      "no_model",
      "failing",
      "limited",
      "no_worker",
      "not_counted",
    ]),
  })
  .openapi("PendingJudge");

const Clip = z
  .object({
    id: z.string(),
    deviceId: z.string(),
    deviceName: z.string(),
    deviceRemoved: z.boolean(),
    capturedAt: z.string(),
    ingestedAt: z.string(),
    kind: Kind,
    wakeWord: z.string(),
    engine: z.string(),
    score: z.number().nullable(),
    threshold: z.number().nullable(),
    peakDb: z.number().nullable(),
    rmsDb: z.number().nullable(),
    /** Samples at full scale, as the device counted them. */
    clippedSamples: z.number().int(),
    /** The longest run of consecutive full-scale samples; null until measured. */
    clippedLongestRun: z.number().int().nullable(),
    /** Whether the clipping is enough to flag (clipping.ts). */
    clipped: z.boolean(),
    durationMs: z.number().int(),
    /** vsWakeWord: the phonemes it decoded, and their edit distance from the wake word. */
    decoded: z.string().nullable(),
    editDistance: z.number().nullable(),
    /** microWakeWord and openWakeWord: "immediate" or "confirmed". */
    trigger: z.string().nullable(),
    /** The device's stop word fired rather than its wake word. */
    stopWord: z.boolean(),
    /**
     * The device's settings when the clip was recorded: null when they are
     * not known, because Wakewright did not read them close enough to that
     * moment (clip-settings.ts). The clip's own engine, score and threshold
     * are always the device's.
     */
    sensitivity: z
      .object({
        engine: z.string().nullable(),
        wakeWords: z.array(z.string()).nullable(),
        sensitivity: z.string().nullable(),
        fineTune: z.number().nullable(),
      })
      .nullable(),
    /**
     * The collection session it was recorded in (ADR 0020), with the note
     * the user gave of what they would be doing. The note never votes.
     */
    collectionSession: z
      .object({
        id: z.string(),
        note: z.enum(["wake_word", "not_wake_word", "mixed"]).nullable(),
        startedAt: z.string().nullable(),
      })
      .nullable(),
    judging: ClipJudging,
  })
  .openapi("Clip");

// Dates arrive as ISO instants: the browser turns the user's local day
// boundaries into UTC, so the server needs no time zone.
const Filter = z.object({
  device: z.string().optional(),
  kind: Kind.optional(),
  engine: z.string().max(64).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  outcome: Outcome.optional(),
  mismatch: Mismatch.optional(),
  dissent: z.enum(["1"]).optional().openapi({
    description: "1: only clips where a counted judge voted against the outcome.",
  }),
  session: z.string().max(64).optional().openapi({
    description: "any: clips from any collection session; otherwise one session's id.",
  }),
});

const ListQuery = Filter.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const IdParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const routes = {
  list: createRoute({
    method: "get",
    path: "/clips",
    tags: ["clips"],
    summary: "Clips, newest first, filtered and paged",
    request: { query: ListQuery },
    responses: {
      200: {
        description: "A page of clips",
        content: {
          "application/json": {
            schema: z.object({
              clips: z.array(Clip),
              total: z.number().int(),
              page: z.number().int(),
              pageSize: z.number().int(),
            }),
          },
        },
      },
    },
  }),
  summary: createRoute({
    method: "get",
    path: "/clips/summary",
    tags: ["clips"],
    summary: "Totals for the home screen",
    responses: {
      200: {
        description: "Summary",
        content: {
          "application/json": {
            schema: z.object({
              total: z.number().int(),
              last24h: z.object({ fired: z.number().int(), nearMiss: z.number().int() }),
              lastClipAt: z.string().nullable(),
            }),
          },
        },
      },
    },
  }),
  engines: createRoute({
    method: "get",
    path: "/clips/engines",
    tags: ["clips"],
    summary: "Every wake word engine among the stored clips, for the engine filter",
    responses: {
      200: {
        description: "Engines",
        content: { "application/json": { schema: z.object({ engines: z.array(z.string()) }) } },
      },
    },
  }),
  get: createRoute({
    method: "get",
    path: "/clips/{id}",
    tags: ["clips"],
    summary: "One clip, with the next newer and older clip under the same filter",
    request: { params: IdParam, query: Filter },
    responses: {
      200: {
        description: "The clip",
        content: {
          "application/json": {
            schema: z.object({
              clip: Clip,
              newerId: z.string().nullable(),
              olderId: z.string().nullable(),
              judges: z.object({ results: z.array(JudgeResult), pending: z.array(PendingJudge) }),
            }),
          },
        },
      },
      404: errorContent("No such clip"),
    },
  }),
  audio: createRoute({
    method: "get",
    path: "/clips/{id}/audio",
    tags: ["clips"],
    summary: "The clip's WAV; honours Range and If-None-Match",
    request: { params: IdParam, query: z.object({ download: z.literal("1").optional() }) },
    responses: {
      200: {
        description: "The whole file",
        content: { "audio/wav": { schema: z.string().openapi({ format: "binary" }) } },
      },
      206: {
        description: "Part of the file",
        content: { "audio/wav": { schema: z.string().openapi({ format: "binary" }) } },
      },
      304: { description: "Not modified" },
      404: errorContent("No such clip"),
      416: { description: "Range not satisfiable" },
    },
  }),
};

export function clipRoutes(
  deps: { db: Database; blobs: BlobStore; judging: Judging; judges: Judges },
  guard: MiddlewareHandler<ApiEnv>,
) {
  const { db, blobs, judging, judges } = deps;
  const notFound = { error: "not_found", message: "No such clip." } as const;
  const app = newApi();
  for (const path of ["/clips", "/clips/*"]) app.use(path, guard);

  return app
    .openapi(routes.list, (c) => {
      const q = c.req.valid("query");
      const { rows, total } = listClips(
        db,
        toFilter(q),
        { limit: q.pageSize, offset: (q.page - 1) * q.pageSize },
        judging.context(),
      );
      return c.json({ clips: rows.map(toClip), total, page: q.page, pageSize: q.pageSize }, 200);
    })
    .openapi(routes.summary, (c) => {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      return c.json(clipSummary(db, since), 200);
    })
    .openapi(routes.engines, (c) => c.json({ engines: clipEngines(db) }, 200))
    .openapi(routes.get, (c) => {
      const judged = judging.forClip(c.req.valid("param").id);
      if (!judged) return c.json(notFound, 404);
      const row = judged.clip;
      const { newer, older } = clipNeighbours(
        db,
        row,
        toFilter(c.req.valid("query")),
        judging.context(),
      );
      const types = new Map(judges.types().map((t) => [t.id, t]));
      const about = (id: string) => {
        const i = getInstance(db, id);
        return {
          name: i?.name ?? id,
          type: i?.type ?? id,
          typeName: (i && types.get(i.type)?.name) ?? i?.type ?? id,
          weight: i?.weight ?? 0,
          instance: i,
        };
      };
      const results = judged.results
        .map((r) => {
          const a = about(r.instance_id);
          const i = a.instance;
          const status: "counted" | "not_counted" | "off" | "deleted" =
            !i || i.deleted_at !== null
              ? "deleted"
              : !i.enabled
                ? "off"
                : i.weight > 0
                  ? "counted"
                  : "not_counted";
          return {
            judgeId: r.instance_id,
            name: a.name,
            type: r.type,
            typeName: a.typeName,
            weight: a.weight,
            status,
            current:
              i !== null &&
              r.fingerprint === i.fingerprint &&
              r.version === (types.get(r.type)?.version ?? r.version),
            version: r.version,
            verdict: r.verdict,
            score: r.score,
            threshold: r.threshold,
            transcript: r.transcript,
            detail: r.detail,
            durationMs: r.duration_ms,
            worker: r.worker,
            judgedAt: r.judged_at,
          };
        })
        .sort((a, b) => order(a) - order(b) || b.weight - a.weight || a.name.localeCompare(b.name));
      const pending = judged.pending.map((p) => {
        const a = about(p.instance);
        return {
          judgeId: p.instance,
          name: a.name,
          typeName: a.typeName,
          weight: a.weight,
          reason: p.reason,
        };
      });
      return c.json(
        { clip: toClip(row), newerId: newer, olderId: older, judges: { results, pending } },
        200,
      );
    })
    .openapi(routes.audio, async (c) => {
      const row = getClipRow(db, c.req.valid("param").id);
      if (!row) return c.json(notFound, 404);
      const file = blobs.file(row.audio_sha256);
      const size = file.size;
      const etag = `"sha256:${row.audio_sha256}"`;
      const headers: Record<string, string> = {
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        ETag: etag,
        // Private: household audio must not sit in shared caches. Immutable:
        // a clip's audio never changes.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      };
      if (c.req.valid("query").download) {
        const stamp = row.captured_at.replace(/[:.]/g, "-");
        const device = db
          .query<{ name: string }, [string]>("SELECT name FROM devices WHERE id = ?")
          .get(row.device_id);
        const name = `${device?.name ?? "clip"}-${stamp}.wav`.replace(/[^\w.-]+/g, "_");
        headers["Content-Disposition"] = `attachment; filename="${name}"`;
      }
      if (c.req.header("If-None-Match") === etag) return c.body(null, 304, headers);

      const range = parseRange(c.req.header("Range"), size);
      if (range === "unsatisfiable") {
        return c.body(null, 416, { ...headers, "Content-Range": `bytes */${size}` });
      }
      if (range) {
        const [start, end] = range;
        return c.body(await file.slice(start, end + 1).arrayBuffer(), 206, {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        });
      }
      return c.body(await file.arrayBuffer(), 200, {
        ...headers,
        "Content-Length": String(size),
      });
    });
}

function toFilter(q: z.infer<typeof Filter>): ClipFilter {
  return {
    deviceId: q.device,
    reason: q.kind,
    engine: q.engine,
    from: iso(q.from),
    to: iso(q.to),
    outcome: q.outcome,
    mismatch: q.mismatch,
    dissent: q.dissent === "1",
    session: q.session,
  };
}

// Counted judges first, then those not counted, off, and deleted.
function order(r: { status: "counted" | "not_counted" | "off" | "deleted" }): number {
  return ["counted", "not_counted", "off", "deleted"].indexOf(r.status);
}

// Stored times are UTC with a Z; normalise offsets so text comparison holds.
function iso(value: string | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

/**
 * One `bytes=` range as [start, end] (inclusive), null to send the whole
 * file (no header, or a form we do not serve, such as several ranges), or
 * "unsatisfiable".
 */
export function parseRange(
  header: string | undefined,
  size: number,
): [number, number] | null | "unsatisfiable" {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, first, last] = match;
  if (!first && !last) return null;
  let start: number;
  let end: number;
  if (!first) {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last ? Math.min(Number(last), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "unsatisfiable";
  return [start, end];
}

function toClip(row: ClipListRow): z.infer<typeof Clip> {
  const meta = JSON.parse(row.source_meta_json) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    deviceRemoved: row.device_removed === 1,
    collectionSession: row.collection_session_id
      ? {
          id: row.collection_session_id,
          note: row.session_note,
          startedAt: row.session_started_at,
        }
      : null,
    capturedAt: row.captured_at,
    ingestedAt: row.ingested_at,
    kind: row.capture_reason,
    wakeWord: row.wake_word,
    engine: row.engine,
    score: row.score,
    threshold: row.threshold,
    peakDb: row.peak_db,
    rmsDb: row.rms_db,
    clippedSamples: row.clipped_samples,
    clippedLongestRun: row.clipped_longest_run,
    clipped: isClipped(row.clipped_longest_run),
    durationMs: row.duration_ms,
    decoded: text(meta.decoded),
    editDistance: num(meta.editDistance),
    trigger: text(meta.trigger),
    stopWord: meta.stop === true,
    sensitivity: row.sensitivity_json ? JSON.parse(row.sensitivity_json) : null,
    judging: {
      outcome: row.outcome,
      provisional: row.provisional,
      score: row.judge_score,
      confidence: confidence({ yesWeight: row.yes_weight, noWeight: row.no_weight }),
      yesWeight: row.yes_weight,
      noWeight: row.no_weight,
      yes: row.votes_yes,
      no: row.votes_no,
      abstain: row.votes_abstain,
      dissent: dissent({
        outcome: row.outcome,
        provisional: row.provisional,
        yes: row.votes_yes,
        no: row.votes_no,
      }),
      mismatch: row.mismatch,
    },
  };
}
