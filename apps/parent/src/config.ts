import { join, resolve } from "node:path";
import { z } from "zod";

// All configuration comes from WAKEWRIGHT__SECTION__KEY environment
// variables, validated here. Settings a user edits at runtime (devices and
// so on) live in the database, not here.
const Env = z.object({
  WAKEWRIGHT__SERVER__HOST: z.string().min(1).default("0.0.0.0"),
  WAKEWRIGHT__SERVER__PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  WAKEWRIGHT__STORAGE__DATA_DIR: z.string().min(1).default("data"),
  // The built SPA. Defaults to `public/` next to the running bundle, which is
  // where `bun run build` and the image put it.
  WAKEWRIGHT__SERVER__STATIC_DIR: z.string().min(1).optional(),
  WAKEWRIGHT__LOG__LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  server: { host: string; port: number; staticDir: string };
  storage: { dataDir: string; dbPath: string };
  log: { level: "debug" | "info" | "warn" | "error" };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const dataDir = resolve(e.WAKEWRIGHT__STORAGE__DATA_DIR);
  return {
    server: {
      host: e.WAKEWRIGHT__SERVER__HOST,
      port: e.WAKEWRIGHT__SERVER__PORT,
      staticDir: resolve(e.WAKEWRIGHT__SERVER__STATIC_DIR ?? join(import.meta.dir, "public")),
    },
    storage: { dataDir, dbPath: join(dataDir, "db", "wakewright.sqlite3") },
    log: { level: e.WAKEWRIGHT__LOG__LEVEL },
  };
}
