#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { runFakeWorker } from "./worker.ts";

// Usage: bun devtools/fake-worker/src/main.ts [--parent http://127.0.0.1:8080]
//   [--token TOKEN] [--name fake-worker] [--delay-ms 300]
//
// The same settings can come from the worker's environment variables:
// WAKEWRIGHT_WORKER__PARENT_URL, WAKEWRIGHT_WORKER__TOKEN, WAKEWRIGHT_WORKER__NAME.
const { values } = parseArgs({
  options: {
    parent: {
      type: "string",
      default: process.env.WAKEWRIGHT_WORKER__PARENT_URL ?? "http://127.0.0.1:8080",
    },
    token: { type: "string", default: process.env.WAKEWRIGHT_WORKER__TOKEN },
    name: { type: "string", default: process.env.WAKEWRIGHT_WORKER__NAME ?? "fake-worker" },
    "delay-ms": { type: "string", default: "300" },
  },
});

if (!values.token) {
  console.error("Set --token or WAKEWRIGHT_WORKER__TOKEN to the parent's worker token.");
  process.exit(2);
}

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
console.log(`fake worker "${values.name}" judging clips from ${values.parent}`);
await runFakeWorker({
  parentUrl: values.parent,
  token: values.token,
  name: values.name,
  delayMs: Number(values["delay-ms"]),
  signal: controller.signal,
  log: (message) => console.log(message),
});
