import type { Database } from "bun:sqlite";
import type { BlobStore } from "./blobs.ts";
import { clipExists, insertClip } from "./db/clips.ts";
import { insidePause, openPause } from "./db/collection.ts";
import {
  type DeviceRow,
  getDevice,
  listDevices,
  recordPollFailure,
  recordPollSuccess,
} from "./db/devices.ts";
import { type Devices, describeError } from "./devices.ts";
import type { Logger } from "./log.ts";
import {
  type ClipEntry,
  type ReportedState,
  SourceError,
  type SourceConnection,
} from "./source.ts";
import { checkClipWav, WavError } from "./wav.ts";

// The collector: polls every device on an interval, stores the clips it has
// not seen and records each device's status. It only reads from devices.
//
// - Idempotent: a clip is stored once per (device, source_ref), so a
//   restart, a retry or two overlapping polls never duplicate it. Nothing is
//   recorded until its audio is safely in the blob store.
// - A failed poll is retried with backoff (interval × 2^n, up to 5 minutes).
// - While collection is paused nothing is polled, and clips a device
//   captured inside any pause window are skipped and never stored.
// - A clip the device cannot provide as a valid 16 kHz mono PCM WAV is
//   skipped and logged, once per run, without holding up the others.

const MAX_BACKOFF_MS = 5 * 60_000;
/** How often to re-read a device's settings and health. */
const STATE_EVERY_MS = 5 * 60_000;
const TICK_MS = 1000;

export interface CollectorOptions {
  db: Database;
  blobs: BlobStore;
  devices: Devices;
  log: Logger;
  intervalMs: number;
  now?: () => number;
}

export interface PollOutcome {
  stored: number;
  /** Clips captured while collection was paused. */
  discarded: number;
  error?: { code: string; message: string };
}

export class Collector {
  private readonly db: Database;
  private readonly blobs: BlobStore;
  private readonly devices: Devices;
  private readonly log: Logger;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private readonly inFlight = new Map<string, Promise<PollOutcome>>();
  private readonly dueAt = new Map<string, number>();
  private readonly connections = new Map<string, { key: string; connection: SourceConnection }>();
  private readonly rejected = new Map<string, Set<string>>();

  constructor(options: CollectorOptions) {
    this.db = options.db;
    this.blobs = options.blobs;
    this.devices = options.devices;
    this.log = options.log.child({ component: "collector" });
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops scheduling and waits for polls in progress. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.allSettled(this.inFlight.values());
  }

  /** Polls a device (or every device) as soon as possible. */
  wake(deviceId?: string): void {
    if (deviceId) this.dueAt.delete(deviceId);
    else this.dueAt.clear();
    if (!this.stopped) this.schedule(0);
  }

  /** Polls every device once, now, and waits. For tests and tools. */
  async pollAll(): Promise<Map<string, PollOutcome>> {
    const results = new Map<string, PollOutcome>();
    for (const device of listDevices(this.db)) {
      results.set(device.id, await this.pollDevice(device.id));
    }
    return results;
  }

