// Starts the production build (dist/main.js) with a fresh data directory
// that is removed on exit. Used by playwright.config.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "wakewright-e2e-"));
const child = Bun.spawn(["bun", join(import.meta.dir, "../../dist/main.js"), "serve"], {
  env: { ...process.env, WAKEWRIGHT__STORAGE__DATA_DIR: dataDir },
  stdout: "inherit",
  stderr: "inherit",
});
const stop = () => child.kill();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const code = await child.exited;
rmSync(dataDir, { recursive: true, force: true });
process.exit(code);
