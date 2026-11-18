import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

// All configuration comes from WAKEWRIGHT__SECTION__KEY environment
// variables, validated here. Settings a user edits at runtime (devices,
// workers created in the UI and so on) live in the database, not here. docs/configuration.md lists every
// variable; keep the two in step.
//
// A secret can be given directly or, better, as a path in the matching
// `_FILE` variable (a Docker or Kubernetes secret). Setting both is an error.

const MIN_PASSWORD_LENGTH = 12;
export const MIN_WORKER_TOKEN_LENGTH = 16;

const Env = z.object({
  WAKEWRIGHT__SERVER__HOST: z.string().min(1).default("0.0.0.0"),
  WAKEWRIGHT__SERVER__PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  // The address users open, e.g. https://wakewright.example.lan. Optional:
  // when it is https, session cookies are marked Secure, and its origin is
  // accepted for state-changing requests behind a reverse proxy.
  WAKEWRIGHT__SERVER__PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
  // The built SPA. Defaults to `public/` next to the running bundle, which is
  // where `bun run build` and the image put it.
  WAKEWRIGHT__SERVER__STATIC_DIR: z.string().min(1).optional(),
  WAKEWRIGHT__STORAGE__DATA_DIR: z.string().min(1).default("data"),
  WAKEWRIGHT__LOG__LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // `local`: the built-in admin account and sign-in. `none`: no sign-in at
  // all, for deployments where a reverse proxy authenticates every request.
  WAKEWRIGHT__AUTH__MODE: z.enum(["local", "none"]).default("local"),
  WAKEWRIGHT__ADMIN__USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, "1–64 letters, digits, dots, dashes or underscores")
    .default("admin"),
  WAKEWRIGHT__ADMIN__PASSWORD: z.string().optional(),
  WAKEWRIGHT__ADMIN__PASSWORD_FILE: z.string().min(1).optional(),
  // How often each device is polled, and how long one device call may take.
  WAKEWRIGHT__COLLECTOR__INTERVAL_SECONDS: z.coerce.number().min(1).max(3600).default(10),
  WAKEWRIGHT__COLLECTOR__TIMEOUT_SECONDS: z.coerce.number().min(1).max(120).default(10),
  WAKEWRIGHT__SECRET_KEY: z.string().optional(),
  WAKEWRIGHT__SECRET_KEY_FILE: z.string().min(1).optional(),
  // Declared workers, WAKEWRIGHT__WORKERS__<NAME>__<FIELD>, are read by
  // declaredWorkers() below: their names are not known in advance.
});

export type AuthMode = "local" | "none";

export interface Config {
  server: { host: string; port: number; staticDir: string; publicUrl?: URL };
  storage: { dataDir: string; dbPath: string };
  log: { level: "debug" | "info" | "warn" | "error" };
  /**
   * "local": the admin account and its sessions guard the UI and API.
   * "none": nothing does; whatever is in front of the server must.
   */
  auth: { mode: AuthMode };
  collector: { intervalMs: number; timeoutMs: number };
  admin: {
    username: string;
    /** Set when the admin password is managed by configuration. */
    password?: string;
  };
  /**
   * The 32-byte key that encrypts stored device passwords, or undefined to
   * use (and on first start create) `<data dir>/secret.key`.
   */
  secretKey?: Uint8Array;
  /**
   * Workers declared in configuration (WAKEWRIGHT__WORKERS__<NAME>__*),
   * applied on every start. Workers created in the UI live in the database.
   */
  workers: DeclaredWorker[];
}

/** A worker set by configuration: read-only in the UI, applied on every start. */
export interface DeclaredWorker {
  /** From the variable's <NAME>: lower case, underscores as dashes. */
  name: string;
  token: string;
  notes: string;
  enabled: boolean;
  /** The judges it may run, or null for every judge. */
  judges: string[] | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const dataDir = resolve(e.WAKEWRIGHT__STORAGE__DATA_DIR);

