import type { Database } from "bun:sqlite";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { BlobStore } from "../blobs.ts";
import {
  type ClipFilter,
  type ClipListRow,
  clipNeighbours,
  clipSummary,
  getClip,
  listClips,
} from "../db/clips.ts";
import { type ApiEnv, errorContent, newApi } from "./common.ts";

// Collected clips: list with filters and paging, one clip with its
// neighbours, its audio (with Range support, for seeking) and a summary
// for the home screen. /api/v1/clips.

const Kind = z.enum(["fired", "near_miss"]);

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
    clippedSamples: z.number().int(),
    durationMs: z.number().int(),
    /** vsWakeWord: the phonemes it decoded, and their edit distance from the wake word. */
    decoded: z.string().nullable(),
    editDistance: z.number().nullable(),
    /** microWakeWord and openWakeWord: "immediate" or "confirmed". */
    trigger: z.string().nullable(),
    /** The device's stop word fired rather than its wake word. */
    stopWord: z.boolean(),
    /** What the device reported running when the clip was collected. */
    sensitivity: z
      .object({
        engine: z.string().nullable(),
        wakeWords: z.array(z.string()).nullable(),
        sensitivity: z.string().nullable(),
        fineTune: z.number().nullable(),
      })
      .nullable(),
  })
  .openapi("Clip");

// Dates arrive as ISO instants: the browser turns the user's local day
// boundaries into UTC, so the server needs no time zone.
const Filter = z.object({
  device: z.string().optional(),
  kind: Kind.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
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
  deps: { db: Database; blobs: BlobStore },
  guard: MiddlewareHandler<ApiEnv>,
) {
  const { db, blobs } = deps;
  const notFound = { error: "not_found", message: "No such clip." } as const;
  const app = newApi();
  for (const path of ["/clips", "/clips/*"]) app.use(path, guard);

  return app
    .openapi(routes.list, (c) => {
      const q = c.req.valid("query");
      const { rows, total } = listClips(db, toFilter(q), {
        limit: q.pageSize,
        offset: (q.page - 1) * q.pageSize,
      });
      return c.json({ clips: rows.map(toClip), total, page: q.page, pageSize: q.pageSize }, 200);
    })
    .openapi(routes.summary, (c) => {
      const since = new Date(Date.now() - 86_400_000).toISOString();
      return c.json(clipSummary(db, since), 200);
    })
    .openapi(routes.get, (c) => {
      const row = getClip(db, c.req.valid("param").id);
      if (!row) return c.json(notFound, 404);
      const { newer, older } = clipNeighbours(db, row, toFilter(c.req.valid("query")));
      return c.json({ clip: toClip(row), newerId: newer, olderId: older }, 200);
    })
    .openapi(routes.audio, async (c) => {
      const row = getClip(db, c.req.valid("param").id);
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
        const name = `${row.device_name}-${stamp}.wav`.replace(/[^\w.-]+/g, "_");
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
  return { deviceId: q.device, reason: q.kind, from: iso(q.from), to: iso(q.to) };
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
    durationMs: row.duration_ms,
    decoded: text(meta.decoded),
    editDistance: num(meta.editDistance),
    trigger: text(meta.trigger),
    stopWord: meta.stop === true,
    sensitivity: row.sensitivity_json ? JSON.parse(row.sensitivity_json) : null,
  };
}
