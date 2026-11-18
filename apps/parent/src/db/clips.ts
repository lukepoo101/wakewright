import type { Database } from "bun:sqlite";

// Clips and the blobs holding their audio.

export type ClipRow = {
  id: string;
  device_id: string;
  source_ref: string;
  audio_sha256: string;
  captured_at: string;
  ingested_at: string;
  capture_reason: "fired" | "near_miss";
  wake_word: string;
  engine: string;
  score: number | null;
  threshold: number | null;
  peak_db: number | null;
  rms_db: number | null;
  clipped_samples: number;
  duration_ms: number;
  sensitivity_json: string | null;
  source_meta_json: string;
};

export function clipExists(db: Database, deviceId: string, sourceRef: string): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT count(*) AS n FROM clips WHERE device_id = ? AND source_ref = ?",
      )
      .get(deviceId, sourceRef)?.n !== 0
  );
}

/**
 * Records a clip and its audio blob in one transaction. Returns false when
 * the device already had a clip with this source_ref (nothing changes).
 */
export function insertClip(
  db: Database,
  clip: ClipRow,
  blob: { size: number; mediaType: string },
): boolean {
  return db.transaction(() => {
    db.query(
      `INSERT INTO blobs (sha256, size, media_type, privacy_class, created_at)
       VALUES (?, ?, ?, 'audio', ?) ON CONFLICT DO NOTHING`,
    ).run(clip.audio_sha256, blob.size, blob.mediaType, clip.ingested_at);
    const result = db
      .query(
        `INSERT INTO clips (id, device_id, source_ref, audio_sha256, captured_at, ingested_at,
           capture_reason, wake_word, engine, score, threshold, peak_db, rms_db,
           clipped_samples, duration_ms, sensitivity_json, source_meta_json)
         VALUES ($id, $device_id, $source_ref, $audio_sha256, $captured_at, $ingested_at,
           $capture_reason, $wake_word, $engine, $score, $threshold, $peak_db, $rms_db,
           $clipped_samples, $duration_ms, $sensitivity_json, $source_meta_json)
         ON CONFLICT (device_id, source_ref) DO NOTHING`,
      )
      .run(clip);
    return result.changes === 1;
  })();
}

export interface ClipFilter {
  deviceId?: string;
  reason?: "fired" | "near_miss";
  /** Inclusive lower bound on captured_at (ISO). */
  from?: string;
  /** Exclusive upper bound on captured_at (ISO). */
  to?: string;
}

export type ClipListRow = ClipRow & { device_name: string; device_removed: number };

// Builds the WHERE clause for a filter. Values are always bound, never
// interpolated.
function where(filter: ClipFilter): { sql: string; params: Record<string, string> } {
  const parts: string[] = [];
  const params: Record<string, string> = {};
  if (filter.deviceId) {
    parts.push("c.device_id = $deviceId");
    params.deviceId = filter.deviceId;
  }
  if (filter.reason) {
    parts.push("c.capture_reason = $reason");
    params.reason = filter.reason;
  }
  if (filter.from) {
    parts.push("c.captured_at >= $from");
    params.from = filter.from;
  }
  if (filter.to) {
    parts.push("c.captured_at < $to");
    params.to = filter.to;
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

const SELECT_CLIP = `
  SELECT c.*, d.name AS device_name, (d.removed_at IS NOT NULL) AS device_removed
  FROM clips c JOIN devices d ON d.id = c.device_id`;

/** Newest first, then by id so equal times have a stable order. */
export function listClips(
  db: Database,
  filter: ClipFilter,
  page: { limit: number; offset: number },
): { rows: ClipListRow[]; total: number } {
  const w = where(filter);
  const total =
    db
      .query<{ n: number }, Record<string, string>>(`SELECT count(*) AS n FROM clips c ${w.sql}`)
      .get(w.params)?.n ?? 0;
  const rows = db
    .query<ClipListRow, Record<string, string | number>>(
      `${SELECT_CLIP} ${w.sql} ORDER BY c.captured_at DESC, c.id DESC LIMIT $limit OFFSET $offset`,
    )
    .all({ ...w.params, limit: page.limit, offset: page.offset });
  return { rows, total };
}

export function getClip(db: Database, id: string): ClipListRow | null {
  return db.query<ClipListRow, [string]>(`${SELECT_CLIP} WHERE c.id = ?`).get(id);
}

/** The clips just newer and just older than `clip` within the same filter. */
export function clipNeighbours(
  db: Database,
  clip: ClipRow,
  filter: ClipFilter,
): { newer: string | null; older: string | null } {
  const w = where(filter);
  const and = w.sql ? `${w.sql} AND` : "WHERE";
  const params = { ...w.params, at: clip.captured_at, id: clip.id };
  const newer = db
    .query<{ id: string }, Record<string, string>>(
      `SELECT c.id FROM clips c ${and} (c.captured_at > $at OR (c.captured_at = $at AND c.id > $id))
       ORDER BY c.captured_at ASC, c.id ASC LIMIT 1`,
    )
    .get(params);
  const older = db
    .query<{ id: string }, Record<string, string>>(
      `SELECT c.id FROM clips c ${and} (c.captured_at < $at OR (c.captured_at = $at AND c.id < $id))
       ORDER BY c.captured_at DESC, c.id DESC LIMIT 1`,
    )
    .get(params);
  return { newer: newer?.id ?? null, older: older?.id ?? null };
}

export interface ClipSummary {
  total: number;
  last24h: { fired: number; nearMiss: number };
  lastClipAt: string | null;
}

export function clipSummary(db: Database, since: string): ClipSummary {
  const row = db
    .query<
      { total: number; fired: number | null; near: number | null; last: string | null },
      [string]
    >(
      `SELECT count(*) AS total,
         sum(captured_at >= ?1 AND capture_reason = 'fired') AS fired,
         sum(captured_at >= ?1 AND capture_reason = 'near_miss') AS near,
         max(captured_at) AS last
       FROM clips`,
    )
    .get(since);
  return {
    total: row?.total ?? 0,
    last24h: { fired: row?.fired ?? 0, nearMiss: row?.near ?? 0 },
    lastClipAt: row?.last ?? null,
  };
}
