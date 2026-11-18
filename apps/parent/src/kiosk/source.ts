import { z } from "zod";
import {
  type ClipEntry,
  type PollResult,
  type ReportedState,
  type Source,
  type SourceConnection,
  SourceError,
} from "../source.ts";
import { KioskClient } from "./client.ts";
import { type Activation, type SettingEntry, WakeSettingKeys } from "./shapes.ts";

// The Kiosk Satellite source. A device keeps its last 10 activations and
// last 10 near misses ("wake word diagnostics"), newest first; each poll
// lists them all, and the collector stores the ones it has not seen. The
// cursor is the newest id seen of each kind, used only to notice when the
// device's buffer rolled over between polls (a gap).

/** Entries the device keeps of each kind. */
export const KIOSK_BUFFER_SIZE = 10;
export const KIOSK_DEFAULT_PORT = 2324;

/**
 * Turns what a user types into a base URL: `10.0.0.5` or `portal.lan`
 * becomes `http://10.0.0.5:2324`; a full URL is kept as typed, minus any
 * trailing slash. Paths, queries and credentials are refused.
 */
export function normaliseBaseUrl(input: string): string {
  const text = input.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  const url = new URL(hasScheme ? text : `http://${text}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Use an http:// or https:// address.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Give only the device's address and port, with no path.");
  }
  if (!hasScheme && !url.port) url.port = String(KIOSK_DEFAULT_PORT);
  return url.origin;
}

export const KioskConfig = z.object({
  baseUrl: z.string().transform((value, ctx) => {
    try {
      return normaliseBaseUrl(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }),
});
export type KioskConfig = z.infer<typeof KioskConfig>;

const Cursor = z.object({ activations: z.string(), nearMisses: z.string() }).partial();
type Cursor = z.infer<typeof Cursor>;

export const kioskSource: Source<KioskConfig> = {
  id: "kiosk_satellite",
  label: "Kiosk Satellite",
  configSchema: KioskConfig,
  connect(device, options) {
    return new KioskConnection(new KioskClient(device.config.baseUrl, device.password, options));
  },
};

class KioskConnection implements SourceConnection {
  constructor(private readonly client: KioskClient) {}

  async readState(): Promise<ReportedState> {
    const health = await this.client.health();
    const { settings } = await this.client.settings();
    const byKey = new Map(settings.map((s) => [s.key, s]));
    const get = (key: string) => byKey.get(key);
    const engine = get(WakeSettingKeys.engine);
    const sensitivity = get(WakeSettingKeys.sensitivity);
    const diagnostics = get(WakeSettingKeys.diagnostics)?.value;
    const fineTune = get(WakeSettingKeys.fineTune)?.value;
    return {
      name: health.name ?? null,
      appVersion: health.appVersion ?? null,
      diagnosticsEnabled: typeof diagnostics === "boolean" ? diagnostics : null,
      engine: label(engine),
      wakeWords: wakeWords(get(WakeSettingKeys.wakeWords)?.value),
      sensitivity: label(sensitivity),
      fineTune: typeof fineTune === "number" ? fineTune : null,
      leader: health.leader,
      follows: health.follows,
    };
  }

  async poll(cursor: unknown): Promise<PollResult> {
    const data = await this.client.activations();
    const previous: Cursor = Cursor.safeParse(cursor).data ?? {};
    const gap =
      overflowed(data.activations, previous.activations) ||
      overflowed(data.nearMisses, previous.nearMisses);
    const entries = [...data.activations, ...data.nearMisses]
      .map(toEntry)
      .sort((a, b) => compareIds(a.ref, b.ref));
    const next: Cursor = {
      activations: newest(data.activations, previous.activations),
      nearMisses: newest(data.nearMisses, previous.nearMisses),
    };
    return { diagnosticsEnabled: data.enabled, entries, cursor: next, gapDetected: gap };
  }

  async fetchAudio(entry: ClipEntry): Promise<Uint8Array> {
    const audio = await this.client.activationAudio(entry.ref);
    try {
      return Uint8Array.fromBase64(audio.base64);
    } catch {
      throw new SourceError("bad_response", `Clip ${entry.ref} is not valid base64.`);
    }
  }
}

function toEntry(a: Activation): ClipEntry {
  return {
    ref: a.id,
    capturedAt: new Date(a.at).toISOString(),
    reason: a.nearMiss ? "near_miss" : "fired",
    wakeWord: a.wakeWord,
    engine: a.engine,
    score: a.score ?? null,
    threshold: a.threshold ?? null,
    peakDb: a.peakDb,
    rmsDb: a.rmsDb,
    clippedSamples: a.clipped,
    durationMs: a.durationMs,
    meta: { ...a },
  };
}

// Ids are millisecond timestamps as strings: compare them as numbers.
function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function newest(list: Activation[], previous: string | undefined): string | undefined {
  let best = previous;
  for (const a of list) if (best === undefined || compareIds(a.id, best) > 0) best = a.id;
  return best;
}

// A full buffer whose oldest entry is newer than anything seen before means
// entries in between were overwritten before this poll could read them.
function overflowed(list: Activation[], seen: string | undefined): boolean {
  if (seen === undefined || list.length < KIOSK_BUFFER_SIZE) return false;
  const oldest = list.reduce(
    (min, a) => (compareIds(a.id, min) < 0 ? a.id : min),
    list[0]?.id ?? seen,
  );
  return compareIds(oldest, seen) > 0;
}

function label(setting: SettingEntry | undefined): string | null {
  if (!setting || typeof setting.value !== "string") return null;
  return setting.optionLabels?.[setting.value] ?? setting.value;
}

// `voice.wake_words` holds a JSON list of model ids, slot 1 first.
function wakeWords(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) && list.every((x) => typeof x === "string") ? list : null;
  } catch {
    return null;
  }
}
