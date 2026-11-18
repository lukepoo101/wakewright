import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { createApi } from "./api/index.ts";
import { Auth } from "./auth.ts";
import { backupDatabase } from "./backup.ts";
import { BlobStore } from "./blobs.ts";
import { measureUnmeasuredClips } from "./clipping.ts";
import type { Config } from "./config.ts";
import { loadSecretKey, SecretBox } from "./crypto.ts";
import { openDatabase } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { Devices } from "./devices.ts";
import { Collector } from "./ingest.ts";
import type { Logger } from "./log.ts";

export interface Booted {
  db: Database;
  api: ReturnType<typeof createApi>;
  collector: Collector;
  /** Stops background work and closes the database. */
  stop(): Promise<void>;
}

// Start-up shared by the production entry (main.ts) and the development
// entry (dev.ts): open and migrate the database, apply the configured admin
// account, build the API, then start the collector and the nightly backup.
export async function boot(config: Config, log: Logger): Promise<Booted> {
  const { dataDir } = config.storage;
  const db = openDatabase(config.storage.dbPath);
  const result = migrate(db, { backupDir: join(dataDir, "backups") });
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

  const blobs = new BlobStore(dataDir);
  blobs.init();
  await measureUnmeasuredClips(db, blobs, log);
  const box = await SecretBox.create(loadSecretKey(config.secretKey, dataDir, log));
  const devices = new Devices(db, box, { fetch, timeoutMs: config.collector.timeoutMs });
  const collector = new Collector({
    db,
    blobs,
    devices,
    log,
    intervalMs: config.collector.intervalMs,
  });

  const api = createApi({
    db,
    auth,
    devices,
    collector,
    blobs,
    intervalMs: config.collector.intervalMs,
    publicUrl: config.server.publicUrl,
  });

  collector.start();
  const backups = Bun.cron("30 3 * * *", () => {
    try {
      const path = backupDatabase(db, join(dataDir, "backups"));
      log.info("backed up the database", { path });
    } catch (error) {
      log.error("database backup failed", { error: (error as Error).message });
    }
  });

  return {
    db,
    api,
    collector,
    async stop() {
      backups.stop();
      await collector.stop();
      db.close();
    },
  };
}
