import {
  type Activation,
  ActivationAudioRequest,
  type ActivationAudioData,
  type ActivationsData,
  type Health,
  LoginRequest,
  type LoginResponse,
} from "@wakewright/parent/kiosk/shapes";
import { Hono } from "hono";
import { encodeWav, levels, type Signal, synthesize } from "./synth.ts";

// A fake Kiosk Satellite device for development and tests. It implements
// only the read surface Wakewright uses, with responses typed by the same
// shapes the parent's client parses. Any other command fails.

export interface FakeKioskOptions {
  /** Shown in /api/health; lets two fakes be told apart. */
  name?: string;
  /** The device password for POST /api/login. */
  password?: string;
  /** Clock for activation timestamps; tests pass a fixed one. */
  now?: () => number;
}

interface Clip {
  entry: Activation;
  wav: Uint8Array;
}

// Four activations and two near misses, newest first, a minute apart.
const SIGNALS: { signal: Signal; nearMiss: boolean; score: number }[] = [
  { signal: { kind: "tone", hz: 440 }, nearMiss: false, score: 0.97 },
  { signal: { kind: "chirp", fromHz: 300, toHz: 1200 }, nearMiss: false, score: 0.91 },
  { signal: { kind: "noise", seed: 1 }, nearMiss: true, score: 0.62 },
  { signal: { kind: "tone", hz: 660 }, nearMiss: false, score: 0.88 },
  { signal: { kind: "noise", seed: 2 }, nearMiss: true, score: 0.58 },
  { signal: { kind: "chirp", fromHz: 1000, toHz: 250 }, nearMiss: false, score: 0.84 },
];

export function createFakeKiosk(options: FakeKioskOptions = {}) {
  const name = options.name ?? "fake-kiosk";
  const password = options.password ?? "dev";
  const now = options.now ?? Date.now;
  const startedAt = now();
  const tokens = new Set<string>();

  const clips: Clip[] = SIGNALS.map(({ signal, nearMiss, score }, i) => {
    const samples = synthesize(signal);
    const at = startedAt - (i + 1) * 60_000;
    const entry: Activation = {
      id: String(at),
      ...(nearMiss ? { nearMiss: true } : {}),
      at: new Date(at).toISOString(),
      wakeWord: "test_tone",
      engine: "openWakeWord",
      score,
      threshold: 0.8,
      trigger: "immediate",
      durationMs: 3000,
      ...levels(samples),
    };
    return { entry, wav: encodeWav(samples) };
  });

  const app = new Hono();

  app.post("/api/login", async (c) => {
    const body = LoginRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid JSON" }, 400);
    if (body.data.password !== password) return c.json({ error: "invalid password" }, 401);
    const token = crypto.randomUUID();
    tokens.add(token);
    return c.json({ token } satisfies LoginResponse);
  });

  app.get("/api/health", (c) => {
    const uptime = Math.round((now() - startedAt) / 1000);
    const health: Health = {
      name,
      leader: false,
      follows: null,
      uptime: { app: uptime, device: uptime },
    };
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(health);
  });

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    if (!token || !tokens.has(token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.post("/api/commands/getWakeWordActivations", (c) => {
    const data: ActivationsData = {
      enabled: true,
      activations: clips.filter((x) => !x.entry.nearMiss).map((x) => x.entry),
      nearMisses: clips.filter((x) => x.entry.nearMiss).map((x) => x.entry),
    };
    return c.json({ ok: true as const, data });
  });

  app.post("/api/commands/getWakeWordActivationAudio", async (c) => {
    const body = ActivationAudioRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false as const, error: "missing id" }, 400);
    const clip = clips.find((x) => x.entry.id === body.data.id);
    if (!clip) return c.json({ ok: false as const, error: "no such clip" }, 400);
    const data: ActivationAudioData = { mimeType: "audio/wav", base64: clip.wav.toBase64() };
    return c.json({ ok: true as const, data });
  });

  // Everything else, writes included, is not part of the fake.
  app.all("/api/*", (c) => c.json({ error: "not supported by the fake device" }, 404));

  return app;
}
