// `mise run integration`: the real parent and the real Python worker loop,
// together, without downloading a model.
//
// Starts a fake Kiosk Satellite and the parent from source (sign-in off,
// a worker token, a throwaway data directory), adds the device, waits for
// its clips, then runs `wakewright-worker run --once --fake-judges` from
// apps/worker: the worker's own claim, download, judge and post code, with
// judges that load no model. Passes when every clip has all three judges'
// results and the worker shows as connected. Needs Bun, and uv with
// apps/worker synced (`mise run setup`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Free ports, so it can run beside `mise run dev` or another run.
function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = probe;
  probe.stop(true);
  return port;
}
const PARENT_PORT = freePort();
const KIOSK_PORT = freePort();
const CLIPS = 4;
/** Not a secret: only this throwaway parent and worker share it. */
const TOKEN = "integration-worker-token-not-secret";
const parentUrl = `http://127.0.0.1:${PARENT_PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "wakewright-integration-"));

const children: Bun.Subprocess[] = [];
function start(cmd: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(cmd, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  return child;
}

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${parentUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin: parentUrl, ...init?.headers },
  });
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Judging {
  waiting: number;
  judged: number;
  workers: { name: string; connected: boolean; judges: { name: string; version: string }[] }[];
}

try {
  start([
    "bun",
    "devtools/fake-kiosk/src/main.ts",
    ...["--port", String(KIOSK_PORT), "--name", "integration-kiosk", "--initial", String(CLIPS)],
  ]);
  start(["bun", "apps/parent/src/main.ts", "serve"], {
    WAKEWRIGHT__STORAGE__DATA_DIR: dataDir,
    WAKEWRIGHT__SERVER__HOST: "127.0.0.1",
    WAKEWRIGHT__SERVER__PORT: String(PARENT_PORT),
    WAKEWRIGHT__AUTH__MODE: "none",
    WAKEWRIGHT__WORKER__TOKEN: TOKEN,
  });
  await waitFor("the parent", async () =>
    (await fetch(`${parentUrl}/readyz`)).ok ? true : undefined,
  );
  await waitFor("the fake device", async () =>
    (await fetch(`http://127.0.0.1:${KIOSK_PORT}/api/health`)).ok ? true : undefined,
  );
  await api("/api/v1/devices", {
    method: "POST",
    body: JSON.stringify({
      name: "Integration",
      baseUrl: `http://127.0.0.1:${KIOSK_PORT}`,
      password: "dev",
    }),
  });
  const clips = await waitFor("the device's clips", async () => {
    const { clips } = await api<{ clips: { id: string }[] }>("/api/v1/clips?pageSize=100");
    return clips.length >= CLIPS ? clips : undefined;
  });
  console.log(`integration: ${clips.length} clips collected; running the worker`);

  const worker = Bun.spawn(
    ["uv", "run", "--frozen", "wakewright-worker", "run", "--once", "--fake-judges"],
    {
      cwd: join(root, "apps", "worker"),
      env: {
        ...process.env,
        WAKEWRIGHT_WORKER__PARENT_URL: parentUrl,
        WAKEWRIGHT_WORKER__TOKEN: TOKEN,
        WAKEWRIGHT_WORKER__NAME: "integration-worker",
        WAKEWRIGHT_WORKER__BATCH: "32",
        WAKEWRIGHT_WORKER__WAIT_SECONDS: "5",
        WAKEWRIGHT_WORKER__CACHE_DIR: join(dataDir, "worker-cache"),
        WAKEWRIGHT_WORKER__LOG_FORMAT: "text",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const code = await worker.exited;
  if (code !== 0) throw new Error(`the worker exited with ${code}`);

  const judging = await api<Judging>("/api/v1/judging");
  const seen = judging.workers.find((w) => w.name === "integration-worker");
  if (!seen?.connected) throw new Error("the parent does not show the worker as connected");
  const judges = seen.judges.map((j) => `${j.name}@${j.version}`).sort();
  if (judges.join(" ") !== "microwakeword@fake+1 openwakeword@fake+1 stt@fake+1")
    throw new Error(`unexpected judges: ${judges.join(" ")}`);
  if (judging.waiting !== 0 || judging.judged < clips.length)
    throw new Error(`clips left unjudged: ${JSON.stringify(judging)}`);
  console.log(
    `integration: passed: ${judging.judged} clips judged by ${judges.length} judges, none waiting`,
  );
} finally {
  for (const child of children) child.kill();
  await Promise.all(children.map((c) => c.exited));
  rmSync(dataDir, { recursive: true, force: true });
}