  const password = secret(e, "WAKEWRIGHT__ADMIN__PASSWORD");
  if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Invalid configuration: WAKEWRIGHT__ADMIN__PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  // A password with sign-in off would protect nothing; refuse it rather than
  // let someone believe it does.
  if (e.WAKEWRIGHT__AUTH__MODE === "none" && password !== undefined) {
    throw new Error(
      "Invalid configuration: WAKEWRIGHT__ADMIN__PASSWORD(_FILE) has no effect when " +
        "WAKEWRIGHT__AUTH__MODE is none; remove it, or use WAKEWRIGHT__AUTH__MODE=local",
    );
  }
  const key = secret(e, "WAKEWRIGHT__SECRET_KEY");
  // 0.2.0 replaced the shared token with a token per worker. Say what to
  // do instead of starting with judging silently broken.
  for (const old of ["WAKEWRIGHT__WORKER__TOKEN", "WAKEWRIGHT__WORKER__TOKEN_FILE"]) {
    if (env[old] !== undefined) {
      throw new Error(
        `Invalid configuration: ${old} was removed in Wakewright 0.2.0, which gives each worker ` +
          `its own token. Declare the worker instead, keeping its token: rename ${old} to ` +
          `${old.replace("WAKEWRIGHT__WORKER__", "WAKEWRIGHT__WORKERS__<NAME>__")} (for example ` +
          `${old.replace("WAKEWRIGHT__WORKER__", "WAKEWRIGHT__WORKERS__MY_WORKER__")}), or remove it ` +
          "and create the worker in the Workers tab. See docs/configuration.md#workers",
      );
    }
  }
  const workers = declaredWorkers(env);

  return {
    server: {
      host: e.WAKEWRIGHT__SERVER__HOST,
      port: e.WAKEWRIGHT__SERVER__PORT,
      staticDir: resolve(e.WAKEWRIGHT__SERVER__STATIC_DIR ?? join(import.meta.dir, "public")),
      publicUrl: e.WAKEWRIGHT__SERVER__PUBLIC_URL
        ? new URL(e.WAKEWRIGHT__SERVER__PUBLIC_URL)
        : undefined,
    },
    storage: { dataDir, dbPath: join(dataDir, "db", "wakewright.sqlite3") },
    log: { level: e.WAKEWRIGHT__LOG__LEVEL },
    auth: { mode: e.WAKEWRIGHT__AUTH__MODE },
    collector: {
      intervalMs: e.WAKEWRIGHT__COLLECTOR__INTERVAL_SECONDS * 1000,
      timeoutMs: e.WAKEWRIGHT__COLLECTOR__TIMEOUT_SECONDS * 1000,
    },
    admin: { username: e.WAKEWRIGHT__ADMIN__USERNAME, password },
    secretKey: key === undefined ? undefined : parseSecretKey(key, "WAKEWRIGHT__SECRET_KEY"),
    workers,
  };
}

