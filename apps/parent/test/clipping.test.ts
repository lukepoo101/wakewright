import { describe, expect, test } from "bun:test";
import { encodeWav, synthesize } from "@wakewright/fake-kiosk/synth";
import { BlobStore } from "../src/blobs.ts";
import { longestFullScaleRun, measureUnmeasuredClips } from "../src/clipping.ts";
import { isClipped } from "../src/clipping-rule.ts";
import { checkClipWav } from "../src/wav.ts";
import { migratedDb, quietLog, tempDir } from "./helpers.ts";

// A quiet tone with full-scale samples written in at the given places.
function clipWith(fullScaleAt: number[], value = 32767): Uint8Array {
  const samples = synthesize({ kind: "tone", hz: 440 }, 0.2);
  for (const at of fullScaleAt) samples[at] = value;
  return encodeWav(samples);
}

const run = (bytes: Uint8Array) => longestFullScaleRun(bytes, checkClipWav(bytes));

describe("clipping", () => {
  test("measures the longest run of consecutive full-scale samples, either sign", () => {
    expect(run(clipWith([]))).toBe(0);
    expect(run(clipWith([1000]))).toBe(1);
    expect(run(clipWith([10, 20, 30, 40, 50]))).toBe(1);
    expect(run(clipWith([100, 101, 500, 501, 502]))).toBe(3);
    expect(run(clipWith([7, 8, 9, 10], -32768))).toBe(4);
    // One below full scale is not full scale.
    expect(run(clipWith([7, 8, 9], 32766))).toBe(0);
  });

  test("a clip counts as clipped from a run of three full-scale samples", () => {
    expect(isClipped(null)).toBe(false);
    expect(isClipped(0)).toBe(false);
    expect(isClipped(1)).toBe(false);
    expect(isClipped(2)).toBe(false);
    expect(isClipped(3)).toBe(true);
    expect(isClipped(40)).toBe(true);
  });

  test("earlier clips are measured from their stored audio, once", async () => {
    const db = migratedDb();
    const blobs = new BlobStore(tempDir());
    blobs.init();
    db.run(
      `INSERT INTO devices (id, name, source, config_json, created_at, updated_at)
       VALUES ('d1', 'Office', 'kiosk_satellite', '{}', 't', 't')`,
    );
    const insert = db.query(
      `INSERT INTO blobs (sha256, size, media_type, privacy_class, created_at)
       VALUES (?, 1, 'audio/wav', 'audio', 't')`,
    );
    const clip = db.query(
      `INSERT INTO clips (id, device_id, source_ref, audio_sha256, captured_at, ingested_at,
         capture_reason, wake_word, engine, clipped_samples, clipped_longest_run, duration_ms,
         source_meta_json)
       VALUES (?, 'd1', ?, ?, 't', 't', 'fired', 'alexa', 'vsWakeWord', ?, ?, 3000, '{}')`,
    );
    const isolated = await blobs.put(clipWith([10, 20]));
    const flattened = await blobs.put(clipWith([10, 11, 12, 13]));
    insert.run(isolated.sha256);
    insert.run(flattened.sha256);
    clip.run("a", "1", isolated.sha256, 2, null);
    clip.run("b", "2", flattened.sha256, 4, null);
    clip.run("c", "3", isolated.sha256, 2, 2);
    insert.run("f".repeat(64));
    clip.run("missing", "4", "f".repeat(64), 1, null);

    expect(await measureUnmeasuredClips(db, blobs, quietLog)).toBe(2);
    expect(db.query("SELECT id, clipped_longest_run AS run FROM clips ORDER BY id").all()).toEqual([
      { id: "a", run: 1 },
      { id: "b", run: 4 },
      // Already measured: left alone.
      { id: "c", run: 2 },
      // Its audio is missing: logged, left unmeasured, never flagged.
      { id: "missing", run: null },
    ]);
    expect(await measureUnmeasuredClips(db, blobs, quietLog)).toBe(0);
  });
});
