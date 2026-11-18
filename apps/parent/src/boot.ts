import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { createApi } from "./api/index.ts";
import { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import type { Logger } from "./log.ts";

export interface Booted {
  db: Database;
  api: ReturnType<typeof createApi>;
  /** Stops background work and closes the database. */
  stop(): Promise<void>;
}

// Start-up shared by the production entry (main.ts) and the development
// entry (dev.ts): open and migrate the database, apply the configured admin
// account, then build the API. Background loops start here, after
// migrations, and stop() ends them.
export async function boot(config: Config, log: Logger): Promise<Booted> {
  const db = openDatabase(config.storage.dbPath);
  const result = migrate(db, { backupDir: join(config.storage.dataDir, "backups") });
  if (result.to !== result.from) log.info("database migrated", { ...result });

  const auth = new Auth({ db, log, managed: config.admin.password !== undefined });
  if (config.admin.password !== undefined) {
    await auth.applyConfiguredAdmin({
      username: config.admin.username,
      password: config.admin.password,
    });
  } else if (auth.state() === "setup") {
    log.info("no admin account yet: open the web UI to create one");
  }

  const api = createApi({ db, auth, publicUrl: config.server.publicUrl });
  return {
    db,
    api,
    async stop() {
      db.close();
    },
  };
}
