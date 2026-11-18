import type { Database } from "bun:sqlite";

// Collection sessions (ADR 0020) and the settings writes they made.

export type SessionState = "starting" | "running" | "restoring" | "ended" | "needs_attention";
export type EndReason = "stopped" | "time_limit" | "paused" | "parent_restart" | "start_failed";
export type SessionNote = "wake_word" | "not_wake_word" | "mixed";
export type WritePurpose = "apply" | "undo_start" | "restore";

/** A session not finished yet: one per device at most. */
export const OPEN_STATES: readonly SessionState[] = [
  "starting",
  "running",
  "restoring",
  "needs_attention",
];

export interface SessionRow {
  id: string;
  device_id: string;
  device_name: string;
  state: SessionState;
  note: SessionNote | null;
  engine: string;
  limit_seconds: number;
  snapshot_json: string;
  snapshot_sha256: string;
  target_json: string;
  applied_settings_json: string | null;
  created_at: string;
  started_at: string | null;
  ends_at: string | null;
  restore_started_at: string | null;
  end_reason: EndReason | null;
  restore_attempts: number;
  next_restore_at: string | null;
  last_error: string | null;
  restored_at: string | null;
  resolved_by_hand_at: string | null;
  ended_at: string | null;
  started_by: string | null;
}

export interface SessionWithCounts extends SessionRow {
  fired: number;
  near_miss: number;
}

const WITH_COUNTS = `
  SELECT s.*,
    (SELECT count(*) FROM clips c WHERE c.collection_session_id = s.id
       AND c.capture_reason = 'fired') AS fired,
    (SELECT count(*) FROM clips c WHERE c.collection_session_id = s.id
       AND c.capture_reason = 'near_miss') AS near_miss
  FROM collection_sessions s`;

export function insertSession(
  db: Database,
  s: Pick<
    SessionRow,
    | "id"
    | "device_id"
    | "device_name"
    | "note"
    | "engine"
    | "limit_seconds"
    | "snapshot_json"
    | "snapshot_sha256"
    | "target_json"
    | "created_at"
    | "started_by"
  >,
): void {
  db.query(
    `INSERT INTO collection_sessions (id, device_id, device_name, state, note, engine,
       limit_seconds, snapshot_json, snapshot_sha256, target_json, created_at, started_by)
     VALUES ($id, $device_id, $device_name, 'starting', $note, $engine, $limit_seconds,
       $snapshot_json, $snapshot_sha256, $target_json, $created_at, $started_by)`,
  ).run(s);
}

export function getSession(db: Database, id: string): SessionWithCounts | null {
  return db.query<SessionWithCounts, [string]>(`${WITH_COUNTS} WHERE s.id = ?`).get(id);
}

/** Newest first; optionally one device's. */
export function listSessions(
  db: Database,
  options: { deviceId?: string; limit: number },
): SessionWithCounts[] {
  return options.deviceId
    ? db
        .query<SessionWithCounts, [string, number]>(
          `${WITH_COUNTS} WHERE s.device_id = ? ORDER BY s.created_at DESC LIMIT ?`,
        )
        .all(options.deviceId, options.limit)
    : db
        .query<SessionWithCounts, [number]>(`${WITH_COUNTS} ORDER BY s.created_at DESC LIMIT ?`)
        .all(options.limit);
}

/** Sessions not finished yet, oldest first. */
export function openSessions(db: Database): SessionWithCounts[] {
  return db
    .query<SessionWithCounts, []>(
      `${WITH_COUNTS} WHERE s.state IN ('starting', 'running', 'restoring', 'needs_attention')
       ORDER BY s.created_at`,
    )
    .all();
}

export function openSessionFor(db: Database, deviceId: string): SessionRow | null {
  return db
    .query<SessionRow, [string]>(
      `SELECT * FROM collection_sessions WHERE device_id = ?
         AND state IN ('starting', 'running', 'restoring', 'needs_attention')`,
    )
    .get(deviceId);
}

/** Devices whose settings are boosted now, or may be: polled quickly. */
export function boostedDevices(db: Database): Set<string> {
  const rows = db
    .query<{ device_id: string }, []>(
      `SELECT device_id FROM collection_sessions
       WHERE state IN ('starting', 'running', 'restoring')`,
    )
    .all();
  return new Set(rows.map((r) => r.device_id));
}

