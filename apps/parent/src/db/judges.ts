import type { Database } from "bun:sqlite";
import type { SettingField } from "../judge-settings.ts";
import type { OutcomeRule } from "../outcome.ts";

// Judge types, judge instances, their attempts and test runs, and the
// outcome rule (migration 0005, ADR 0019). Judging itself (claims, leases,
// results) is in judging.ts.

export type JudgeKind = "wake_word_model" | "speech_to_text";

export interface JudgeTypeRow {
  id: string;
  name: string;
  kind: JudgeKind;
  description: string;
  external: number;
  version: string;
  wake_words_json: string | null;
  settings_json: string;
  last_seen_at: string | null;
}

/** A judge type as a worker advertises it in a claim. */
export interface AdvertisedType {
  id: string;
  version: string;
  name: string;
  kind: JudgeKind;
  description: string;
  external: boolean;
  wakeWords: string[] | null;
  settings: SettingField[];
}

export function listTypes(db: Database): JudgeTypeRow[] {
  return db.query<JudgeTypeRow, []>("SELECT * FROM judge_types ORDER BY name COLLATE NOCASE").all();
}

export function getType(db: Database, id: string): JudgeTypeRow | null {
  return db.query<JudgeTypeRow, [string]>("SELECT * FROM judge_types WHERE id = ?").get(id);
}

/** Records the types a worker advertised: the latest advertisement wins. */
export function recordTypes(db: Database, types: readonly AdvertisedType[], at: string): void {
  const upsert = db.query(
    `INSERT INTO judge_types (id, name, kind, description, external, version, wake_words_json,
       settings_json, last_seen_at)
     VALUES ($id, $name, $kind, $description, $external, $version, $words, $settings, $at)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
       description = excluded.description, external = excluded.external,
       version = excluded.version, wake_words_json = excluded.wake_words_json,
       settings_json = excluded.settings_json, last_seen_at = excluded.last_seen_at`,
  );
  for (const t of types) {
    upsert.run({
      id: t.id,
      name: t.name,
      kind: t.kind,
      description: t.description,
      external: t.external ? 1 : 0,
      version: t.version,
      words: t.wakeWords === null ? null : JSON.stringify(t.wakeWords.map((w) => w.toLowerCase())),
      settings: JSON.stringify(t.settings),
      at,
    });
  }
}

export interface InstanceRow {
  id: string;
  name: string;
  type: string;
  settings_json: string;
  secret_id: string | null;
  fingerprint: string;
  weight: number;
  enabled: number;
  daily_limit: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  failures: number;
  last_error: string | null;
  last_error_reason: string | null;
  last_error_at: string | null;
  retry_at: string | null;
  last_result_at: string | null;
}

/** Judges not deleted, by weight (heaviest first), then name. */
export function listInstances(db: Database, options: { deleted?: boolean } = {}): InstanceRow[] {
  return db
    .query<InstanceRow, []>(
      `SELECT * FROM judge_instances ${options.deleted ? "" : "WHERE deleted_at IS NULL"}
       ORDER BY deleted_at IS NOT NULL, weight DESC, name COLLATE NOCASE`,
    )
    .all();
}

export function getInstance(db: Database, id: string): InstanceRow | null {
  return db.query<InstanceRow, [string]>("SELECT * FROM judge_instances WHERE id = ?").get(id);
}

export function instanceByName(db: Database, name: string): InstanceRow | null {
  return db
    .query<InstanceRow, [string]>(
      "SELECT * FROM judge_instances WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL",
    )
    .get(name);
}

export interface NewInstance {
  id: string;
  name: string;
  type: string;
  settingsJson: string;
  secretId: string | null;
  fingerprint: string;
  weight: number;
  enabled: boolean;
  dailyLimit: number | null;
  at: string;
}

