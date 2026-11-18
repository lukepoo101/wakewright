#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { decodePairing } from "../../../apps/parent/src/pairing.ts";
import { runFakeWorker } from "./worker.ts";

// Usage: bun devtools/fake-worker/src/main.ts [--parent http://127.0.0.1:8080]
//   [--token TOKEN | --pairing STRING] [--name fake-worker] [--delay-ms 300]
//
// The same settings can come from the worker's environment variables:
// WAKEWRIGHT_WORKER__PARENT_URL, WAKEWRIGHT_WORKER__TOKEN,
// WAKEWRIGHT_WORKER__PAIRING, WAKEWRIGHT_WORKER__NAME. A pairing string
// holds the address and the token; --parent overrides its address.
const { values } = parseArgs({
  options: {
    parent: { type: "string", default: process.env.WAKEWRIGHT_WORKER__PARENT_URL },
    token: { type: "string", default: process.env.WAKEWRIGHT_WORKER__TOKEN },
    pairing: { type: "string", default: process.env.WAKEWRIGHT_WORKER__PAIRING },
    name: { type: "string", default: process.env.WAKEWRIGHT_WORKER__NAME ?? "fake-worker" },
    "delay-ms": { type: "string", default: "300" },
  },
});

let parent = values.parent;
let token = values.token;
if (values.pairing) {
  if (token) {
    console.error("Give a token or a pairing string, not both.");
    process.exit(2);
  }
  try {
    const pairing = decodePairing(values.pairing);
    parent ??= pairing.url;
    token = pairing.token;
  } catch (error) {
    console.error(`Cannot use the pairing string: ${(error as Error).message}.`);
    process.exit(2);
  }
}
if (!token) {
  console.error(
    "Set --pairing or --token (or WAKEWRIGHT_WORKER__PAIRING or __TOKEN): this worker's token, from the parent's Workers tab.",
  );
  process.exit(2);
}
parent ??= "http://127.0.0.1:8080";

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
console.log(`fake worker "${values.name}" judging clips from ${parent}`);
await runFakeWorker({
  parentUrl: parent,
  token,
  name: values.name,
  delayMs: Number(values["delay-ms"]),
  signal: controller.signal,
  log: (message) => console.log(message),
});