export function markRunning(
  db: Database,
  id: string,
  s: { at: string; endsAt: string; appliedSettingsJson: string },
): void {
  db.query(
    `UPDATE collection_sessions SET state = 'running', started_at = ?2, ends_at = ?3,
       applied_settings_json = ?4 WHERE id = ?1 AND state = 'starting'`,
  ).run(id, s.at, s.endsAt, s.appliedSettingsJson);
}

/**
 * Starting or running → restoring, recording why. Returns false when the
 * session was not in one of those states (it is restoring already, say).
 */
export function beginRestore(
  db: Database,
  id: string,
  s: { at: string; reason: EndReason },
): boolean {
  return (
    db
      .query(
        `UPDATE collection_sessions SET state = 'restoring', restore_started_at = ?2,
           end_reason = ?3, next_restore_at = ?2
         WHERE id = ?1 AND state IN ('starting', 'running')`,
      )
      .run(id, s.at, s.reason).changes === 1
  );
}

export function recordRestoreFailure(
  db: Database,
  id: string,
  f: { error: string; nextAt: string },
): void {
  db.query(
    `UPDATE collection_sessions SET restore_attempts = restore_attempts + 1, last_error = ?2,
       next_restore_at = ?3 WHERE id = ?1`,
  ).run(id, f.error, f.nextAt);
}

/** Brings the next restore attempt forward to now. */
export function retryRestoreNow(db: Database, id: string, at: string): void {
  db.query(
    "UPDATE collection_sessions SET next_restore_at = ?2 WHERE id = ?1 AND state = 'restoring'",
  ).run(id, at);
}

export function markRestored(db: Database, id: string, at: string): void {
  db.query(
    `UPDATE collection_sessions SET state = 'ended', restored_at = ?2, ended_at = ?2,
       restore_attempts = restore_attempts + 1, next_restore_at = NULL, last_error = NULL
     WHERE id = ?1`,
  ).run(id, at);
}

export function markNeedsAttention(db: Database, id: string, error: string): void {
  db.query(
    `UPDATE collection_sessions SET state = 'needs_attention', last_error = ?2,
       next_restore_at = NULL WHERE id = ?1`,
  ).run(id, error);
}

export function markResolvedByHand(db: Database, id: string, at: string): boolean {
  return (
    db
      .query(
        `UPDATE collection_sessions SET state = 'ended', resolved_by_hand_at = ?2, ended_at = ?2
         WHERE id = ?1 AND state = 'needs_attention'`,
      )
      .run(id, at).changes === 1
  );
}

export interface WriteRow {
  id: number;
  session_id: string;
  at: string;
  purpose: WritePurpose;
  values_json: string;
  outcome: "ok" | "rejected" | "failed";
  detail: string | null;
}

export function logWrite(db: Database, w: Omit<WriteRow, "id">): void {
  db.query(
    `INSERT INTO collection_session_writes (session_id, at, purpose, values_json, outcome, detail)
     VALUES ($session_id, $at, $purpose, $values_json, $outcome, $detail)`,
  ).run(w);
}

export function listWrites(db: Database, sessionId: string): WriteRow[] {
  return db
    .query<WriteRow, [string]>(
      "SELECT * FROM collection_session_writes WHERE session_id = ? ORDER BY id",
    )
    .all(sessionId);
}

/**
 * The session a clip recorded at `capturedAt` belongs to: one that reached
 * its boosted settings, from the moment it was asked to start until its
 * settings were confirmed back (or, still open, until now).
 */
export function sessionAt(db: Database, deviceId: string, capturedAt: string): SessionRow | null {
  return db
    .query<SessionRow, [string, string]>(
      `SELECT * FROM collection_sessions
       WHERE device_id = ?1 AND started_at IS NOT NULL AND created_at <= ?2
         AND (ended_at IS NULL OR ended_at >= ?2)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(deviceId, capturedAt);
}

/**
 * True when a session (of any outcome) changed or may have changed the
 * device's settings at some moment between `a` and `b`: settings read on
 * one side do not describe a clip recorded on the other.
 */
export function sessionBetween(db: Database, deviceId: string, a: string, b: string): boolean {
  const [from, to] = a <= b ? [a, b] : [b, a];
  return (
    db
      .query<{ n: number }, [string, string, string]>(
        `SELECT count(*) AS n FROM collection_sessions
         WHERE device_id = ?1 AND created_at <= ?3 AND (ended_at IS NULL OR ended_at >= ?2)`,
      )
      .get(deviceId, from, to)?.n !== 0
  );
}
