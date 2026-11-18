import index from "../../web/index.html";
import { boot } from "./boot.ts";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";

// Development entry: the same API, plus the SPA through Bun's HTML import
// with hot module reloading. No separate dev server or proxy. Production
// (main.ts) never imports the HTML and serves the static build instead.

const config = loadConfig();
const log = createLogger(config.log.level);
const { api } = await boot(config, log);

const server = Bun.serve({
  hostname: config.server.host,
  port: config.server.port,
  development: true,
  routes: {
    "/api/*": (req, server) => api.fetch(req, server),
    "/healthz": (req, server) => api.fetch(req, server),
    "/readyz": (req, server) => api.fetch(req, server),
    "/*": index,
  },
});
log.info("development server listening", { url: server.url.href });
