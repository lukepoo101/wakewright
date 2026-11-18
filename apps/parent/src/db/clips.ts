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
