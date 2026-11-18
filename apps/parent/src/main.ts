import { join } from "node:path";
import { Hono } from "hono";
import { logger as requestLogger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { boot } from "./boot.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/db.ts";
import { migrate } from "./db/migrate.ts";
import { createLogger } from "./log.ts";
import { mountSpa } from "./spa.ts";
import { version } from "./version.ts";

// Production entry: `bun main.js [serve|migrate|healthcheck]`.
// It never imports the SPA's HTML; it serves the static build instead.

const config = loadConfig();
const log = createLogger(config.log.level);
const command = process.argv[2] ?? "serve";

switch (command) {
  case "serve":
    await serve();
    break;
  case "migrate": {
    const db = openDatabase(config.storage.dbPath);
    log.info("migrate", {
      ...migrate(db, { backupDir: join(config.storage.dataDir, "backups") }),
    });
    db.close();
    break;
  }
  case "healthcheck":
    process.exitCode = await healthcheck();
    break;
  default:
    console.error(`Unknown command "${command}". Use serve, migrate or healthcheck.`);
    process.exitCode = 2;
}

async function serve() {
  const booted = await boot(config, log);
  const app = new Hono();
  app.use(requestLogger((line) => log.debug(line)));
  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // wavesurfer.js renders into a shadow root with its own <style>.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        mediaSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
      },
    }),
  );
  app.route("/", booted.api);
  if (!mountSpa(app, config.server.staticDir)) {
    log.warn("no SPA build found; serving the API only", { staticDir: config.server.staticDir });
  }

  const server = Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    fetch: app.fetch,
  });
  log.info("listening", { version, url: server.url.href });

  const stop = async (signal: string) => {
    log.info("stopping", { signal });
    booted.drain();
    await server.stop();
    await booted.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

// For the image's HEALTHCHECK: the distroless base has no curl.
async function healthcheck(): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.server.port}/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? 0 : 1;
  } catch {
    return 1;
  }
}
