import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

// All configuration comes from WAKEWRIGHT__SECTION__KEY environment
// variables, validated here. Settings a user edits at runtime (devices and
// so on) live in the database, not here. docs/configuration.md lists every
// variable; keep the two in step.
//
// A secret can be given directly or, better, as a path in the matching
// `_FILE` variable (a Docker or Kubernetes secret). Setting both is an error.

const MIN_PASSWORD_LENGTH = 12;
const MIN_WORKER_TOKEN_LENGTH = 16;

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
  // The token workers send to /api/worker/v1. Unset: judging is off and the
  // worker API answers 404.
  WAKEWRIGHT__WORKER__TOKEN: z.string().optional(),
  WAKEWRIGHT__WORKER__TOKEN_FILE: z.string().min(1).optional(),
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
  /** The shared worker token; undefined while judging is not set up. */
  worker: { token?: string };
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
  const workerToken = secret(e, "WAKEWRIGHT__WORKER__TOKEN");
  if (workerToken !== undefined && workerToken.trim().length < MIN_WORKER_TOKEN_LENGTH) {
    throw new Error(
      `Invalid configuration: WAKEWRIGHT__WORKER__TOKEN must be at least ${MIN_WORKER_TOKEN_LENGTH} characters, ` +
        "for example the output of `openssl rand -base64 32`",
    );
  }

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
    worker: { token: workerToken?.trim() },
  };
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
  name: "WAKEWRIGHT__ADMIN__PASSWORD" | "WAKEWRIGHT__SECRET_KEY" | "WAKEWRIGHT__WORKER__TOKEN",
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
