// Writes the worker API's OpenAPI document to docs/api/worker-v1.openapi.json
// (`mise run openapi`). The worker's tests read that file, so they need no
// running parent; a parent test fails while the file is out of date.
import { join } from "node:path";
import { workerOpenApiDocument } from "../apps/parent/src/api/worker.ts";

export const WORKER_OPENAPI_PATH = join(
  import.meta.dir,
  "..",
  "docs",
  "api",
  "worker-v1.openapi.json",
);

if (import.meta.main) {
  await Bun.write(WORKER_OPENAPI_PATH, `${JSON.stringify(workerOpenApiDocument(), null, 2)}\n`);
  const fmt = Bun.spawnSync(["bun", "fmt", WORKER_OPENAPI_PATH], {
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = fmt.exitCode;
  console.log(`wrote ${WORKER_OPENAPI_PATH}`);
}
