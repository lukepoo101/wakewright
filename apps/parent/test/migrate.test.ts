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
