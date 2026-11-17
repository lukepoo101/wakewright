#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createFakeKiosk } from "./server.ts";

// Usage: bun devtools/fake-kiosk/src/main.ts [--port 23241] [--name kitchen] [--password dev]
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "23241" },
    name: { type: "string", default: "fake-kiosk" },
    password: { type: "string", default: "dev" },
  },
});

const app = createFakeKiosk({ name: values.name, password: values.password });
const server = Bun.serve({ port: Number(values.port), fetch: app.fetch });
console.log(`fake Kiosk Satellite "${values.name}" listening on ${server.url.href}`);
