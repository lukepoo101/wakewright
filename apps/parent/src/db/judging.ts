import type { Database } from "bun:sqlite";

// Judge results and leases (migrations 0003 and 0004, ADR 0016). Workers
// are in workers.ts.
//
// There is no stored job queue. A clip needs judging while it lacks a
// result for a (judge, version) that a worker offers and that covers the
// clip's wake word; a lease on the clip stops a second worker taking it
// until the first answers or the lease expires.

/** A judge as a worker offers it. `wakeWords` null means any wake word. */
export interface OfferedJudge {
  name: string;
  version: string;
  wakeWords: string[] | null;
}

export type Verdict = "yes" | "no" | "abstain";

export interface JudgeResultRow {
  clip_id: string;
  judge: string;
  version: string;
  verdict: Verdict;
  score: number | null;
  threshold: number | null;
  transcript: string | null;
  detail: string | null;
  duration_ms: number;
  /** The worker's name when it sent the result. */
  worker: string;
  judged_at: string;
}

export interface LeaseRow {
  id: string;
  clip_id: string;
  worker_id: string;
  judges_json: string;
  claimed_at: string;
  expires_at: string;
}

// Each judge's latest result on each clip (the most recent, whatever its
// version), counted per clip. Abstentions are counted but are not votes.
const VOTES = `
  SELECT clip_id,
    sum(verdict = 'yes') AS yes, sum(verdict = 'no') AS no, sum(verdict = 'abstain') AS abstain
  FROM (
    SELECT clip_id, verdict, row_number() OVER (
      PARTITION BY clip_id, judge ORDER BY judged_at DESC, version DESC) AS rn
    FROM judge_results)
  WHERE rn = 1
  GROUP BY clip_id`;

/**
 * Agreement, from the votes of the clip's `v` row (NULL when no judge has
 * answered): waiting, inconclusive (fewer than two votes), disagree, or
 * agree_yes / agree_no (at least two votes, all the same).
 */
const AGREEMENT = `CASE
    WHEN v.clip_id IS NULL THEN 'waiting'
    WHEN v.yes + v.no < 2 THEN 'inconclusive'
    WHEN v.yes > 0 AND v.no > 0 THEN 'disagree'
    WHEN v.yes > 0 THEN 'agree_yes'
    ELSE 'agree_no' END`;

/**
 * Every clip with its device's name and its judging columns: votes_yes,
 * votes_no, votes_abstain, agreement and mismatch (the judges agree against
 * the device: 'false_wake' when it fired, 'missed_wake' on a near miss).
 * Use as `FROM ${CLIPS_WITH_JUDGING}`; the alias is `c`.
 */
export const CLIPS_WITH_JUDGING = `(
  SELECT x.*, CASE
      WHEN x.capture_reason = 'fired' AND x.agreement = 'agree_no' THEN 'false_wake'
      WHEN x.capture_reason = 'near_miss' AND x.agreement = 'agree_yes' THEN 'missed_wake'
    END AS mismatch
  FROM (
    SELECT c.*, d.name AS device_name, (d.removed_at IS NOT NULL) AS device_removed,
      coalesce(v.yes, 0) AS votes_yes, coalesce(v.no, 0) AS votes_no,
      coalesce(v.abstain, 0) AS votes_abstain, ${AGREEMENT} AS agreement
    FROM clips c
    JOIN devices d ON d.id = c.device_id
    LEFT JOIN (${VOTES}) v ON v.clip_id = c.id
  ) x
) c`;

type Params = Record<string, string | number | null>;

export type Agreement = "waiting" | "inconclusive" | "disagree" | "agree_yes" | "agree_no";
export type Mismatch = "false_wake" | "missed_wake";

// The offered judges as a VALUES table with bound parameters, for the
// queries below. Wake words are compared in lower case.
function offeredTable(offered: readonly OfferedJudge[]): {
  sql: string;
  params: Record<string, string | null>;
} {
  const params: Record<string, string | null> = {};
  const rows = offered.map((j, i) => {
    params[`n${i}`] = j.name;
    params[`v${i}`] = j.version;
    params[`w${i}`] =
      j.wakeWords === null ? null : JSON.stringify(j.wakeWords.map((w) => w.toLowerCase()));
    return `($n${i}, $v${i}, $w${i})`;
  });
  return { sql: `offered(name, version, words) AS (VALUES ${rows.join(", ")})`, params };
}

// Offered judges that cover the clip's wake word and have no result on it.
const MISSING = `
  FROM clips c
  JOIN offered o ON o.words IS NULL
    OR EXISTS (SELECT 1 FROM json_each(o.words) w WHERE w.value = lower(c.wake_word))
  WHERE NOT EXISTS (
    SELECT 1 FROM judge_results r
    WHERE r.clip_id = c.id AND r.judge = o.name AND r.version = o.version)`;

export interface Work {
  clipId: string;
  wakeWord: string;
  judges: { name: string; version: string }[];
}

/**
 * Up to `limit` clips, newest first, that need any of the offered judges
 * and are not leased at `now`, each with the judges it needs.
 */
