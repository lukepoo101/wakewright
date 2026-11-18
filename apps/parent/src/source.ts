import type { z } from "zod";

// The Source interface: how the collector talks to one kind of device. The
// Kiosk Satellite adapter (kiosk/source.ts) is the first implementation;
// later sources plug in here without the collector changing. A source only
// ever reads from a device (ADR 0008).

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

/** A connection to one device. It may cache a login between calls. */
export interface SourceConnection {
  readState(): Promise<ReportedState>;
  poll(cursor: unknown): Promise<PollResult>;
  fetchAudio(entry: ClipEntry): Promise<Uint8Array>;
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