export function insertInstance(db: Database, i: NewInstance): void {
  db.query(
    `INSERT INTO judge_instances (id, name, type, settings_json, secret_id, fingerprint, weight,
       enabled, daily_limit, created_at, updated_at)
     VALUES ($id, $name, $type, $settings, $secret, $fingerprint, $weight, $enabled, $limit,
       $at, $at)`,
  ).run({
    id: i.id,
    name: i.name,
    type: i.type,
    settings: i.settingsJson,
    secret: i.secretId,
    fingerprint: i.fingerprint,
    weight: i.weight,
    enabled: i.enabled ? 1 : 0,
    limit: i.dailyLimit,
    at: i.at,
  });
}

export interface InstanceChanges {
  name?: string;
  settingsJson?: string;
  /** undefined: keep; null: no secrets. */
  secretId?: string | null;
  fingerprint?: string;
  weight?: number;
  enabled?: boolean;
  /** undefined: keep; null: no limit. */
  dailyLimit?: number | null;
  /** Clear the failure state, so the judge is tried at once. */
  resetHealth?: boolean;
}

export function updateInstance(db: Database, id: string, c: InstanceChanges, at: string): void {
  db.query(
    `UPDATE judge_instances SET
       name = coalesce($name, name),
       settings_json = coalesce($settings, settings_json),
       secret_id = CASE WHEN $setSecret THEN $secret ELSE secret_id END,
       fingerprint = coalesce($fingerprint, fingerprint),
       weight = coalesce($weight, weight),
       enabled = coalesce($enabled, enabled),
       daily_limit = CASE WHEN $setLimit THEN $limit ELSE daily_limit END,
       failures = CASE WHEN $reset THEN 0 ELSE failures END,
       retry_at = CASE WHEN $reset THEN NULL ELSE retry_at END,
       last_error = CASE WHEN $reset THEN NULL ELSE last_error END,
       last_error_reason = CASE WHEN $reset THEN NULL ELSE last_error_reason END,
       updated_at = $at
     WHERE id = $id`,
  ).run({
    id,
    name: c.name ?? null,
    settings: c.settingsJson ?? null,
    setSecret: c.secretId === undefined ? 0 : 1,
    secret: c.secretId ?? null,
    fingerprint: c.fingerprint ?? null,
    weight: c.weight ?? null,
    enabled: c.enabled === undefined ? null : c.enabled ? 1 : 0,
    setLimit: c.dailyLimit === undefined ? 0 : 1,
    limit: c.dailyLimit ?? null,
    reset: c.resetHealth ? 1 : 0,
    at,
  });
}

/** Deleted judges keep their row (their results name it) but lose their secrets. */
export function markDeleted(db: Database, id: string, at: string): void {
  db.query(
    `UPDATE judge_instances SET deleted_at = ?2, enabled = 0, secret_id = NULL, updated_at = ?2
     WHERE id = ?1`,
  ).run(id, at);
}

/** Deletes judge secrets no judge refers to any more. */
export function deleteUnusedJudgeSecrets(db: Database): void {
  db.run(
    `DELETE FROM secrets WHERE kind = 'judge_settings'
       AND id NOT IN (SELECT secret_id FROM judge_instances WHERE secret_id IS NOT NULL)`,
  );
}

/** A temporary failure: pause the judge until `retryAt`. */
export function recordFailure(
  db: Database,
  id: string,
  f: { message: string; reason: string; at: string; retryAt: string },
): void {
  db.query(
    `UPDATE judge_instances SET failures = failures + 1, last_error = $message,
       last_error_reason = $reason, last_error_at = $at, retry_at = $retryAt
     WHERE id = $id`,
  ).run({ id, ...f });
}

/** A verdict or abstention: the judge is healthy again. */
export function recordSuccess(db: Database, id: string, at: string): void {
  db.query(
    `UPDATE judge_instances SET failures = 0, retry_at = NULL, last_error = NULL,
       last_error_reason = NULL, last_result_at = ?2
     WHERE id = ?1`,
  ).run(id, at);
}

// Attempts -------------------------------------------------------------------

export type AttemptOutcome = "verdict" | "abstain" | "failed";

