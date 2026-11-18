// `mise run dev`: the parent's development entry (HMR, data in .dev-data/)
// and two fake Kiosk Satellite devices (password `dev`) that hear a new clip
// every 45 and 70 seconds, with prefixed logs. The kitchen runs vsWakeWord
// and the lounge microWakeWord, so both score scales show. Ctrl-C stops all.
import { join } from "node:path";

const root = join(import.meta.dir, "..");

const processes = [
  {
    name: "parent",
    cmd: ["bun", "--watch", "apps/parent/src/dev.ts"],
    env: { WAKEWRIGHT__STORAGE__DATA_DIR: ".dev-data", WAKEWRIGHT__LOG__LEVEL: "debug" },
  },
  {
    name: "kitchen",
    cmd: [
      "bun",
      "devtools/fake-kiosk/src/main.ts",
      ...["--port", "23241", "--name", "kitchen", "--seed", "1", "--every", "45"],
    ],
  },
  {
    name: "lounge",
    cmd: [
      "bun",
      "devtools/fake-kiosk/src/main.ts",
      ...["--port", "23242", "--name", "lounge", "--seed", "2", "--every", "70"],
      ...["--engine", "microWakeWord"],
    ],
  },
];

async function pipe(prefix: string, stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const bytes of stream) {
    const lines = (pending + decoder.decode(bytes, { stream: true })).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) out.write(`${prefix} ${line}\n`);
  }
  if (pending) out.write(`${prefix} ${pending}\n`);
}

const width = Math.max(...processes.map((p) => p.name.length));
const children = processes.map((p) => {
  const child = Bun.spawn(p.cmd, {
    cwd: root,
    env: { ...process.env, ...p.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const prefix = `[${p.name.padEnd(width)}]`;
  void pipe(prefix, child.stdout, process.stdout);
  void pipe(prefix, child.stderr, process.stderr);
  return child;
});

const stop = () => {
  for (const child of children) child.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// If any process exits, stop the rest and exit with its code.
const code = await Promise.race(children.map((c) => c.exited));
stop();
process.exit(code);
