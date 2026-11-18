import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { schemaVersion } from "./db.ts";
// Migrations are imported as text so they are bundled into the server build;
// add each new file here. A test checks this list against the directory.
import m0001 from "./migrations/0001_init.sql" with { type: "text" };
import m0002 from "./migrations/0002_clip_settings_and_clipping.sql" with { type: "text" };
import m0003 from "./migrations/0003_judging.sql" with { type: "text" };

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  { version: 1, name: "0001_init", sql: m0001 },
  { version: 2, name: "0002_clip_settings_and_clipping", sql: m0002 },
  { version: 3, name: "0003_judging", sql: m0003 },
];

export interface MigrateResult {
  from: number;
  to: number;
  backup?: string;
}

// Applies pending migrations in order, one transaction each, tracked by
// PRAGMA user_version. Forward only. Before changing an existing schema it
// writes a `VACUUM INTO` copy to backupDir, and it refuses to touch a schema
// newer than this build knows.
export function migrate(
  db: Database,
  options: { backupDir?: string; list?: readonly Migration[] } = {},
): MigrateResult {
  const list = options.list ?? migrations;
  const from = schemaVersion(db);
  const latest = list.at(-1)?.version ?? 0;
  if (from > latest) {
    throw new Error(
      `Database schema version ${from} is newer than this build knows (${latest}). ` +
        "Run a newer Wakewright or restore a backup.",
    );
  }
  const pending = list.filter((m) => m.version > from);
  if (pending.length === 0) return { from, to: from };

  let backup: string | undefined;
  if (from > 0 && options.backupDir) {
    mkdirSync(options.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = join(options.backupDir, `pre-migrate-v${from}-${stamp}.sqlite3`);
    db.query("VACUUM INTO ?").run(backup);
  }

  for (const m of pending) {
    db.transaction(() => {
      db.run(m.sql);
      db.run(`PRAGMA user_version = ${m.version}`);
    })();
  }
  return { from, to: latest, backup };
}
