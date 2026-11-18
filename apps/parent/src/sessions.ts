import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type DeviceRow, invalidateReported } from "./db/devices.ts";
import {
  beginRestore,
  type EndReason,
  getSession,
  insertSession,
  logWrite,
  markNeedsAttention,
  markResolvedByHand,
  markRestored,
  markRunning,
  openSessionFor,
  openSessions,
  recordRestoreFailure,
  retryRestoreNow,
  type SessionNote,
  type SessionRow,
  type WritePurpose,
} from "./db/sessions.ts";
import { type Devices, describeError } from "./devices.ts";
import type { Logger } from "./log.ts";
import type { CollectionOptions, SourceConnection } from "./source.ts";

// Collection sessions (ADR 0020): for a time limit the user sets, one
// device runs its most sensitive wake word settings and is polled every few
// seconds, so every activation and near miss is kept; then its settings are
// put back and confirmed.
//
// The rules, in the order they happen:
//
// 1. Read the device's settings and work out what to change
//    (collectionOptions). Store the current values of exactly those keys,
//    with their SHA-256, before anything is written.
// 2. Write only those keys. If the device refuses any or the write fails,
//    put back whatever changed and confirm it: the start fails with
//    nothing changed. Then read them back; the session runs only once the
//    device reports every new value.
// 3. Restore on Stop, at the time limit (this loop, not the browser), when
//    collection is paused, and on start-up for any session left open.
//    Restore = read the device, write back each key that differs from the
//    snapshot, read again and confirm every key matches. Until it does the
//    session stays "restoring" and is retried with backoff; Home and the
//    device page say so.
// 4. A snapshot that does not match its hash, or cannot be read, is never
//    written: the session is marked for attention, showing what it holds,
//    and the user puts the settings back by hand.

/** How often to look for sessions to end or restore. */
const TICK_MS = 1000;
/** Restore retries: 5 s, doubling, at most 2 minutes apart. */
const RETRY_FIRST_MS = 5000;
const RETRY_MAX_MS = 2 * 60_000;
export const LIMIT_SECONDS = { min: 30, max: 3600, default: 600 } as const;

export class SessionError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "busy"
      | "paused"
      | "not_ready"
      | "engine_unavailable"
      | "device"
      | "rejected"
      | "not_running"
      | "not_attention",
    message: string,
    /** For a start that failed after a write: the session that records it. */
    readonly sessionId?: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface StartRequest {
  deviceId: string;
  engine?: string;
  limitSeconds: number;
  note: SessionNote | null;
  userId: string | null;
}

export interface SessionsOptions {
  db: Database;
  devices: Devices;
  log: Logger;
  /** Whether collection is paused now. */
  paused: () => boolean;
  /** Called when a device's polling interval should change. */
  onChange?: (deviceId: string) => void;
  now?: () => number;
}

