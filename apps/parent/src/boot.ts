import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { createApi } from "./api/index.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import type { Logger } from "./log.ts";

// Start-up shared by the production entry (main.ts) and the development
// entry (dev.ts): open and migrate the database, then build the API.
// Background loops (the ingest poller, the backup cron) start here too once
// they exist, after migrations, and stop on SIGTERM.
export function boot(
  config: Config,
  log: Logger,
): { db: Database; api: ReturnType<typeof createApi> } {
  const db = openDatabase(config.storage.dbPath);
  const result = migrate(db, { backupDir: join(config.storage.dataDir, "backups") });
  if (result.to !== result.from) log.info("database migrated", { ...result });
  return { db, api: createApi({ db }) };
}
