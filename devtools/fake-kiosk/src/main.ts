#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { createFakeKiosk } from "./server.ts";

// Usage: bun devtools/fake-kiosk/src/main.ts [--port 23241] [--host 127.0.0.1]
//   [--name kitchen] [--password dev] [--every 60] [--initial 6] [--seed 1]
//   [--diagnostics off] [--engine vsWakeWord|microWakeWord]
//   [--wake-words alexa,alexa] [--history microWakeWord:8:10]
//   [--fleet leader|follows:NAME]
//
// --wake-words lists the wake word slots (a real device may repeat one).
// --history ENGINE:COUNT:DAYS starts with COUNT older clips from another
// engine, the newest DAYS days old, as a device handing over its history.
// --every N makes the device "hear" a clip every N seconds (every third a
// near miss), so new clips keep arriving and the buffer rolls over.
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "23241" },
    host: { type: "string", default: "127.0.0.1" },
    name: { type: "string", default: "fake-kiosk" },
    password: { type: "string", default: "dev" },
    every: { type: "string" },
    initial: { type: "string", default: "6" },
    seed: { type: "string", default: "1" },
    diagnostics: { type: "string", default: "on" },
    engine: { type: "string", default: "vsWakeWord" },
    "wake-words": { type: "string" },
    history: { type: "string" },
    fleet: { type: "string" },
  },
});

const engineOf = (text: string | undefined) =>
  text === "microWakeWord" || text === "openWakeWord" ? text : "vsWakeWord";
const fleet = values.fleet?.startsWith("follows:")
  ? { follows: values.fleet.slice("follows:".length) }
  : values.fleet === "leader"
    ? { leader: true as const }
    : undefined;
const [historyEngine, historyCount, historyDays] = values.history?.split(":") ?? [];

const fake = createFakeKiosk({
  name: values.name,
  password: values.password,
  initialClips: Number(values.initial),
  seed: Number(values.seed),
  diagnostics: values.diagnostics !== "off",
  engine: engineOf(values.engine),
  wakeWords: values["wake-words"]?.split(","),
  fleet,
  history: values.history
    ? {
        engine: engineOf(historyEngine),
        count: Number(historyCount),
        daysAgo: Number(historyDays),
      }
    : undefined,
});
const server = Bun.serve({
  hostname: values.host,
  port: Number(values.port),
  fetch: fake.app.fetch,
});
console.log(`fake Kiosk Satellite "${values.name}" listening on ${server.url.href}`);

if (values.every) {
  let n = 0;
  setInterval(
    () => {
      const entry = fake.hear({ nearMiss: ++n % 3 === 0 });
      console.log(`heard ${entry.nearMiss ? "a near miss" : "a wake word"} (${entry.id})`);
    },
    Number(values.every) * 1000,
  );
}