const Snapshot = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export class CollectionSessions {
  private readonly db: Database;
  private readonly devices: Devices;
  private readonly log: Logger;
  private readonly paused: () => boolean;
  private readonly onChange: (deviceId: string) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly restoring = new Map<string, Promise<void>>();
  private readonly starting = new Set<string>();

  constructor(options: SessionsOptions) {
    this.db = options.db;
    this.devices = options.devices;
    this.log = options.log.child({ component: "collection-sessions" });
    this.paused = options.paused;
    this.onChange = options.onChange ?? (() => {});
    this.now = options.now ?? Date.now;
  }

  /**
   * Start-up: every session left starting or running (the parent stopped
   * or crashed during it) is restored now, then the loop runs.
   */
  start(): void {
    const at = this.iso();
    for (const s of openSessions(this.db)) {
      if (s.state === "starting" || s.state === "running") {
        beginRestore(this.db, s.id, { at, reason: "parent_restart" });
        this.log.warn("restoring a collection session left open by the last run", {
          session_id: s.id,
          device_id: s.device_id,
        });
      }
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.restoring.values());
  }

  /** One pass: end sessions past their limit and attempt due restores. */
  async tick(): Promise<void> {
    const now = this.now();
    try {
      for (const s of openSessions(this.db)) {
        if (s.state === "running" && s.ends_at && Date.parse(s.ends_at) <= now) {
          this.end(s, "time_limit");
        }
      }
      const due = openSessions(this.db).filter(
        (s) =>
          s.state === "restoring" &&
          (s.next_restore_at === null || Date.parse(s.next_restore_at) <= now),
      );
      await Promise.allSettled(due.map((s) => this.restore(s.id)));
    } catch (error) {
      this.log.error("collection session tick failed", { error: (error as Error).message });
    }
  }

  /** What a session would change on the device, read from it now. */
  async options(device: DeviceRow): Promise<CollectionOptions> {
    return (await this.connect(device)).collectionOptions();
  }

  async startSession(device: DeviceRow, request: StartRequest): Promise<SessionRow> {
    if (this.paused()) {
      throw new SessionError(
        "paused",
        "Collection is paused. Resume it first: clips saved while paused are not kept.",
      );
    }
    if (openSessionFor(this.db, device.id) || this.starting.has(device.id)) {
      throw new SessionError("busy", `${device.name} already has a collection session.`);
    }
    this.starting.add(device.id);
    try {
      return await this.begin(device, request);
    } finally {
      this.starting.delete(device.id);
    }
  }

  private async begin(device: DeviceRow, request: StartRequest): Promise<SessionRow> {
    let connection: SourceConnection;
    let options: CollectionOptions;
    try {
      connection = await this.connect(device);
      options = await connection.collectionOptions();
    } catch (error) {
      throw new SessionError("device", deviceMessage(device, error));
    }
    if (!options.ready) {
      throw new SessionError("not_ready", options.problems.join(" ") || "It cannot start now.");
    }
    const engine = options.engines.find(
      (e) => e.value === (request.engine ?? options.defaultEngine),
    );
    if (!engine) {
      throw new SessionError("engine_unavailable", `${device.name} does not offer that engine.`);
    }
    if (!engine.available) {
      throw new SessionError(
        "engine_unavailable",
        `${engine.label} cannot be used: ${engine.reason}`,
      );
    }

    // The snapshot: the device's values of exactly the keys to change, read
    // just now, stored before anything is written.
    const keys = engine.changes.map((c) => c.key);
    const snapshot = Object.fromEntries(engine.changes.map((c) => [c.key, c.from]));
    const target = Object.fromEntries(engine.changes.map((c) => [c.key, c.to]));
    const snapshotJson = JSON.stringify(snapshot);
    const id = Bun.randomUUIDv7();
    insertSession(this.db, {
      id,
      device_id: device.id,
      device_name: device.name,
      note: request.note,
      engine: engine.value,
      limit_seconds: request.limitSeconds,
      snapshot_json: snapshotJson,
      snapshot_sha256: sha256(snapshotJson),
      target_json: JSON.stringify(target),
      created_at: this.iso(),
      started_by: request.userId,
    });
    const log = this.log.child({ session_id: id, device_id: device.id, device: device.name });
    log.info("collection session starting", {
      engine: engine.value,
      limit_s: request.limitSeconds,
      changes: target,
    });
    this.onChange(device.id);

    // Write, then read back. Any failure puts back what changed.
    let failure: string | null = null;
    if (keys.length > 0) {
      try {
        const result = await connection.writeSettings(target);
        this.recordWrite(id, "apply", target, result.rejected, result.errors);
        if (result.rejected.length > 0) {
          failure = `${device.name} refused ${result.rejected
            .map((k) => (result.errors[k] ? `${k} (${result.errors[k]})` : k))
            .join(", ")}.`;
        }
      } catch (error) {
        this.recordWrite(id, "apply", target, null, null, describeError(error).message);
        failure = deviceMessage(device, error);
      }
      if (failure === null) {
        try {
          const now = await connection.readSettings(keys);
          const wrong = keys.filter((k) => !same(now[k], target[k]));
          if (wrong.length > 0) failure = `${device.name} did not keep ${wrong.join(", ")}.`;
        } catch (error) {
          failure = deviceMessage(device, error);
        }
      }
    }

    if (failure !== null) {
      log.warn("collection session could not start; putting back what changed", {
        reason: failure,
      });
      beginRestore(this.db, id, { at: this.iso(), reason: "start_failed" });
      await this.restore(id, "undo_start");
      const after = getSession(this.db, id);
      const back = after?.state === "ended";
      throw new SessionError(
        "rejected",
        back
          ? `The session did not start: ${failure} Nothing was changed on the device.`
          : `The session did not start: ${failure} Its settings could not be confirmed back yet; Wakewright keeps trying.`,
        id,
      );
    }

    let applied: string;
    try {
      applied = JSON.stringify(settingsStamp(await connection.readState()));
    } catch {
      applied = JSON.stringify(null);
    }
    const at = this.now();
    markRunning(this.db, id, {
      at: new Date(at).toISOString(),
      endsAt: new Date(at + request.limitSeconds * 1000).toISOString(),
      appliedSettingsJson: applied,
    });
    invalidateReported(this.db, device.id);
    log.info("collection session running", { ends_in_s: request.limitSeconds });
    this.onChange(device.id);
    return getSession(this.db, id) as SessionRow;
  }

  /** Stop: put the settings back now. */
  async stopSession(id: string): Promise<void> {
    const s = getSession(this.db, id);
    if (!s) throw new SessionError("not_found", "No such collection session.");
    if (s.state === "restoring") return this.restore(id);
    if (s.state !== "running") {
      throw new SessionError("not_running", "This collection session is not running.");
    }
    return this.end(s, "stopped");
  }

  /** Collection was paused: every running session ends and is restored. */
  endAllForPause(): void {
    for (const s of openSessions(this.db)) {
      if (s.state === "running") void this.end(s, "paused");
    }
  }

  /** A restoring session: try again now rather than at the next backoff. */
  async retryNow(id: string): Promise<void> {
    const s = getSession(this.db, id);
    if (!s) throw new SessionError("not_found", "No such collection session.");
    if (s.state !== "restoring") {
      throw new SessionError("not_running", "This collection session is not waiting to restore.");
    }
    retryRestoreNow(this.db, id, this.iso());
    return this.restore(id);
  }

  /** needs_attention: the user has put the settings back by hand. */
  resolveByHand(id: string): void {
    if (!markResolvedByHand(this.db, id, this.iso())) {
      throw new SessionError(
        "not_attention",
        "Only a session whose settings could not be read back can be marked as fixed by hand.",
      );
    }
    this.log.info("collection session marked as put back by hand", { session_id: id });
  }

  private end(s: SessionRow, reason: EndReason): Promise<void> {
    if (!beginRestore(this.db, s.id, { at: this.iso(), reason })) return Promise.resolve();
    this.log.info("collection session ending", {
      session_id: s.id,
      device_id: s.device_id,
      reason,
    });
    return this.restore(s.id);
  }

  // One restore attempt at a time per session.
  private restore(id: string, purpose: WritePurpose = "restore"): Promise<void> {
    const running = this.restoring.get(id);
    if (running) return running;
    const attempt = this.attemptRestore(id, purpose).finally(() => this.restoring.delete(id));
    this.restoring.set(id, attempt);
    return attempt;
  }

  private async attemptRestore(id: string, purpose: WritePurpose): Promise<void> {
    const s = getSession(this.db, id);
    if (s?.state !== "restoring") return;
    const log = this.log.child({ session_id: id, device_id: s.device_id });

    const snapshot = readSnapshot(s);
    if (snapshot === null) {
      markNeedsAttention(
        this.db,
        id,
        "The saved settings of this session are damaged, so Wakewright will not write them. Put the settings back by hand.",
      );
      log.error("collection session snapshot is damaged; not restoring", {});
      return;
    }
    const device = this.db
      .query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?")
      .get(s.device_id);
    if (!device || device.secret_id === null) {
      markNeedsAttention(
        this.db,
        id,
        "Wakewright no longer has this device's password, so it cannot put the settings back. Put them back by hand.",
      );
      log.error("collection session device has no password; not restoring", {});
      return;
    }

    const keys = Object.keys(snapshot);
    try {
      const connection = await this.connect(device);
      const before = await connection.readSettings(keys);
      const differ = Object.fromEntries(
        keys.filter((k) => !same(before[k], snapshot[k])).map((k) => [k, snapshot[k]]),
      );
      if (Object.keys(differ).length > 0) {
        try {
          const result = await connection.writeSettings(differ);
          this.recordWrite(id, purpose, differ, result.rejected, result.errors);
        } catch (error) {
          this.recordWrite(id, purpose, differ, null, null, describeError(error).message);
          throw error;
        }
      }
      const after = await connection.readSettings(keys);
      const wrong = keys.filter((k) => !same(after[k], snapshot[k]));
      if (wrong.length > 0) {
        throw new Error(`${device.name} still reports other values for ${wrong.join(", ")}.`);
      }
      markRestored(this.db, id, this.iso());
      invalidateReported(this.db, s.device_id);
      log.info("collection session settings put back and confirmed", { values: snapshot });
      this.onChange(s.device_id);
    } catch (error) {
      const attempts = s.restore_attempts + 1;
      const wait = Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      const message = describeError(error).message;
      recordRestoreFailure(this.db, id, {
        error: message,
        nextAt: new Date(this.now() + wait).toISOString(),
      });
      const level = attempts === 1 || attempts % 10 === 0 ? "warn" : "debug";
      log[level]("could not put a collection session's settings back yet", {
        error: message,
        attempts,
        retry_in_s: wait / 1000,
      });
    }
  }

  private recordWrite(
    sessionId: string,
    purpose: WritePurpose,
    values: Record<string, unknown>,
    rejected: string[] | null,
    errors: Record<string, string> | null,
    failure?: string,
  ): void {
    const outcome = failure !== undefined ? "failed" : rejected?.length ? "rejected" : "ok";
    const detail =
      failure ??
      (rejected?.length
        ? `refused: ${rejected.map((k) => (errors?.[k] ? `${k} (${errors[k]})` : k)).join(", ")}`
        : null);
    logWrite(this.db, {
      session_id: sessionId,
      at: this.iso(),
      purpose,
      values_json: JSON.stringify(values),
      outcome,
      detail,
    });
    // Setting values only: engine, sensitivity and fine-tune, never a secret.
    this.log.info("collection session wrote device settings", {
      session_id: sessionId,
      purpose,
      values,
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  private async connect(device: DeviceRow): Promise<SourceConnection> {
    return this.devices.connect(
      device.source,
      JSON.parse(device.config_json),
      await this.devices.password(device),
    );
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** The session's snapshot, or null when the row is damaged. */
export function readSnapshot(s: Pick<SessionRow, "snapshot_json" | "snapshot_sha256">) {
  if (sha256(s.snapshot_json) !== s.snapshot_sha256) return null;
  try {
    const parsed = Snapshot.safeParse(JSON.parse(s.snapshot_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function settingsStamp(state: {
  engine: string | null;
  wakeWords: string[] | null;
  sensitivity: string | null;
  fineTune: number | null;
}) {
  return {
    engine: state.engine,
    wakeWords: state.wakeWords,
    sensitivity: state.sensitivity,
    fineTune: state.fineTune,
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function deviceMessage(device: DeviceRow, error: unknown): string {
  const described = describeError(error);
  return described.code === "internal" ? described.message : `${device.name}: ${described.message}`;
}
