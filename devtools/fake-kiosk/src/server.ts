import {
  type Activation,
  ActivationAudioRequest,
  type ActivationAudioData,
  type ActivationsData,
  type Health,
  LoginRequest,
  type LoginResponse,
  type SettingEntry,
  SettingsPatchRequest,
  type SettingsPatchResponse,
  type SettingsResponse,
  WakeSettingKeys,
} from "@wakewright/parent/kiosk/shapes";
import { Hono } from "hono";
import { encodeWav, levels, type Signal, synthesize } from "./synth.ts";

// A fake Kiosk Satellite device for development and tests. It implements
// only the read surface Wakewright uses, with responses typed by the same
// shapes the parent's client parses, and behaves like the real app where
// Wakewright depends on it:
//
// - `POST /api/login` checks the password, issues tokens that expire
//   (7 days, or `ttl_days`) and answers 429 after repeated failures.
// - Wake word diagnostics keep the last 10 activations and the last 10 near
//   misses, newest first; older entries roll off. With diagnostics off the
//   lists are empty.
// - `PATCH /api/settings` changes the wake word engine, sensitivity and
//   fine-tune, checked as the device checks them (an option it offers, a
//   number in range), answering the keys it refused; later clips follow
//   the new settings and `GET /api/settings` reports them. Any other key
//   is refused, and every write is recorded in `writes`.
// - Any other /api call fails.
//
// Tests and `mise run dev` drive it through `hear()` and `faults`, or over
// HTTP under /_fake/ (outside the device's API): hear a clip, change the
// settings, expire every token, inject faults.

export const BUFFER_SIZE = 10;
const DAY_MS = 86_400_000;
const MAX_FREE_LOGIN_FAILURES = 5;

export interface FakeKioskOptions {
  /** Shown in /api/health; lets two fakes be told apart. */
  name?: string;
  /** The device password for POST /api/login. */
  password?: string;
  /** Clock for timestamps and token expiry; tests pass a fixed one. */
  now?: () => number;
  /** Clips already saved at start, a minute apart. Default 6. */
  initialClips?: number;
  /** Wake word diagnostics on (default) or off. */
  diagnostics?: boolean;
  /** Seed for the generated clips, so two fakes sound different. */
  seed?: number;
  /** The wake word engine, which sets the score scale. Default vsWakeWord. */
  engine?: Engine;
  /**
   * The wake words in the device's slots, as `voice.wake_words` lists them.
   * Default: the engine's one wake word. A real device can list the same
   * word in both slots.
   */
  wakeWords?: string[];
  /**
   * Older clips already saved at start, recorded under earlier settings (as
   * a device handing over its history when it is added): `count` clips from
   * `engine`, the newest `daysAgo` days old, an hour apart.
   */
  history?: { engine: Engine; count: number; daysAgo: number };
  /** A Kiosk Satellite fleet: this device leads one, or follows the named leader. */
  fleet?: { leader: true } | { follows: string };
  /** Starting sensitivity and fine-tune. Default moderately and 0. */
  sensitivity?: FakeSettings["sensitivity"];
  fineTune?: number;
}

/** The settings a fake device reports; change them with `setSettings`. */
export interface FakeSettings {
  engine: Engine;
  wakeWords: string[];
  sensitivity: "slightly" | "moderately" | "very";
  fineTune: number;
}

/**
 * Engines report scores on their own scales: vsWakeWord a match score
 * against a threshold around 10, microWakeWord a probability (0–1).
 */
export type Engine = "vsWakeWord" | "microWakeWord" | "openWakeWord";
const THRESHOLDS: Record<Engine, number> = {
  vsWakeWord: 10.5,
  microWakeWord: 0.6,
  openWakeWord: 0.5,
};
const WAKE_WORDS: Record<Engine, string> = {
  vsWakeWord: "alexa",
  microWakeWord: "okay_nabu",
  openWakeWord: "alexa",
};
const ENGINE_VALUES: Record<string, Engine> = {
  vswakeword: "vsWakeWord",
  microwakeword: "microWakeWord",
  openwakeword: "openWakeWord",
};
const SENSITIVITIES = ["slightly", "moderately", "very"] as const;

/** Faults to inject; change them at any time. */
export interface Faults {
  /** In-process fetch: every call fails as if nothing listened. */
  offline: boolean;
  /** Delay before every /api answer, in ms. */
  slowMs: number;
  /** `getWakeWordActivations` answers with the wrong shape. */
  malformedList: boolean;
  /** Clip ids whose audio is not a WAV ("*" for every clip). */
  badAudio: Set<string>;
  /** In-process fetch: the next N audio downloads break mid-way. */
  dropAudio: number;
  /** Every /api call answers 503, as a device whose app has stopped answering. */
  down: boolean;
  /** Settings keys `PATCH /api/settings` refuses, as the device refuses a bad value. */
  rejectKeys: Set<string>;
}

