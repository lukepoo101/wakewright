import type { Database } from "bun:sqlite";

// Devices, their encrypted passwords and their collection status.

export interface DeviceRow {
  id: string;
  name: string;
  source: string;
  config_json: string;
  secret_id: string | null;
  cursor_json: string | null;
  reported_json: string | null;
  reported_at: string | null;
  last_poll_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  failures: number;
  gaps: number;
  last_gap_at: string | null;
  created_at: string;
  updated_at: string;
  removed_at: string | null;
}

export interface DeviceWithCounts extends DeviceRow {
  clips: number;
  last_clip_at: string | null;
}

const WITH_COUNTS = `
  SELECT d.*, count(c.id) AS clips, max(c.captured_at) AS last_clip_at
  FROM devices d LEFT JOIN clips c ON c.device_id = d.id`;

export function listDevices(db: Database): DeviceWithCounts[] {
  return db
    .query<DeviceWithCounts, []>(
      `${WITH_COUNTS} WHERE d.removed_at IS NULL GROUP BY d.id ORDER BY d.name COLLATE NOCASE`,
    )
    .all();
}

export function getDevice(db: Database, id: string): DeviceWithCounts | null {
  return db
    .query<DeviceWithCounts, [string]>(
      `${WITH_COUNTS} WHERE d.id = ? AND d.removed_at IS NULL GROUP BY d.id`,
    )
    .get(id);
}

export function deviceNameTaken(db: Database, name: string, exceptId?: string): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT count(*) AS n FROM devices WHERE name = ? AND removed_at IS NULL AND id != ?",
      )
      .get(name, exceptId ?? "")?.n !== 0
  );
}

export function insertDevice(
  db: Database,
  d: { id: string; name: string; source: string; configJson: string; secretId: string; at: string },
): void {
  db.query(
    `INSERT INTO devices (id, name, source, config_json, secret_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
  ).run(d.id, d.name, d.source, d.configJson, d.secretId, d.at);
}

/**
 * Saves edited settings. A changed address resets what was learnt from the
 * old one (cursor, reported state, status), because it may be another device.
 */
export function updateDevice(
  db: Database,
  id: string,
  d: { name: string; configJson: string; secretId: string | null; at: string; reset: boolean },
): void {
  db.query(
    `UPDATE devices SET name = ?2, config_json = ?3, secret_id = coalesce(?4, secret_id),
       updated_at = ?5,
       cursor_json = CASE WHEN ?6 THEN NULL ELSE cursor_json END,
       reported_json = CASE WHEN ?6 THEN NULL ELSE reported_json END,
       reported_at = CASE WHEN ?6 THEN NULL ELSE reported_at END,
       last_error_code = CASE WHEN ?6 THEN NULL ELSE last_error_code END,
       last_error = CASE WHEN ?6 THEN NULL ELSE last_error END,
       failures = CASE WHEN ?6 THEN 0 ELSE failures END
     WHERE id = ?1`,
  ).run(id, d.name, d.configJson, d.secretId, d.at, d.reset ? 1 : 0);
}

/** Removes a device from collection; its clips stay. */
export function removeDevice(db: Database, id: string, at: string): void {
  db.query(
    "UPDATE devices SET removed_at = ?2, secret_id = NULL, updated_at = ?2 WHERE id = ?1",
  ).run(id, at);
}

export function recordPollSuccess(
  db: Database,
  id: string,
  s: {
    at: string;
    cursorJson: string;
    reportedJson: string;
    reportedAt: string | null;
    gap: boolean;
  },
): void {
  db.query(
    `UPDATE devices SET last_poll_at = ?2, last_success_at = ?2, last_error_code = NULL,
       last_error = NULL, failures = 0, cursor_json = ?3,
       reported_json = ?4, reported_at = coalesce(?5, reported_at),
       gaps = gaps + ?6, last_gap_at = CASE WHEN ?6 THEN ?2 ELSE last_gap_at END
     WHERE id = ?1`,
  ).run(id, s.at, s.cursorJson, s.reportedJson, s.reportedAt, s.gap ? 1 : 0);
}

/** Forgets what was read from a device, so its next poll reads it again. */
export function invalidateReported(db: Database, id: string): void {
  db.query("UPDATE devices SET reported_at = NULL WHERE id = ?").run(id);
}

export function recordPollFailure(
  db: Database,
  id: string,
  f: { at: string; code: string; message: string },
): number {
  const row = db
    .query<{ failures: number }, [string, string, string, string]>(
      `UPDATE devices SET last_poll_at = ?2, last_error_code = ?3, last_error = ?4,
         failures = failures + 1
       WHERE id = ?1 RETURNING failures`,
    )
    .get(id, f.at, f.code, f.message);
  return row?.failures ?? 0;
}

// Secrets ----------------------------------------------------------------

export function insertSecret(
  db: Database,
  s: { id: string; kind: string; ciphertext: Uint8Array; keyVersion: number; at: string },
): void {
  db.query(
    "INSERT INTO secrets (id, kind, ciphertext, key_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(s.id, s.kind, s.ciphertext, s.keyVersion, s.at);
}

export function getSecret(db: Database, id: string): Uint8Array | null {
  const row = db
    .query<{ ciphertext: Uint8Array }, [string]>("SELECT ciphertext FROM secrets WHERE id = ?")
    .get(id);
  return row ? new Uint8Array(row.ciphertext) : null;
}

/** Deletes device passwords no device refers to any more. */
export function deleteUnusedSecrets(db: Database): void {
  db.run(
    `DELETE FROM secrets WHERE kind = 'device_password'
       AND id NOT IN (SELECT secret_id FROM devices WHERE secret_id IS NOT NULL)`,
  );
}
