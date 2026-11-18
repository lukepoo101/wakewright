import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api/index.ts";
import { Auth } from "../src/auth.ts";
import { BlobStore } from "../src/blobs.ts";
import type { AuthMode } from "../src/config.ts";
import { SecretBox } from "../src/crypto.ts";
import { openDatabase } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
import { Devices } from "../src/devices.ts";
import { Collector } from "../src/ingest.ts";
import { Judging } from "../src/judging.ts";
import { createLogger, type Logger } from "../src/log.ts";

// Shared test set-up: an in-memory migrated database, a silent logger and
// an API whose requests look like they come from the SPA.

// Cheap argon2id parameters: Bun's defaults take about 300 ms a hash.
export const FAST_HASH = { algorithm: "argon2id", memoryCost: 1024, timeCost: 1 } as const;

export const quietLog: Logger = createLogger("error", {}, () => {});

export function migratedDb(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

export const ORIGIN = "http://localhost";

export function tempDir(prefix = "wakewright-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const TEST_KEY = new Uint8Array(32).fill(42);

export interface Parts {
  db: Database;
  blobs: BlobStore;
  devices: Devices;
  collector: Collector;
  judging: Judging;
  dataDir: string;
}

/**
 * The parent's collection pieces on a temporary data directory, talking to
 * devices through `fetchImpl` (usually a fake device's in-process fetch).
 */
export async function testParts(
  options: {
    db?: Database;
    dataDir?: string;
    fetch?: typeof fetch;
    now?: () => number;
    workerToken?: string;
  } = {},
): Promise<Parts> {
  const db = options.db ?? migratedDb();
  const dataDir = options.dataDir ?? tempDir();
  const blobs = new BlobStore(dataDir);
  blobs.init();
  const devices = new Devices(db, await SecretBox.create(TEST_KEY), {
    fetch: options.fetch ?? fetch,
    timeoutMs: 2000,
  });
  const judging = new Judging({
    db,
    log: quietLog,
    configured: options.workerToken !== undefined,
    now: options.now,
  });
  const collector = new Collector({
    db,
    blobs,
    devices,
    log: quietLog,
    intervalMs: 10_000,
    now: options.now,
    onStored: () => judging.notify(),
  });
  return { db, blobs, devices, collector, judging, dataDir };
}

export async function testApi(
  options: {
    db?: Database;
    managed?: boolean;
    mode?: AuthMode;
    now?: () => number;
    fetch?: typeof fetch;
    workerToken?: string;
  } = {},
) {
  const parts = await testParts(options);
  const { db } = parts;
  const auth = new Auth({
    db,
    log: quietLog,
    managed: options.managed ?? false,
    mode: options.mode,
    now: options.now,
    hashOptions: FAST_HASH,
  });
  const api = createApi({ ...parts, auth, intervalMs: 10_000, workerToken: options.workerToken });
  let cookie: string | undefined;

  // A tiny browser: same-origin headers and a cookie jar of one.
  async function request(path: string, init: { method?: string; json?: unknown } = {}) {
    const headers = new Headers({ "Sec-Fetch-Site": "same-origin", Origin: ORIGIN });
    if (init.json !== undefined) headers.set("Content-Type", "application/json");
    if (cookie) headers.set("Cookie", cookie);
    const res = await api.request(`${ORIGIN}${path}`, {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
    const set = res.headers.get("Set-Cookie");
    if (set) {
      const pair = set.split(";")[0] ?? "";
      cookie = /=\s*$/.test(pair) || /Max-Age=0/i.test(set) ? undefined : pair;
    }
    return res;
  }

  async function setUp(username = "admin", password = "correct horse battery") {
    const res = await request("/api/v1/setup", { json: { username, password } });
    if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  }

  return {
    ...parts,
    auth,
    api,
    request,
    setUp,
    get cookie() {
      return cookie;
    },
    signOutLocally() {
      cookie = undefined;
    },
  };
}
