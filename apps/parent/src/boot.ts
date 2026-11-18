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
import { Judges } from "./judges.ts";
import { Judging } from "./judging.ts";
import type { Logger } from "./log.ts";
import { Workers } from "./workers.ts";

export interface Booted {
  db: Database;
  api: ReturnType<typeof createApi>;
  collector: Collector;
  judging: Judging;
  /** Ends waiting worker claims, so the HTTP server can stop without waiting for them. */
  drain(): void;
  /** Stops background work and closes the database. */
  stop(): Promise<void>;
}

// Start-up shared by the production entry (main.ts) and the development
// entry (dev.ts): open and migrate the database, apply the auth mode, the
// configured admin account and the declared workers, build the API, then
// start the collector and the nightly backup.
export async function boot(config: Config, log: Logger): Promise<Booted> {
  const { dataDir } = config.storage;
  const db = openDatabase(config.storage.dbPath);
  const result = migrate(db, { backupDir: join(dataDir, "backups") });
  if (result.to !== result.from) log.info("database migrated", { ...result });

  const mode = config.auth.mode;
  const auth = new Auth({ db, log, managed: config.admin.password !== undefined, mode });
  if (mode === "none") {
    log.warn(
      "sign-in is off (WAKEWRIGHT__AUTH__MODE=none): anyone who can reach this server has " +
        "full access to its clips and devices. Keep the port private and put an " +
        "authenticating reverse proxy in front of it",
    );
  } else if (config.admin.password !== undefined) {
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
  const judges = new Judges({ db, box, log, onChange: () => judging.notify() });
  const judging = new Judging({ db, log, judges });
  const workers = new Workers({ db, log, onChange: () => judging.notify() });
  workers.applyDeclared(config.workers);
  const collector = new Collector({
    db,
    blobs,
    devices,
    log,
    intervalMs: config.collector.intervalMs,
    onStored: () => judging.notify(),
  });

  const api = createApi({
    db,
    auth,
    devices,
    collector,
    judging,
    judges,
    workers,
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

  if (workers.list().length === 0) {
    log.info(
      "no workers yet: add one in the Workers tab, or declare one with WAKEWRIGHT__WORKERS__<NAME>__TOKEN",
    );
  }

  return {
    db,
    api,
    collector,
    judging,
    drain: () => judging.close(),
    async stop() {
      judging.close();
      backups.stop();
      await collector.stop();
      db.close();
    },
  };
}