interface Clip {
  entry: Activation;
  wav: Uint8Array;
}

export interface FakeKiosk {
  app: Hono;
  /** Calls the fake in-process, honouring `faults.offline`, `dropAudio` and abort signals. */
  fetch: typeof fetch;
  faults: Faults;
  /** The device "hears" a wake word (or a near miss) now; returns the entry. */
  hear(kind?: { nearMiss?: boolean }): Activation;
  /** Every token issued so far stops working, as after a long time or a new secret. */
  expireTokens(): void;
  setDiagnostics(on: boolean): void;
  /** Changes the device's settings, as a user would in the app; later clips follow them. */
  setSettings(change: Partial<FakeSettings>): void;
  /** Requests received, for asserting what the client called. */
  readonly calls: string[];
  /** Every `PATCH /api/settings` body received, in order. */
  readonly writes: Record<string, unknown>[];
  /** The settings now. */
  readonly settings: Readonly<FakeSettings>;
}

export function createFakeKiosk(options: FakeKioskOptions = {}): FakeKiosk {
  const name = options.name ?? "fake-kiosk";
  const password = options.password ?? "dev";
  const now = options.now ?? Date.now;
  const startedAt = now();
  const tokens = new Map<string, number>();
  const calls: string[] = [];
  const faults: Faults = {
    offline: false,
    slowMs: 0,
    malformedList: false,
    badAudio: new Set(),
    dropAudio: 0,
    down: false,
    rejectKeys: new Set(),
  };
  const writes: Record<string, unknown>[] = [];
  let diagnostics = options.diagnostics ?? true;
  let loginFailures = 0;
  let lockedUntil = 0;
  let counter = 0;
  let lastId = 0;
  const activations: Clip[] = [];
  const nearMisses: Clip[] = [];
  const seed = options.seed ?? 1;
  const engine = options.engine ?? "vsWakeWord";
  const current: FakeSettings = {
    engine,
    wakeWords: options.wakeWords ?? [WAKE_WORDS[engine]],
    sensitivity: options.sensitivity ?? "moderately",
    fineTune: options.fineTune ?? 0,
  };

  function makeClip(at: number, nearMiss: boolean, engine = current.engine): Clip {
    // Clips heard now are of the wake word the device listens for.
    const wakeWord =
      engine === current.engine ? (current.wakeWords[0] ?? WAKE_WORDS[engine]) : WAKE_WORDS[engine];
    counter++;
    const id = Math.max(at, lastId + 1);
    lastId = id;
    const signal: Signal = {
      kind: "bursts",
      seed: seed * 1000 + counter,
      syllables: nearMiss ? 2 : 3,
    };
    // Every seventh clip is loud enough to clip, as a close shout would be,
    // and every seventh from the fourth touches full scale at one sample.
    const samples = synthesize(signal, counter % 7 === 0 ? 1.4 : 0.35);
    if (counter % 7 === 4) touchFullScale(samples);
    const threshold = THRESHOLDS[engine];
    // A near miss reaches 75–95% of the threshold. A wake word clears it:
    // a probability by up to the scale's top (1), a vsWakeWord score by up
    // to 60%, and every fifth clip is a strong match at over twice the
    // threshold, as a close, clear voice gives.
    const top = engine !== "vsWakeWord" ? 1 : threshold * (counter % 5 === 0 ? 2.4 : 1.6);
    const score = nearMiss
      ? round(threshold * (0.75 + 0.2 * fraction(counter)))
      : round(threshold + (top - threshold) * (counter % 5 === 0 ? 0.9 : fraction(counter * 3)));
    const entry: Activation = {
      id: String(id),
      ...(nearMiss ? { nearMiss: true } : {}),
      at: new Date(id).toISOString(),
      wakeWord,
      engine,
      score,
      threshold,
      ...(engine === "vsWakeWord"
        ? { decoded: nearMiss ? "ə l ɛ s ə" : "ə l ɛ k s ə", editDistance: nearMiss ? 1 : 0 }
        : { trigger: "immediate" }),
      durationMs: 3000,
      ...levels(samples),
    };
    return { entry, wav: encodeWav(samples) };
  }

  function add(clip: Clip) {
    const list = clip.entry.nearMiss ? nearMisses : activations;
    list.unshift(clip);
    list.length = Math.min(list.length, BUFFER_SIZE);
  }

  // Older clips first, so ids rise with time; every third is a near miss.
  // With diagnostics off the device keeps none.
  const initial = diagnostics ? (options.initialClips ?? 6) : 0;
  const history = diagnostics ? options.history : undefined;
  for (let i = history?.count ?? 0; i >= 1; i--) {
    const at = startedAt - (history?.daysAgo ?? 0) * DAY_MS - (i - 1) * 3_600_000;
    add(makeClip(at, i % 2 === 0, history?.engine));
  }
  for (let i = initial; i >= 1; i--) add(makeClip(startedAt - i * 60_000, i % 3 === 0));

  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    calls.push(`${c.req.method} ${c.req.path}`);
    if (faults.slowMs > 0) await Bun.sleep(faults.slowMs);
    if (faults.down) return c.json({ error: "the fake device is down" }, 503);
    await next();
  });

  app.post("/api/login", async (c) => {
    if (now() < lockedUntil) return c.json({ error: "too many attempts" }, 429);
    const body = LoginRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid JSON" }, 400);
    if (body.data.password !== password) {
      loginFailures++;
      if (loginFailures >= MAX_FREE_LOGIN_FAILURES) lockedUntil = now() + 60_000;
      return c.json({ error: "invalid password" }, 401);
    }
    loginFailures = 0;
    const token = crypto.randomUUID();
    tokens.set(token, now() + (body.data.ttl_days ?? 7) * DAY_MS);
    return c.json({ token } satisfies LoginResponse);
  });

  app.get("/api/health", (c) => {
    const uptime = Math.round((now() - startedAt) / 1000);
    const health: Health = {
      name,
      appVersion: "2026.11.23-fake",
      leader: options.fleet !== undefined && "leader" in options.fleet,
      follows: options.fleet && "follows" in options.fleet ? options.fleet.follows : null,
      uptime: { app: uptime, device: uptime },
    };
    c.header("Access-Control-Allow-Origin", "*");
    return c.json(health);
  });

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const expires = token ? tokens.get(token) : undefined;
    if (expires === undefined || expires <= now()) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/api/settings", (c) =>
    c.json(settings(diagnostics, current) satisfies SettingsResponse),
  );

  // Checked key by key, as the device does: an accepted key is applied even
  // when another in the same body is refused.
  app.patch("/api/settings", async (c) => {
    const body = SettingsPatchRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid JSON" }, 400);
    writes.push({ ...body.data });
    const rejected: string[] = [];
    const errors: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.data)) {
      const problem = faults.rejectKeys.has(key) ? "refused by the fake" : apply(key, value);
      if (problem !== null) {
        rejected.push(key);
        errors[key] = problem;
      }
    }
    return c.json({ ok: rejected.length === 0, rejected, errors } satisfies SettingsPatchResponse);
  });

  app.post("/api/commands/getWakeWordActivations", (c) => {
    if (faults.malformedList) return c.json({ ok: true, data: { activations: "nope" } });
    const data: ActivationsData = {
      enabled: diagnostics,
      activations: activations.map((x) => x.entry),
      nearMisses: nearMisses.map((x) => x.entry),
    };
    return c.json({ ok: true as const, data });
  });

  app.post("/api/commands/getWakeWordActivationAudio", async (c) => {
    const body = ActivationAudioRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false as const, error: "missing id" }, 400);
    const clip = [...activations, ...nearMisses].find((x) => x.entry.id === body.data.id);
    if (!clip) return c.json({ ok: false as const, error: "no such clip" }, 400);
    const bad = faults.badAudio.has("*") || faults.badAudio.has(clip.entry.id);
    const bytes = bad ? new TextEncoder().encode("this is not a wav file") : clip.wav;
    const data: ActivationAudioData = { mimeType: "audio/wav", base64: bytes.toBase64() };
    return c.json({ ok: true as const, data });
  });

  // Everything else, writes included, is not part of the fake.
  app.all("/api/*", (c) => c.json({ error: "not supported by the fake device" }, 404));

  // Controls for tests and development, outside the device's API.
  app.post("/_fake/hear", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { nearMiss?: boolean };
    return c.json(hear(body));
  });
  app.put("/_fake/settings", async (c) => {
    setSettings((await c.req.json().catch(() => ({}))) as Partial<FakeSettings>);
    return c.body(null, 204);
  });
  app.post("/_fake/expire-tokens", (c) => {
    expireTokens();
    return c.body(null, 204);
  });
  app.get("/_fake/settings", (c) => c.json({ ...current, writes }));
  app.put("/_fake/faults", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      slowMs?: number;
      malformedList?: boolean;
      badAudio?: string[];
      diagnostics?: boolean;
      down?: boolean;
      rejectKeys?: string[];
    };
    if (body.down !== undefined) faults.down = body.down;
    if (body.rejectKeys !== undefined) faults.rejectKeys = new Set(body.rejectKeys);
    if (body.slowMs !== undefined) faults.slowMs = body.slowMs;
    if (body.malformedList !== undefined) faults.malformedList = body.malformedList;
    if (body.badAudio !== undefined) faults.badAudio = new Set(body.badAudio);
    if (body.diagnostics !== undefined) setDiagnostics(body.diagnostics);
    return c.body(null, 204);
  });

  function hear(kind: { nearMiss?: boolean } = {}): Activation {
    const clip = makeClip(now(), kind.nearMiss ?? false);
    if (diagnostics) add(clip);
    return clip.entry;
  }

  function setSettings(change: Partial<FakeSettings>) {
    Object.assign(current, change);
  }

  // One key of a settings write; the reason it is refused, or null.
  function apply(key: string, value: unknown): string | null {
    if (key === WakeSettingKeys.engine) {
      const engine = typeof value === "string" ? ENGINE_VALUES[value] : undefined;
      if (!engine) return "not an engine this device offers";
      current.engine = engine;
      return null;
    }
    if (key === WakeSettingKeys.sensitivity) {
      const level = SENSITIVITIES.find((s) => s === value);
      if (!level) return "not one of the options";
      current.sensitivity = level;
      return null;
    }
    if (key === WakeSettingKeys.fineTune) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < -10 || value > 10) {
        return "must be a whole number from -10 to 10";
      }
      current.fineTune = value;
      return null;
    }
    return "this fake device changes only the wake word sensitivity settings";
  }

  function expireTokens() {
    tokens.clear();
  }

  function setDiagnostics(on: boolean) {
    diagnostics = on;
    // Turning diagnostics off deletes the recordings, as on the device.
    if (!on) {
      activations.length = 0;
      nearMisses.length = 0;
    }
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (faults.offline)
      throw new TypeError(`Unable to connect. Is the computer able to access the url?`);
    if (faults.dropAudio > 0 && new URL(request.url).pathname.endsWith("ActivationAudio")) {
      faults.dropAudio--;
      throw new TypeError("The socket connection was closed unexpectedly.");
    }
    const answer = app.fetch(request);
    if (!request.signal) return answer;
    return Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      }),
    ]);
  }) as typeof fetch;

  return {
    app,
    fetch: fakeFetch,
    faults,
    hear,
    expireTokens,
    setDiagnostics,
    setSettings,
    calls,
    writes,
    settings: current,
  };
}