const WORKER_VAR =
  /^WAKEWRIGHT__WORKERS__([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)__(TOKEN|TOKEN_FILE|JUDGES|NOTES|ENABLED)$/;
const JUDGE_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * Workers declared as WAKEWRIGHT__WORKERS__<NAME>__TOKEN (or __TOKEN_FILE),
 * with optional __JUDGES (comma-separated, or "all"), __NOTES and
 * __ENABLED (true or false). <NAME> becomes the worker's name in lower
 * case with underscores as dashes: CLUSTER_WORKER is "cluster-worker".
 * A declared token is accepted as given (at least 16 characters).
 */
export function declaredWorkers(env: Record<string, string | undefined>): DeclaredWorker[] {
  const fields = new Map<string, Map<string, string>>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("WAKEWRIGHT__WORKERS__") || value === undefined) continue;
    const match = WORKER_VAR.exec(key);
    if (!match) {
      throw new Error(
        `Invalid configuration: ${key} is not a worker setting. Use ` +
          "WAKEWRIGHT__WORKERS__<NAME>__TOKEN, __TOKEN_FILE, __JUDGES, __NOTES or __ENABLED, " +
          "where <NAME> is letters and digits joined by single underscores",
      );
    }
    const name = (match[1] as string).toLowerCase().replaceAll("_", "-");
    const field = match[2] as string;
    const own = fields.get(name) ?? new Map<string, string>();
    if (own.has(`${field}:key`)) {
      throw new Error(
        `Invalid configuration: ${key} and ${own.get(`${field}:key`)} both set worker ${name}'s ${field}`,
      );
    }
    own.set(field, value);
    own.set(`${field}:key`, key);
    fields.set(name, own);
  }

  const workers: DeclaredWorker[] = [];
  const tokens = new Map<string, string>();
  for (const [name, f] of [...fields].sort(([a], [b]) => a.localeCompare(b))) {
    const at = (field: string) => f.get(`${field}:key`) ?? field;
    if (name.length > 64) {
      throw new Error(
        `Invalid configuration: ${at("TOKEN")}: a worker name is at most 64 characters`,
      );
    }
    const direct = f.get("TOKEN");
    const file = f.get("TOKEN_FILE");
    if (direct !== undefined && file !== undefined) {
      throw new Error(`Invalid configuration: set ${at("TOKEN")} or ${at("TOKEN_FILE")}, not both`);
    }
    let token = direct;
    if (file !== undefined) {
      try {
        token = readFileSync(file, "utf8").replace(/\r?\n$/, "");
      } catch (error) {
        throw new Error(
          `Invalid configuration: cannot read ${at("TOKEN_FILE")} (${file}): ${(error as Error).message}`,
        );
      }
    }
    token = token?.trim();
    if (!token) {
      throw new Error(
        `Invalid configuration: worker ${name} needs a token: set ` +
          `WAKEWRIGHT__WORKERS__${name.toUpperCase().replaceAll("-", "_")}__TOKEN or __TOKEN_FILE`,
      );
    }
    if (token.length < MIN_WORKER_TOKEN_LENGTH) {
      throw new Error(
        `Invalid configuration: worker ${name}'s token must be at least ${MIN_WORKER_TOKEN_LENGTH} ` +
          "characters, for example the output of `openssl rand -base64 32`",
      );
    }
    const clash = tokens.get(token);
    if (clash !== undefined) {
      throw new Error(
        `Invalid configuration: workers ${clash} and ${name} have the same token; give each its own`,
      );
    }
    tokens.set(token, name);

    let judges: string[] | null = null;
    const rawJudges = f.get("JUDGES")?.trim();
    if (rawJudges && rawJudges.toLowerCase() !== "all") {
      judges = [...new Set(rawJudges.split(",").map((j) => j.trim().toLowerCase()))].filter(
        Boolean,
      );
      const bad = judges.filter((j) => !JUDGE_NAME.test(j));
      if (judges.length === 0 || bad.length > 0) {
        throw new Error(
          `Invalid configuration: ${at("JUDGES")} must be "all" or judge names separated by ` +
            `commas, such as openwakeword,microwakeword,stt; got ${JSON.stringify(rawJudges)}`,
        );
      }
      judges.sort();
    }

    const rawEnabled = f.get("ENABLED")?.trim().toLowerCase();
    let enabled = true;
    if (rawEnabled !== undefined && rawEnabled !== "") {
      if (!["true", "false"].includes(rawEnabled)) {
        throw new Error(`Invalid configuration: ${at("ENABLED")} must be true or false`);
      }
      enabled = rawEnabled === "true";
    }

    const notes = f.get("NOTES")?.trim() ?? "";
    if (notes.length > 500) {
      throw new Error(`Invalid configuration: ${at("NOTES")} is at most 500 characters`);
    }
    workers.push({ name, token, notes, enabled, judges });
  }
  return workers;
}

export { MIN_PASSWORD_LENGTH };

/** A 32-byte key written as base64 (`openssl rand -base64 32`). */
export function parseSecretKey(text: string, name: string): Uint8Array {
  let bytes: Uint8Array | undefined;
  try {
    bytes = Uint8Array.fromBase64(text.trim());
  } catch {
    bytes = undefined;
  }
  if (bytes?.length !== 32) {
    throw new Error(
      `Invalid configuration: ${name} must be 32 bytes written as base64, ` +
        "for example the output of `openssl rand -base64 32`",
    );
  }
  return bytes;
}

// Reads NAME or NAME_FILE. A file's trailing newline is dropped, because
// `echo` and most editors add one.
function secret(
  e: Partial<Record<string, unknown>>,
  name: "WAKEWRIGHT__ADMIN__PASSWORD" | "WAKEWRIGHT__SECRET_KEY",
): string | undefined {
  const direct = e[name] as string | undefined;
  const file = e[`${name}_FILE`] as string | undefined;
  if (direct !== undefined && file !== undefined) {
    throw new Error(`Invalid configuration: set ${name} or ${name}_FILE, not both`);
  }
  if (file === undefined) return direct === "" ? undefined : direct;
  try {
    return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } catch (error) {
    throw new Error(
      `Invalid configuration: cannot read ${name}_FILE (${file}): ${(error as Error).message}`,
    );
  }
}
