import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, schemaVersion } from "../src/db/db.ts";
import { type Migration, migrate, migrations } from "../src/db/migrate.ts";

const migrationsDir = join(import.meta.dir, "../src/db/migrations");

describe("migrations", () => {
  test("every .sql file is listed once, in order, numbered from 1", () => {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(migrations.map((m) => `${m.name}.sql`)).toEqual(files);
    expect(migrations.map((m) => m.version)).toEqual(files.map((_, i) => i + 1));
    for (const m of migrations)
      expect(m.name.startsWith(String(m.version).padStart(4, "0"))).toBe(true);
  });

  test("apply to an empty database, then do nothing on a second run", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db)).toEqual({ from: 0, to: migrations.length, backup: undefined });
    expect(schemaVersion(db)).toBe(migrations.length);
    expect(migrate(db)).toEqual({ from: migrations.length, to: migrations.length });
    const row = db.query<{ instance_id: string }, []>("SELECT instance_id FROM instance").get();
    expect(row?.instance_id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("refuse a schema newer than this build knows", () => {
    const db = openDatabase(":memory:");
    db.run("PRAGMA user_version = 999");
    expect(() => migrate(db)).toThrow(/newer than this build knows/);
  });

  test("back up an existing database before upgrading it", () => {
    const dir = mkdtempSync(join(tmpdir(), "wakewright-migrate-"));
    const db = openDatabase(join(dir, "db.sqlite3"));
    const list: Migration[] = [
      { version: 1, name: "0001_a", sql: "CREATE TABLE a (x INTEGER) STRICT;" },
      {
        version: 2,
        name: "0002_b",
        sql: "CREATE TABLE b (y INTEGER) STRICT; INSERT INTO b VALUES (1);",
      },
    ];
    expect(
      migrate(db, { backupDir: join(dir, "backups"), list: list.slice(0, 1) }).backup,
    ).toBeUndefined();

    const result = migrate(db, { backupDir: join(dir, "backups"), list });
    expect(result).toMatchObject({ from: 1, to: 2 });
    expect(result.backup).toBeString();
    const backup = openDatabase(result.backup as string);
    expect(schemaVersion(backup)).toBe(1);
    expect(db.query("SELECT y FROM b").all()).toEqual([{ y: 1 }]);
  });

  test("roll back a failing migration and leave the version unchanged", () => {
    const db = openDatabase(":memory:");
    const list: Migration[] = [
      {
        version: 1,
        name: "0001_bad",
        sql: "CREATE TABLE c (z INTEGER); INSERT INTO nope VALUES (1);",
      },
    ];
    expect(() => migrate(db, { list })).toThrow();
    expect(schemaVersion(db)).toBe(0);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'c'").all()).toEqual([]);
  });
});

