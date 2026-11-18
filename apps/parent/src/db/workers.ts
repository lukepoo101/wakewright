import type { Database } from "bun:sqlite";
import type { OfferedJudge } from "./judging.ts";

// Workers (migration 0004, ADR 0018): records the parent owns, each with
// the SHA-256 of its own token, created in the UI or declared in
// configuration, and what the worker last reported about itself.

export type WorkerSource = "config" | "ui";

export interface WorkerRow {
  id: string;
  name: string;
  notes: string;
  enabled: number;
  allowed_judges_json: string | null;
  source: WorkerSource;
  token_sha256: string;
  token_hint: string | null;
  token_created_at: string;
  created_at: string;
  updated_at: string;
  reported_name: string | null;
  reported_version: string | null;
  offered_judges_json: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface NewWorker {
  id: string;
  name: string;
  notes: string;
  enabled: boolean;
  allowedJudges: string[] | null;
  source: WorkerSource;
  tokenSha256: string;
  tokenHint: string | null;
  at: string;
}

export function insertWorker(db: Database, w: NewWorker): void {
  db.query(
    `INSERT INTO workers (id, name, notes, enabled, allowed_judges_json, source, token_sha256,
       token_hint, token_created_at, created_at, updated_at)
     VALUES ($id, $name, $notes, $enabled, $allowed, $source, $hash, $hint, $at, $at, $at)`,
  ).run({
    id: w.id,
    name: w.name,
    notes: w.notes,
    enabled: w.enabled ? 1 : 0,
    allowed: w.allowedJudges === null ? null : JSON.stringify(w.allowedJudges),
    source: w.source,
    hash: w.tokenSha256,
    hint: w.tokenHint,
    at: w.at,
  });
}

export interface WorkerChanges {
  name?: string;
  notes?: string;
  enabled?: boolean;
  allowedJudges?: string[] | null;
}

export function updateWorker(db: Database, id: string, c: WorkerChanges, at: string): void {
  db.query(
    `UPDATE workers SET
       name = coalesce($name, name),
       notes = coalesce($notes, notes),
       enabled = coalesce($enabled, enabled),
       allowed_judges_json = CASE WHEN $setAllowed THEN $allowed ELSE allowed_judges_json END,
       updated_at = $at
     WHERE id = $id`,
  ).run({
    id,
    name: c.name ?? null,
    notes: c.notes ?? null,
    enabled: c.enabled === undefined ? null : c.enabled ? 1 : 0,
    setAllowed: c.allowedJudges === undefined ? 0 : 1,
    allowed:
      c.allowedJudges === undefined || c.allowedJudges === null
        ? null
        : JSON.stringify(c.allowedJudges),
    at,
  });
}

export function setWorkerToken(
  db: Database,
  id: string,
  token: { sha256: string; hint: string | null },
  at: string,
): void {
  db.query(
    `UPDATE workers SET token_sha256 = ?, token_hint = ?, token_created_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(token.sha256, token.hint, at, at, id);
}

/** Deletes the worker; its leases go with it (ON DELETE CASCADE). */
export function deleteWorker(db: Database, id: string): void {
  db.query("DELETE FROM workers WHERE id = ?").run(id);
}

export function getWorker(db: Database, id: string): WorkerRow | null {
  return db.query<WorkerRow, [string]>("SELECT * FROM workers WHERE id = ?").get(id);
}

export function workerByName(db: Database, name: string): WorkerRow | null {
  return db.query<WorkerRow, [string]>("SELECT * FROM workers WHERE name = ?").get(name);
}

/** Declared workers first, then by name. */
export function listWorkers(db: Database): WorkerRow[] {
  return db
    .query<WorkerRow, []>(
      "SELECT * FROM workers ORDER BY source = 'ui', name COLLATE NOCASE, created_at",
    )
    .all();
}

/** Every worker's id and token hash, for checking a token against them all. */
export function workerTokenHashes(db: Database): { id: string; token_sha256: string }[] {
  return db
    .query<{ id: string; token_sha256: string }, []>("SELECT id, token_sha256 FROM workers")
    .all();
}

/** Records what the worker reported in a claim. */
export function recordReport(
  db: Database,
  id: string,
  report: { name: string; version: string; judges: OfferedJudge[] },
  at: string,
): void {
  db.query(
    `UPDATE workers SET reported_name = ?1, reported_version = ?2, offered_judges_json = ?3,
       first_seen_at = coalesce(first_seen_at, ?4), last_seen_at = ?4
     WHERE id = ?5`,
  ).run(report.name, report.version, JSON.stringify(report.judges), at, id);
}

export function touchWorker(db: Database, id: string, at: string): void {
  db.query("UPDATE workers SET last_seen_at = ? WHERE id = ? AND last_seen_at IS NOT NULL").run(
    at,
    id,
  );
}

/** Ends every lease the worker holds, so its clips go to the next claim. */
export function releaseLeases(db: Database, workerId: string): number {
  return db.query("DELETE FROM judge_leases WHERE worker_id = ?").run(workerId).changes;
}
