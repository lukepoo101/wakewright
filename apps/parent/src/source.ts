import type { z } from "zod";

// The Source interface: how the collector talks to one kind of device. The
// Kiosk Satellite adapter (kiosk/source.ts) is the first implementation;
// later sources plug in here without the collector changing. A source reads
// from a device (ADR 0008); its one write is a collection session's change
// of the wake word sensitivity settings, which is always put back
// (ADR 0020).

/** Why a device call failed; the UI turns each code into advice. */
export type SourceErrorCode =
  | "unreachable" // nothing answered at the address
  | "timeout" // the device did not answer in time
  | "auth_failed" // the device rejected the password
  | "rate_limited" // the device is refusing logins for a while
  | "bad_response" // the answer was not what the API documents
  | "device_error"; // the device answered with an error of its own

export class SourceError extends Error {
  constructor(
    readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/** One saved wake word activation or near miss, as the device lists it. */
export interface ClipEntry {
  /** The device's id for the entry; unique per device. */
  ref: string;
  /** UTC ISO 8601 with milliseconds. */
  capturedAt: string;
  reason: "fired" | "near_miss";
  wakeWord: string;
  engine: string;
  score: number | null;
  threshold: number | null;
  peakDb: number | null;
  rmsDb: number | null;
  clippedSamples: number;
  durationMs: number;
  /** The raw entry, kept with the clip. */
  meta: Record<string, unknown>;
}

/** What a device reports about itself, read only. Unknown values are null. */
export interface ReportedState {
  name: string | null;
  appVersion: string | null;
  diagnosticsEnabled: boolean | null;
  engine: string | null;
  wakeWords: string[] | null;
  sensitivity: string | null;
  fineTune: number | null;
  /** Fleet: true when it leads one; the leader's name when it follows one. */
  leader: boolean | null;
  follows: string | null;
}

export interface PollResult {
  /** False when the device is not saving clips (wake word diagnostics off). */
  diagnosticsEnabled: boolean;
  /** Entries the device holds now, oldest first. */
  entries: ClipEntry[];
  /** Opaque; pass it to the next poll once every entry has been handled. */
  cursor: unknown;
  /** True when the device's buffer overflowed since the cursor: clips were lost. */
  gapDetected: boolean;
}

/** One setting a collection session would change, with labels for the UI. */
export interface SettingChange {
  key: string;
  title: string;
  from: unknown;
  to: unknown;
  fromLabel: string;
  toLabel: string;
}

/** An engine a collection session could run, and what it would change. */
export interface CollectionEngine {
  /** The engine's setting value, e.g. "microwakeword". */
  value: string;
  label: string;
  /** The device runs this engine now. */
  current: boolean;
  available: boolean;
  /** Why it is not available. */
  reason: string | null;
  /** The engine a session uses unless the user picks another. */
  recommended: boolean;
  changes: SettingChange[];
}

/** What a collection session could do on a device, read from it now. */
export interface CollectionOptions {
  /** False when a session cannot start; `problems` says why. */
  ready: boolean;
  problems: string[];
  current: {
    engine: string | null;
    engineLabel: string;
    sensitivity: string | null;
    sensitivityLabel: string;
    fineTune: number | null;
    wakeWords: string[];
  };
  fleet: { role: "leader" | "follower"; leader: string | null } | null;
  engines: CollectionEngine[];
  defaultEngine: string | null;
}

/** How a device answered a settings write. */
export interface WriteResult {
  /** Keys the device refused; the others were applied. */
  rejected: string[];
  errors: Record<string, string>;
}

/** A connection to one device. It may cache a login between calls. */
export interface SourceConnection {
  readState(): Promise<ReportedState>;
  poll(cursor: unknown): Promise<PollResult>;
  fetchAudio(entry: ClipEntry): Promise<Uint8Array>;
  /** Collection sessions (ADR 0020): what one would change on the device now. */
  collectionOptions(): Promise<CollectionOptions>;
  /** The current values of these settings; a key the device lacks is undefined. */
  readSettings(keys: readonly string[]): Promise<Record<string, unknown>>;
  /** Writes wake word settings; any other key is refused before anything is sent. */
  writeSettings(values: Record<string, unknown>): Promise<WriteResult>;
}

export interface ConnectOptions {
  fetch: typeof fetch;
  timeoutMs: number;
}

export interface Source<C = unknown> {
  /** Stored in devices.source. */
  id: string;
  label: string;
  /** The device settings this source needs, as entered in the UI. */
  configSchema: z.ZodType<C>;
  connect(device: { config: C; password: string }, options: ConnectOptions): SourceConnection;
}