  /** Polls one device unless a poll of it is already running. */
  pollDevice(deviceId: string): Promise<PollOutcome> {
    const running = this.inFlight.get(deviceId);
    if (running) return running;
    const poll = this.runPoll(deviceId).finally(() => this.inFlight.delete(deviceId));
    this.inFlight.set(deviceId, poll);
    return poll;
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), ms);
  }

  private tick(): void {
    if (this.stopped) return;
    try {
      if (!openPause(this.db)) {
        const now = this.now();
        for (const device of listDevices(this.db)) {
          if ((this.dueAt.get(device.id) ?? 0) > now || this.inFlight.has(device.id)) continue;
          this.dueAt.set(device.id, now + this.intervalMs);
          void this.pollDevice(device.id);
        }
      }
    } catch (error) {
      this.log.error("collector tick failed", { error: (error as Error).message });
    }
    this.schedule(TICK_MS);
  }

  private async runPoll(deviceId: string): Promise<PollOutcome> {
    const device = getDevice(this.db, deviceId);
    if (!device) return { stored: 0, discarded: 0 };
    if (openPause(this.db)) return { stored: 0, discarded: 0 };
    const log = this.log.child({ device_id: device.id, device: device.name });
    const iso = () => new Date(this.now()).toISOString();
    let stored = 0;
    let discarded = 0;
    try {
      const connection = await this.connection(device);
      let reported = parseReported(device.reported_json);
      let reportedAt: string | null = null;
      const lastRead = device.reported_at ? Date.parse(device.reported_at) : 0;
      if (!reported || device.failures > 0 || this.now() - lastRead >= STATE_EVERY_MS) {
        reported = await connection.readState();
        reportedAt = iso();
      }

      const poll = await connection.poll(parseJson(device.cursor_json));
      reported = { ...reported, diagnosticsEnabled: poll.diagnosticsEnabled };
      for (const entry of poll.entries) {
        if (clipExists(this.db, device.id, entry.ref)) continue;
        if (insidePause(this.db, entry.capturedAt)) {
          discarded++;
          continue;
        }
        if (this.rejected.get(device.id)?.has(entry.ref)) continue;
        try {
          if (await this.store(device, connection, entry, reported, iso())) stored++;
        } catch (error) {
          // A problem with this one clip must not hold up the others; a
          // problem with the device (offline, password) ends the poll.
          if (!isClipProblem(error)) throw error;
          this.reject(device.id, entry.ref);
          log.warn("skipped a clip the device could not provide as a valid WAV", {
            source_ref: entry.ref,
            reason: (error as Error).message,
          });
        }
      }

      if (poll.gapDetected) {
        log.warn("the device's buffer overflowed since the last poll; some clips were missed");
      }
      recordPollSuccess(this.db, device.id, {
        at: iso(),
        cursorJson: JSON.stringify(poll.cursor),
        reportedJson: JSON.stringify(reported),
        reportedAt,
        gap: poll.gapDetected,
      });
      if (stored > 0) log.info("stored clips", { stored });
      if (discarded > 0) log.debug("skipped clips captured while paused", { discarded });
      return { stored, discarded };
    } catch (error) {
      const described = describeError(error);
      if (described.code === "auth_failed") this.connections.delete(device.id);
      const failures = recordPollFailure(this.db, device.id, { at: iso(), ...described });
      const backoff = Math.min(this.intervalMs * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
      this.dueAt.set(device.id, this.now() + backoff);
      // Log the first failure and then every tenth, not every retry.
      const logAt = failures === 1 || failures % 10 === 0 ? "warn" : "debug";
      log[logAt]("poll failed", { ...described, failures, retry_in_s: backoff / 1000, stored });
      return { stored, discarded, error: described };
    }
  }

  private async store(
    device: DeviceRow,
    connection: SourceConnection,
    entry: ClipEntry,
    reported: ReportedState,
    ingestedAt: string,
  ): Promise<boolean> {
    const audio = await connection.fetchAudio(entry);
    const wav = checkClipWav(audio);
    const blob = await this.blobs.put(audio);
    return insertClip(
      this.db,
      {
        id: Bun.randomUUIDv7(),
        device_id: device.id,
        source_ref: entry.ref,
        audio_sha256: blob.sha256,
        captured_at: entry.capturedAt,
        ingested_at: ingestedAt,
        capture_reason: entry.reason,
        wake_word: entry.wakeWord,
        engine: entry.engine,
        score: entry.score,
        threshold: entry.threshold,
        peak_db: entry.peakDb,
        rms_db: entry.rmsDb,
        clipped_samples: entry.clippedSamples,
        duration_ms: wav.durationMs,
        sensitivity_json: JSON.stringify({
          engine: reported.engine,
          wakeWords: reported.wakeWords,
          sensitivity: reported.sensitivity,
          fineTune: reported.fineTune,
        }),
        source_meta_json: JSON.stringify(entry.meta),
      },
      { size: blob.size, mediaType: "audio/wav" },
    );
  }

  // One cached connection (and so one device login) per device, rebuilt
  // when the device's settings or password change.
  private async connection(device: DeviceRow): Promise<SourceConnection> {
    const key = `${device.updated_at}|${device.secret_id}`;
    const cached = this.connections.get(device.id);
    if (cached?.key === key) return cached.connection;
    const connection = this.devices.connect(
      device.source,
      JSON.parse(device.config_json),
      await this.devices.password(device),
    );
    this.connections.set(device.id, { key, connection });
    return connection;
  }

  private reject(deviceId: string, ref: string): void {
    const set = this.rejected.get(deviceId) ?? new Set();
    set.add(ref);
    this.rejected.set(deviceId, set);
  }
}

function isClipProblem(error: unknown): boolean {
  if (error instanceof WavError) return true;
  return (
    error instanceof SourceError && (error.code === "bad_response" || error.code === "device_error")
  );
}

function parseJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

function parseReported(text: string | null): ReportedState | null {
  return text === null ? null : (JSON.parse(text) as ReportedState);
}
