import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/bun";

const API_PATHS = /^\/(api\/|healthz$|readyz$)/;

// Serves the built SPA (`bun run build:web`) from staticDir on the same
// origin as the API. Hashed assets are cached for a year; index.html is
// revalidated on every load and answers every other GET so client-side
// routes work on reload.
export function mountSpa(app: Hono, staticDir: string): boolean {
  const index = join(staticDir, "index.html");
  if (!existsSync(index)) return false;

  app.use(
    "/*",
    serveStatic({
      root: staticDir,
      onFound: (path, c) => {
        c.header(
          "Cache-Control",
          path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
        );
      },
    }),
  );
  app.get("*", async (c, next) => {
    if (API_PATHS.test(c.req.path)) return next();
    c.header("Cache-Control", "no-cache");
    return c.html(await Bun.file(index).text());
  });
  return true;
}
