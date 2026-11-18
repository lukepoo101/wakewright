import { z } from "zod";

// The Kiosk Satellite REST shapes Wakewright reads, written from the app's
// documented API and observed responses. The parent's client parses device
// responses with these, and the fake device (devtools/fake-kiosk) builds its
// responses from them, so the two cannot drift apart silently.
//
// Wakewright only reads from a device: login, health, settings, the wake
// word diagnostics list and clip audio. It never calls a command that
// writes.

/** `POST /api/login`. `ttl_days` asks for a longer-lived token. */
export const LoginRequest = z.object({
  password: z.string(),
  ttl_days: z.number().int().min(1).max(3650).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({ token: z.string().min(1) });
export type LoginResponse = z.infer<typeof LoginResponse>;

/** Body of a 4xx/5xx outside the command envelope (401, 429, ...). */
export const ErrorResponse = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/**
 * `POST /api/commands/<name>` answers `{ ok: true, data }` with 200, or
 * `{ ok: false, error }` with 400.
 */
export function commandResult<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]);
}

/** One saved wake word activation or near miss (wake word diagnostics). */
export const Activation = z.object({
  /** Milliseconds since the epoch, as a string; also the clip's name. */
  id: z.string().regex(/^\d+$/),
  /** Present and true for a near miss: the score reached 75% of the threshold. */
  nearMiss: z.boolean().optional(),
  /** Present and true when the stop word fired rather than a wake word. */
  stop: z.boolean().optional(),
  /** UTC, ISO 8601. */
  at: z.iso.datetime({ offset: true }),
  wakeWord: z.string(),
  engine: z.string(),
  score: z.number().optional(),
  threshold: z.number().optional(),
  /** microWakeWord and openWakeWord: "immediate" or "confirmed". */
  trigger: z.string().optional(),
  /** vsWakeWord: decoded phonemes and their edit distance from the target. */
  decoded: z.string().optional(),
  editDistance: z.number().int().optional(),
  durationMs: z.number().int(),
  /** dBFS; null for a silent clip. */
  peakDb: z.number().nullable(),
  rmsDb: z.number().nullable(),
  /** Number of samples at full scale. */
  clipped: z.number().int(),
});
export type Activation = z.infer<typeof Activation>;

/** `getWakeWordActivations`: newest first; the device keeps 10 of each kind. */
export const ActivationsData = z.object({
  enabled: z.boolean(),
  activations: z.array(Activation),
  nearMisses: z.array(Activation),
});
export type ActivationsData = z.infer<typeof ActivationsData>;

export const ActivationAudioRequest = z.object({ id: z.string() });
export type ActivationAudioRequest = z.infer<typeof ActivationAudioRequest>;

/** `getWakeWordActivationAudio`: a 3 s, 16 kHz mono PCM16 WAV as base64. */
export const ActivationAudioData = z.object({
  mimeType: z.literal("audio/wav"),
  base64: z.base64(),
});
export type ActivationAudioData = z.infer<typeof ActivationAudioData>;

/**
 * `GET /api/health`, the one unauthenticated endpoint. The device reports
 * much more (screen, battery, network, ...); these are the fields Wakewright
 * reads, and unknown fields are ignored.
 */
export const Health = z.looseObject({
  /** The device name set in Kiosk Satellite. */
  name: z.string().optional(),
  appVersion: z.string().optional(),
  /** True when this kiosk leads a fleet. */
  leader: z.boolean(),
  /** Name of the leader this kiosk follows, or null. */
  follows: z.string().nullable(),
  uptime: z.looseObject({ app: z.number(), device: z.number() }),
});
export type Health = z.infer<typeof Health>;

/**
 * One entry of `GET /api/settings`: a setting's definition and its current
 * value. Secret values come back masked. Only the fields Wakewright reads
 * are listed; the device sends more.
 */
export const SettingEntry = z.looseObject({
  key: z.string(),
  type: z.string(),
  title: z.string().optional(),
  value: z.unknown(),
  options: z.array(z.string()).optional(),
  optionLabels: z.record(z.string(), z.string()).optional(),
});
export type SettingEntry = z.infer<typeof SettingEntry>;

/** `GET /api/settings`: every setting definition with its current value. */
export const SettingsResponse = z.looseObject({ settings: z.array(SettingEntry) });
export type SettingsResponse = z.infer<typeof SettingsResponse>;

/** The settings Wakewright reads to show what a device is running. */
export const WakeSettingKeys = {
  diagnostics: "wake_word.diagnostics",
  engine: "voice.wake_word_engine",
  wakeWords: "voice.wake_words",
  sensitivity: "voice.wake_word_sensitivity",
  fineTune: "voice.wake_word_fine_tune",
} as const;
