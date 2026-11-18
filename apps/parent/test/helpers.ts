import type { Database } from "bun:sqlite";
import { createApi } from "../src/api/index.ts";
import { Auth } from "../src/auth.ts";
import { openDatabase } from "../src/db/db.ts";
import { migrate } from "../src/db/migrate.ts";
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

export function testApi(options: { db?: Database; managed?: boolean; now?: () => number } = {}) {
  const db = options.db ?? migratedDb();
  const auth = new Auth({
    db,
    log: quietLog,
    managed: options.managed ?? false,
    now: options.now,
    hashOptions: FAST_HASH,
  });
  const api = createApi({ db, auth });
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
    db,
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
