import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Nightly database backups: `VACUUM INTO <data>/backups/wakewright-YYYYMMDD.sqlite3`,
// keeping the newest KEEP. Audio blobs are immutable and content-addressed,
// so file-level backup tools copy them incrementally; they are not copied
// here.

export const KEEP = 14;
const NAME = /^wakewright-\d{8}\.sqlite3$/;

export function backupDatabase(db: Database, dir: string, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const path = join(dir, `wakewright-${day}.sqlite3`);
  // VACUUM INTO refuses an existing file; a second run on one day replaces it.
  rmSync(path, { force: true });
  db.query("VACUUM INTO ?").run(path);
  const old = readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return path;
}
