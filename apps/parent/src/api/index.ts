import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { csrf } from "hono/csrf";
import type { Auth } from "../auth.ts";
import type { BlobStore } from "../blobs.ts";
import type { Devices } from "../devices.ts";
import type { Collector } from "../ingest.ts";
import type { Judges } from "../judges.ts";
import type { Judging } from "../judging.ts";
import { version } from "../version.ts";
import type { CollectionSessions } from "../sessions.ts";
import { clipRoutes } from "./clips.ts";
import { collectionSessionRoutes } from "./collection-sessions.ts";
import { type CookiePolicy, newApi, requireUser } from "./common.ts";
import { deviceRoutes } from "./devices.ts";
import { healthRoutes } from "./health.ts";
import { judgeRoutes } from "./judges.ts";
import { judgingRoutes } from "./judging.ts";
import { sessionRoutes } from "./session.ts";
import { WORKER_AUTH, WORKER_BASE, workerRoutes, workerSecurityScheme } from "./worker.ts";
import { workerAdminRoutes } from "./workers.ts";
import type { Workers } from "../workers.ts";

export interface ApiDeps {
  db: Database;
  auth: Auth;
  devices: Devices;
  blobs: BlobStore;
  collector: Collector;
  judging: Judging;
  judges: Judges;
  workers: Workers;
  sessions: CollectionSessions;
  /** The collector's poll interval, shown in the UI. */
  intervalMs: number;
  /** The configured public address, if any (WAKEWRIGHT__SERVER__PUBLIC_URL). */
  publicUrl?: URL;
}

// The parent's HTTP API. Each area is a sub-app in its own file, mounted
// here with `.route()` so that AppType carries every route's types to the
// SPA's typed client (`hc<AppType>`). The UI's API lives under /api/v1.
export function createApi(deps: ApiDeps) {
  const policy: CookiePolicy = { forceSecure: deps.publicUrl?.protocol === "https:" };

  // Cross-site request forgery: the session cookie is SameSite=Lax, every
  // request body must be JSON, and a cross-origin JSON request needs a CORS
  // preflight, which this server never grants. A state-changing request
  // that a plain HTML form could send (form or text content type, or no
  // body) must also come from this origin, as the browser reports in
  // Sec-Fetch-Site or Origin.
  const app = newApi();
  app.use("/api/*", csrf({ origin: (origin, c) => sameOrigin(origin, c, deps.publicUrl) }));
  const routes = app
    .route("/", healthRoutes(deps.db))
    .route("/api/v1", sessionRoutes(deps.auth, policy))
    .route("/api/v1", deviceRoutes(deps, requireUser(deps.auth, policy)))
    .route("/api/v1", collectionSessionRoutes(deps, requireUser(deps.auth, policy)))
    .route("/api/v1", clipRoutes(deps, requireUser(deps.auth, policy)))
    .route("/api/v1", judgingRoutes(deps.judging, requireUser(deps.auth, policy)))
    .route("/api/v1", judgeRoutes(deps, requireUser(deps.auth, policy)))
    .route("/api/v1", workerAdminRoutes(deps, requireUser(deps.auth, policy)))
    .route(WORKER_BASE, workerRoutes(deps));

  app.openAPIRegistry.registerComponent("securitySchemes", WORKER_AUTH, workerSecurityScheme);
  app.doc31("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Wakewright", version },
  });

  // Unknown API paths answer JSON, never the SPA's index.html.
  app.all("/api/*", (c) => c.json({ error: "not_found", message: "No such API path." }, 404));

  return routes;
}

export type AppType = ReturnType<typeof createApi>;

// The request's own origin, the configured public origin, or (behind a
// reverse proxy that keeps the Host header) an origin with the same host.
function sameOrigin(origin: string, c: Context, publicUrl: URL | undefined): boolean {
  if (origin === new URL(c.req.url).origin) return true;
  if (publicUrl && origin === publicUrl.origin) return true;
  const host = c.req.header("host");
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    return false;
  }
}