export function recordAttempt(
  db: Database,
  a: {
    instanceId: string;
    clipId: string;
    at: string;
    outcome: AttemptOutcome;
    reason?: string | null;
  },
): void {
  db.query(
    "INSERT INTO judge_attempts (instance_id, clip_id, at, outcome, reason) VALUES (?, ?, ?, ?, ?)",
  ).run(a.instanceId, a.clipId, a.at, a.outcome, a.reason ?? null);
}

export function pruneAttempts(db: Database, before: string): void {
  db.query("DELETE FROM judge_attempts WHERE at < ?").run(before);
}

/** Runs per judge since `since`: every attempt, and those that gave an answer. */
export function attemptsSince(
  db: Database,
  since: string,
): Map<string, { attempts: number; answered: number }> {
  const rows = db
    .query<{ instance_id: string; attempts: number; answered: number }, [string]>(
      `SELECT instance_id, count(*) AS attempts, sum(outcome <> 'failed') AS answered
       FROM judge_attempts WHERE at >= ? GROUP BY instance_id`,
    )
    .all(since);
  return new Map(rows.map((r) => [r.instance_id, { attempts: r.attempts, answered: r.answered }]));
}

/** Failures of one judge on one clip that were not about the whole service. */
export function clipFailures(db: Database, instanceId: string, clipId: string): number {
  return (
    db
      .query<{ n: number }, [string, string]>(
        `SELECT count(*) AS n FROM judge_attempts
         WHERE instance_id = ? AND clip_id = ? AND outcome = 'failed'
           AND coalesce(reason, 'other') NOT IN ('auth', 'rate_limit', 'quota')`,
      )
      .get(instanceId, clipId)?.n ?? 0
  );
}

// Tests ----------------------------------------------------------------------

export interface TestRow {
  id: string;
  instance_id: string;
  clip_id: string;
  created_at: string;
  expires_at: string;
  finished_at: string | null;
  result_json: string | null;
}

export function insertTest(db: Database, t: Omit<TestRow, "finished_at" | "result_json">): void {
  db.query(
    `INSERT INTO judge_tests (id, instance_id, clip_id, created_at, expires_at)
     VALUES ($id, $instance_id, $clip_id, $created_at, $expires_at)`,
  ).run({ ...t });
}

export function getTest(db: Database, id: string): TestRow | null {
  return db.query<TestRow, [string]>("SELECT * FROM judge_tests WHERE id = ?").get(id);
}

/** Unfinished, unexpired tests no running lease carries, oldest first. */
export function openTests(db: Database, now: string): TestRow[] {
  return db
    .query<TestRow, [string]>(
      `SELECT t.* FROM judge_tests t
       WHERE t.finished_at IS NULL AND t.expires_at > ?1
         AND NOT EXISTS (
           SELECT 1 FROM judge_leases l, json_each(l.judges_json) j
           WHERE l.expires_at > ?1 AND json_extract(j.value, '$.test') = t.id)
       ORDER BY t.created_at`,
    )
    .all(now);
}

export function finishTest(db: Database, id: string, resultJson: string, at: string): void {
  db.query("UPDATE judge_tests SET finished_at = ?, result_json = ? WHERE id = ?").run(
    at,
    resultJson,
    id,
  );
}

export function pruneTests(db: Database, before: string): void {
  db.query("DELETE FROM judge_tests WHERE created_at < ?").run(before);
}

// The outcome rule -------------------------------------------------------------

export function getRule(db: Database): OutcomeRule {
  const row = db
    .query<{ margin: number; minimum: number }, []>(
      "SELECT margin, minimum FROM judging_rule WHERE id = 1",
    )
    .get();
  return row ? { margin: row.margin, minimum: row.minimum } : { margin: 0.5, minimum: 1 };
}

export function setRule(db: Database, rule: OutcomeRule, at: string): void {
  db.query(
    `INSERT INTO judging_rule (id, margin, minimum, updated_at) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET margin = ?1, minimum = ?2, updated_at = ?3`,
  ).run(rule.margin, rule.minimum, at);
}