export function findWork(
  db: Database,
  offered: readonly OfferedJudge[],
  now: string,
  limit: number,
): Work[] {
  if (offered.length === 0 || limit < 1) return [];
  const t = offeredTable(offered);
  return db
    .query<{ clip_id: string; wake_word: string; judges: string }, Params>(
      `WITH ${t.sql}
       SELECT c.id AS clip_id, c.wake_word,
         json_group_array(json_object('name', o.name, 'version', o.version)) AS judges
       ${MISSING}
         AND NOT EXISTS (
           SELECT 1 FROM judge_leases l WHERE l.clip_id = c.id AND l.expires_at > $now)
       GROUP BY c.id
       ORDER BY c.captured_at DESC, c.id DESC
       LIMIT $limit`,
    )
    .all({ ...t.params, now, limit })
    .map((r) => ({ clipId: r.clip_id, wakeWord: r.wake_word, judges: JSON.parse(r.judges) }));
}

/** Clips that still need any of the offered judges, leased or not. */
export function countWaiting(db: Database, offered: readonly OfferedJudge[]): number {
  if (offered.length === 0) return 0;
  const t = offeredTable(offered);
  return (
    db
      .query<{ n: number }, Params>(`WITH ${t.sql} SELECT count(DISTINCT c.id) AS n ${MISSING}`)
      .get(t.params)?.n ?? 0
  );
}

/** Clips no judge has answered for yet. */
export function countUnjudged(db: Database): number {
  return (
    db
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM clips c
         WHERE NOT EXISTS (SELECT 1 FROM judge_results r WHERE r.clip_id = c.id)`,
      )
      .get()?.n ?? 0
  );
}

export function deleteExpiredLeases(db: Database, now: string): void {
  db.query("DELETE FROM judge_leases WHERE expires_at <= ?").run(now);
}

export function insertLease(db: Database, lease: LeaseRow): void {
  db.query(
    `INSERT INTO judge_leases (id, clip_id, worker_id, judges_json, claimed_at, expires_at)
     VALUES ($id, $clip_id, $worker_id, $judges_json, $claimed_at, $expires_at)`,
  ).run({ ...lease });
}

export function getLease(db: Database, id: string): LeaseRow | null {
  return db.query<LeaseRow, [string]>("SELECT * FROM judge_leases WHERE id = ?").get(id);
}

/** The earliest expiry among leases still running at `now`, if any. */
export function nextLeaseExpiry(db: Database, now: string): string | null {
  return (
    db
      .query<{ at: string | null }, [string]>(
        "SELECT min(expires_at) AS at FROM judge_leases WHERE expires_at > ?",
      )
      .get(now)?.at ?? null
  );
}

/** Stores a job's results and ends its lease, in one transaction. */
export function recordResults(db: Database, leaseId: string, rows: JudgeResultRow[]): void {
  db.transaction(() => {
    const insert = db.query(
      `INSERT INTO judge_results (clip_id, judge, version, verdict, score, threshold, transcript,
         detail, duration_ms, worker, judged_at)
       VALUES ($clip_id, $judge, $version, $verdict, $score, $threshold, $transcript,
         $detail, $duration_ms, $worker, $judged_at)
       ON CONFLICT (clip_id, judge, version) DO UPDATE SET
         verdict = excluded.verdict, score = excluded.score, threshold = excluded.threshold,
         transcript = excluded.transcript, detail = excluded.detail,
         duration_ms = excluded.duration_ms, worker = excluded.worker,
         judged_at = excluded.judged_at`,
    );
    for (const row of rows) insert.run({ ...row });
    db.query("DELETE FROM judge_leases WHERE id = ?").run(leaseId);
  })();
}

/** Each judge's latest result on a clip, by judge name. */
export function latestResults(db: Database, clipId: string): JudgeResultRow[] {
  return db
    .query<JudgeResultRow, [string]>(
      `SELECT clip_id, judge, version, verdict, score, threshold, transcript, detail,
         duration_ms, worker, judged_at
       FROM (
         SELECT r.*, row_number() OVER (
           PARTITION BY judge ORDER BY judged_at DESC, version DESC) AS rn
         FROM judge_results r WHERE clip_id = ?)
       WHERE rn = 1
       ORDER BY judge`,
    )
    .all(clipId);
}

export interface JudgingCounts {
  judged: number;
  disagree: number;
  falseWake: number;
  missedWake: number;
}

export function judgingCounts(db: Database): JudgingCounts {
  const row = db
    .query<
      { judged: number | null; disagree: number | null; fw: number | null; mw: number | null },
      []
    >(
      `SELECT sum(agreement <> 'waiting') AS judged, sum(agreement = 'disagree') AS disagree,
         sum(mismatch = 'false_wake') AS fw, sum(mismatch = 'missed_wake') AS mw
       FROM ${CLIPS_WITH_JUDGING}`,
    )
    .get();
  return {
    judged: row?.judged ?? 0,
    disagree: row?.disagree ?? 0,
    falseWake: row?.fw ?? 0,
    missedWake: row?.mw ?? 0,
  };
}
