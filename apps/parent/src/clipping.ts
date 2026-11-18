import type { Database } from "bun:sqlite";
import type { BlobStore } from "./blobs.ts";
import type { Logger } from "./log.ts";
import { checkClipWav, type WavInfo } from "./wav.ts";

// Measuring clipping in a clip's audio. The rule for when a clip counts
// as clipped is in clipping-rule.ts, shared with the web UI.

/** The longest run of consecutive full-scale samples in a clip's PCM16 data. */
export function longestFullScaleRun(bytes: Uint8Array, wav: WavInfo): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + wav.dataOffset, wav.dataBytes);
  let longest = 0;
  let run = 0;
  for (let at = 0; at + 1 < wav.dataBytes; at += 2) {
    const sample = view.getInt16(at, true);
    if (sample === 32767 || sample === -32768) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Measures clips stored before Wakewright measured clipping runs itself
 * (0.0.1). Migration 0002 marks them with a NULL run when the device
 * counted any full-scale samples; this reads each one's audio once.
 */
export async function measureUnmeasuredClips(
  db: Database,
  blobs: BlobStore,
  log: Logger,
): Promise<number> {
  const rows = db
    .query<{ id: string; audio_sha256: string }, []>(
      "SELECT id, audio_sha256 FROM clips WHERE clipped_longest_run IS NULL",
    )
    .all();
  const update = db.query("UPDATE clips SET clipped_longest_run = ? WHERE id = ?");
  let measured = 0;
  for (const row of rows) {
    try {
      const bytes = await blobs.file(row.audio_sha256).bytes();
      update.run(longestFullScaleRun(bytes, checkClipWav(bytes)), row.id);
      measured++;
    } catch (error) {
      log.warn("could not measure a clip's clipping", {
        clip_id: row.id,
        error: (error as Error).message,
      });
    }
  }
  if (measured > 0) log.info("measured clipping of earlier clips", { measured });
  return measured;
}