// The few settings Wakewright reads, in the device's shape, plus one it
// does not, as the real list has hundreds.
function settings(diagnostics: boolean, current: FakeSettings): SettingsResponse {
  const entries: SettingEntry[] = [
    {
      key: WakeSettingKeys.diagnostics,
      type: "boolean",
      title: "Enable wake word diagnostics",
      value: diagnostics,
    },
    {
      key: WakeSettingKeys.engine,
      type: "select",
      title: "Wake word engine",
      value: current.engine.toLowerCase(),
      options: ["vswakeword", "microwakeword", "openwakeword"],
      optionLabels: {
        vswakeword: "vsWakeWord",
        microwakeword: "microWakeWord",
        openwakeword: "openWakeWord",
      },
    },
    {
      key: WakeSettingKeys.wakeWords,
      type: "string",
      value: JSON.stringify(current.wakeWords),
    },
    {
      key: WakeSettingKeys.sensitivity,
      type: "select",
      title: "Wake word sensitivity",
      value: current.sensitivity,
      options: ["slightly", "moderately", "very"],
      optionLabels: {
        slightly: "Slightly sensitive",
        moderately: "Moderately sensitive",
        very: "Very sensitive",
      },
    },
    {
      key: WakeSettingKeys.fineTune,
      type: "number",
      title: "Fine-tune sensitivity",
      value: current.fineTune,
      min: -10,
      max: 10,
    },
    { key: "screen.brightness", type: "number", title: "Brightness", value: 80 },
  ];
  return { settings: entries, subpageHints: {} } as SettingsResponse;
}

// Scales a clip so its loudest sample, and only that one, sits at full scale.
function touchFullScale(samples: Int16Array): void {
  let loudest = 0;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i] ?? 0) > Math.abs(samples[loudest] ?? 0)) loudest = i;
  }
  const peak = samples[loudest] ?? 0;
  if (peak === 0) return;
  samples[loudest] = peak > 0 ? 32767 : -32768;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// A repeatable number in [0, 1) from an integer.
function fraction(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