describe("0002: clip settings and clipping", () => {
  // A 0.0.1 database with what the first real devices produced: a device
  // added after it had saved clips, its wake word in both slots, and
  // clips with a few isolated full-scale samples.
  function v1Database() {
    const db = openDatabase(":memory:");
    migrate(db, { list: migrations.slice(0, 1) });
    const settings = JSON.stringify({
      engine: "vsWakeWord",
      wakeWords: ["alexa", "alexa"],
      sensitivity: "Very sensitive",
      fineTune: 3,
    });
    db.run(
      `INSERT INTO devices (id, name, source, config_json, reported_json, created_at, updated_at)
       VALUES ('d1', 'Office', 'kiosk_satellite', '{}', ?, 't', 't')`,
      [JSON.stringify({ engine: "vsWakeWord", wakeWords: ["alexa", "alexa"] })],
    );
    db.run(
      `INSERT INTO blobs (sha256, size, media_type, privacy_class, created_at)
       VALUES ('aa', 1, 'audio/wav', 'audio', 't')`,
    );
    const clip = db.query(
      `INSERT INTO clips (id, device_id, source_ref, audio_sha256, captured_at, ingested_at,
         capture_reason, wake_word, engine, score, threshold, clipped_samples, duration_ms,
         sensitivity_json, source_meta_json)
       VALUES (?, 'd1', ?, 'aa', ?, ?, 'near_miss', 'Alexa', ?, 1, 1, ?, 3000, ?, '{}')`,
    );
    const collected = "2026-11-18T01:26:53.000Z";
    // Handed over when the device was added: recorded days before.
    clip.run("old-micro", "1", "2026-11-08T21:10:42.108Z", collected, "microWakeWord", 0, settings);
    clip.run("old-vs", "2", "2026-11-17T19:02:40.228Z", collected, "vsWakeWord", 25, settings);
    // Collected 10 seconds after it was recorded.
    clip.run("prompt", "3", "2026-11-18T01:26:43.000Z", collected, "vsWakeWord", 1, settings);
    clip.run("no-settings", "4", "2026-11-18T01:26:43.000Z", collected, "vsWakeWord", 0, null);
    return db;
  }

  test("0004 keeps every judge result and its worker's name, and drops reported workers", () => {
    const db = v1Database();
    migrate(db, { list: migrations.slice(0, 3) });
    db.run(
      `INSERT INTO judge_results (clip_id, judge, version, verdict, duration_ms, worker, judged_at)
       VALUES ('prompt', 'stt', 'v1', 'yes', 5, 'old-worker', 't')`,
    );
    db.run(
      `INSERT INTO workers (name, version, judges_json, first_seen_at, last_seen_at)
       VALUES ('old-worker', '0.1.0', '[]', 't', 't')`,
    );
    db.run(
      `INSERT INTO judge_leases (id, clip_id, worker, judges_json, claimed_at, expires_at)
       VALUES ('l1', 'old-vs', 'old-worker', '[]', 't', 't')`,
    );
    migrate(db);
    expect(db.query("SELECT clip_id, worker, verdict FROM judge_results").all()).toEqual([
      { clip_id: "prompt", worker: "old-worker", verdict: "yes" },
    ]);
    expect(db.query("SELECT count(*) AS n FROM workers").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM judge_leases").get()).toEqual({ n: 0 });
  });

  test("keeps only settings read close to the clip, each wake word once, and keeps every clip", () => {
    const db = v1Database();
    migrate(db);
    const rows = db
      .query<
        { id: string; sensitivity_json: string | null; clipped_longest_run: number | null },
        []
      >("SELECT id, sensitivity_json, clipped_longest_run FROM clips ORDER BY id")
      .all()
      .map((r) => ({
        ...r,
        sensitivity_json: r.sensitivity_json && JSON.parse(r.sensitivity_json),
      }));
    expect(rows).toEqual([
      { id: "no-settings", sensitivity_json: null, clipped_longest_run: 0 },
      { id: "old-micro", sensitivity_json: null, clipped_longest_run: 0 },
      // NULL: measured from the audio at start-up (clipping.ts).
      { id: "old-vs", sensitivity_json: null, clipped_longest_run: null },
      {
        id: "prompt",
        sensitivity_json: {
          engine: "vsWakeWord",
          wakeWords: ["alexa"],
          sensitivity: "Very sensitive",
          fineTune: 3,
        },
        clipped_longest_run: null,
      },
    ]);
    const device = db
      .query<{ reported_json: string }, []>("SELECT reported_json FROM devices")
      .get();
    expect(JSON.parse(device?.reported_json ?? "{}").wakeWords).toEqual(["alexa"]);
  });

  test("keeps the slot order when a device has different wake words", () => {
    const db = v1Database();
    db.run(
      `UPDATE devices SET reported_json = '{"wakeWords":["hey_jarvis","alexa","hey_jarvis"]}'`,
    );
    migrate(db);
    const device = db
      .query<{ reported_json: string }, []>("SELECT reported_json FROM devices")
      .get();
    expect(JSON.parse(device?.reported_json ?? "{}").wakeWords).toEqual(["hey_jarvis", "alexa"]);
  });
});
