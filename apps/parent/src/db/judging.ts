import type { Database } from "bun:sqlite";
import { EPSILON, type Outcome, type OutcomeRule } from "../outcome.ts";

// Judge results, leases and the weighted outcome in SQL (migrations 0003 to
// 0005, ADRs 0016 and 0019). Judges and their types are in judges.ts,
// workers in workers.ts.
//
// There is no stored job queue. A clip needs judging while it lacks a
// current result (same type version and settings fingerprint) from a judge
// that a worker may run and that covers the clip's wake word; a lease on
// the clip stops a second worker taking it until the first answers or the
// lease expires.

export type Verdict = "yes" | "no" | "abstain";

export interface JudgeResultRow {
  clip_id: string;
  instance_id: string;
  type: string;
  version: string;
  fingerprint: string;
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

/** One judge in a lease: what the worker must answer for. */
export interface LeasedJudge {
  instance: string;
  type: string;
  version: string;
  fingerprint: string;
  /** Set when the lease carries a test run from the Judges page. */
  test: string | null;
}

/**
 * A judge a worker can run now, at the version it offers: the claim's
 * candidates, and what a clip waits for in the outcome.
 */
export interface Runnable {
  instance: string;
  type: string;
  version: string;
  fingerprint: string;
  /** Lower-case wake words its type has a model for; null for any. */
  wakeWords: string[] | null;
}

export type Mismatch = "false_wake" | "missed_wake";

/** What the outcome SQL needs besides the tables: the rule and what can run now. */
export interface OutcomeContext {
  rule: OutcomeRule;
  runnable: readonly Runnable[];
}

function runnableJson(runnable: readonly Runnable[]): string {
  return JSON.stringify(
    runnable.map((r) => ({ i: r.instance, v: r.version, f: r.fingerprint, w: r.wakeWords })),
  );
}

// A runnable judge (`r`, a row of json_each($runnable)) that covers clip c's
// wake word and has no current result on it.
const RUNNABLE_MISSING = `
  (json_extract(r.value, '$.w') IS NULL
    OR EXISTS (SELECT 1 FROM json_each(json_extract(r.value, '$.w')) w
               WHERE w.value = lower(c.wake_word)))
  AND NOT EXISTS (
    SELECT 1 FROM judge_results x
    WHERE x.clip_id = c.id AND x.instance_id = json_extract(r.value, '$.i')
      AND x.version = json_extract(r.value, '$.v')
      AND x.fingerprint = json_extract(r.value, '$.f'))`;

// Each counted judge's latest result on each clip (whatever its version or
// fingerprint), summed per clip. Counted: not deleted, enabled, weight > 0.
const VOTES = `
  SELECT l.clip_id,
    sum(CASE WHEN l.verdict = 'yes' THEN i.weight ELSE 0 END) AS yes_w,
    sum(CASE WHEN l.verdict = 'no' THEN i.weight ELSE 0 END) AS no_w,
    sum(l.verdict = 'yes') AS yes_n, sum(l.verdict = 'no') AS no_n,
    sum(l.verdict = 'abstain') AS abstain_n, count(*) AS answered
  FROM (
    SELECT clip_id, instance_id, verdict, row_number() OVER (
      PARTITION BY clip_id, instance_id ORDER BY judged_at DESC, version DESC) AS rn
    FROM judge_results) l
  JOIN judge_instances i ON i.id = l.instance_id
  WHERE l.rn = 1 AND i.deleted_at IS NULL AND i.enabled = 1 AND i.weight > 0
  GROUP BY l.clip_id`;

/**
 * Every clip with its device's name and its judging columns: votes_yes,
 * votes_no, votes_abstain (counted judges), yes_weight, no_weight, score,
 * outcome, provisional, dissent and mismatch, computed with the rule in
 * src/outcome.ts. Use as `FROM ${sql}` with `params`; the alias is `c`.
 */
export function clipsWithJudging(ctx: OutcomeContext): {
  sql: string;
  params: Record<string, string | number>;
} {
  const sql = `(
  SELECT z.*,
    CASE WHEN z.outcome = 'waiting' THEN z.provisional ELSE z.outcome END AS leaning,
    CASE
      WHEN z.capture_reason = 'fired' AND z.outcome = 'no' THEN 'false_wake'
      WHEN z.capture_reason = 'near_miss' AND z.outcome = 'yes' THEN 'missed_wake'
    END AS mismatch
  FROM (
    SELECT y.*,
      CASE WHEN y.waiting = 1 OR y.answered = 0 THEN 'waiting' ELSE y.settled END AS outcome,
      CASE WHEN y.answered = 0 THEN NULL ELSE y.settled END AS provisional
    FROM (
      SELECT x.*,
        CASE
          WHEN x.judge_score IS NULL OR x.yes_weight + x.no_weight < $minimum - ${EPSILON} THEN 'not_enough'
          WHEN x.judge_score >= $margin - ${EPSILON} THEN 'yes'
          WHEN x.judge_score <= -$margin + ${EPSILON} THEN 'no'
          ELSE 'uncertain' END AS settled
      FROM (
        SELECT c.*, d.name AS device_name, (d.removed_at IS NOT NULL) AS device_removed,
          cs.note AS session_note, cs.started_at AS session_started_at,
          coalesce(v.yes_n, 0) AS votes_yes, coalesce(v.no_n, 0) AS votes_no,
          coalesce(v.abstain_n, 0) AS votes_abstain, coalesce(v.answered, 0) AS answered,
          coalesce(v.yes_w, 0) AS yes_weight, coalesce(v.no_w, 0) AS no_weight,
          CASE WHEN coalesce(v.yes_w, 0) + coalesce(v.no_w, 0) > 0
            THEN max(-1.0, min(1.0, (v.yes_w - v.no_w) / (v.yes_w + v.no_w))) END AS judge_score,
          EXISTS (SELECT 1 FROM json_each($runnable) r WHERE ${RUNNABLE_MISSING}) AS waiting
        FROM clips c
        JOIN devices d ON d.id = c.device_id
        LEFT JOIN collection_sessions cs ON cs.id = c.collection_session_id
        LEFT JOIN (${VOTES}) v ON v.clip_id = c.id
      ) x
    ) y
  ) z
) c`;
  return {
    sql,
    params: {
      margin: ctx.rule.margin,
      minimum: ctx.rule.minimum,
      runnable: runnableJson(ctx.runnable.filter((r) => r.instance)),
    },
  };
}

/** The columns `clipsWithJudging` adds to a clip. */
export interface JudgingColumns {
  device_name: string;
  device_removed: number;
  /** The clip's collection session, if it has one. */
  session_note: "wake_word" | "not_wake_word" | "mixed" | null;
  session_started_at: string | null;
  votes_yes: number;
  votes_no: number;
  votes_abstain: number;
  answered: number;
  yes_weight: number;
  no_weight: number;
  /** The judges' score, -1 to +1 (`score` is the device's). */
  judge_score: number | null;
  waiting: number;
  settled: Exclude<Outcome, "waiting">;
  outcome: Outcome;
  provisional: Exclude<Outcome, "waiting"> | null;
  /** The outcome, or while waiting the provisional one. */
  leaning: Exclude<Outcome, "waiting"> | null;
  mismatch: Mismatch | null;
}

/** SQL for "a counted judge voted against the outcome" on the `c` columns. */
export const DISSENT = `((c.leaning = 'yes' AND c.votes_no > 0) OR (c.leaning = 'no' AND c.votes_yes > 0))`;

type Params = Record<string, string | number | null>;

export interface Work {
  clipId: string;
  wakeWord: string;
  judges: Runnable[];
}

/**
 * Up to `limit` clips, newest first, that need any of the runnable judges
 * and are not leased at `now`, each with the judges it needs.
 */
export function findWork(
  db: Database,
  runnable: readonly Runnable[],
  now: string,
  limit: number,
): Work[] {
  if (runnable.length === 0 || limit < 1) return [];
  const byInstance = new Map(runnable.map((r) => [r.instance, r]));
  return db
    .query<{ clip_id: string; wake_word: string; judges: string }, Params>(
      `SELECT c.id AS clip_id, c.wake_word,
         json_group_array(json_extract(r.value, '$.i')) AS judges
       FROM clips c, json_each($runnable) r
       WHERE ${RUNNABLE_MISSING}
         AND NOT EXISTS (
           SELECT 1 FROM judge_leases l WHERE l.clip_id = c.id AND l.expires_at > $now)
       GROUP BY c.id
       ORDER BY c.captured_at DESC, c.id DESC
       LIMIT $limit`,
    )
    .all({ runnable: runnableJson(runnable), now, limit })
    .map((r) => ({
      clipId: r.clip_id,
      wakeWord: r.wake_word,
      judges: (JSON.parse(r.judges) as string[])
        .map((id) => byInstance.get(id))
        .filter((j): j is Runnable => j !== undefined),
    }));
}

/** Clips that still need any of the runnable judges, leased or not. */
export function countWaiting(db: Database, runnable: readonly Runnable[]): number {
  if (runnable.length === 0) return 0;
  return (
    db
      .query<{ n: number }, Params>(
        `SELECT count(*) AS n FROM clips c
         WHERE EXISTS (SELECT 1 FROM json_each($runnable) r WHERE ${RUNNABLE_MISSING})`,
      )
      .get({ runnable: runnableJson(runnable) })?.n ?? 0
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

export function deleteLease(db: Database, id: string): void {
  db.query("DELETE FROM judge_leases WHERE id = ?").run(id);
}

/** How many unexpired leases include each judge, for the daily limit. */
export function leasedCounts(db: Database, now: string): Map<string, number> {
  const rows = db
    .query<{ instance: string; n: number }, [string]>(
      `SELECT json_extract(j.value, '$.instance') AS instance, count(*) AS n
       FROM judge_leases l, json_each(l.judges_json) j
       WHERE l.expires_at > ?
       GROUP BY instance`,
    )
    .all(now);
  return new Map(rows.map((r) => [r.instance, r.n]));
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

/** Stores one result (a newer run at the same version and fingerprint replaces it). */
export function insertResult(db: Database, row: JudgeResultRow): void {
  db.query(
    `INSERT INTO judge_results (clip_id, instance_id, type, version, fingerprint, verdict, score,
       threshold, transcript, detail, duration_ms, worker, judged_at)
     VALUES ($clip_id, $instance_id, $type, $version, $fingerprint, $verdict, $score, $threshold,
       $transcript, $detail, $duration_ms, $worker, $judged_at)
     ON CONFLICT (clip_id, instance_id, version, fingerprint) DO UPDATE SET
       verdict = excluded.verdict, score = excluded.score, threshold = excluded.threshold,
       transcript = excluded.transcript, detail = excluded.detail,
       duration_ms = excluded.duration_ms, worker = excluded.worker,
       judged_at = excluded.judged_at`,
  ).run({ ...row });
}

/** Each judge's latest result on a clip, deleted judges included. */
export function latestResults(db: Database, clipId: string): JudgeResultRow[] {
  return db
    .query<JudgeResultRow, [string]>(
      `SELECT clip_id, instance_id, type, version, fingerprint, verdict, score, threshold,
         transcript, detail, duration_ms, worker, judged_at
       FROM (
         SELECT r.*, row_number() OVER (
           PARTITION BY instance_id ORDER BY judged_at DESC, version DESC) AS rn
         FROM judge_results r WHERE clip_id = ?)
       WHERE rn = 1`,
    )
    .all(clipId);
}

export interface JudgingCounts {
  /** Clips with an outcome other than waiting. */
  judged: number;
  yes: number;
  no: number;
  uncertain: number;
  notEnough: number;
  waiting: number;
  /** A counted judge voted against the clip's outcome. */
  dissent: number;
  falseWake: number;
  missedWake: number;
}

export function judgingCounts(db: Database, ctx: OutcomeContext): JudgingCounts {
  const t = clipsWithJudging(ctx);
  const row = db
    .query<Record<string, number | null>, Params>(
      `SELECT sum(outcome <> 'waiting') AS judged, sum(outcome = 'yes') AS yes,
         sum(outcome = 'no') AS no, sum(outcome = 'uncertain') AS uncertain,
         sum(outcome = 'not_enough') AS not_enough, sum(outcome = 'waiting') AS waiting,
         sum(${DISSENT}) AS dissent,
         sum(mismatch = 'false_wake') AS fw, sum(mismatch = 'missed_wake') AS mw
       FROM ${t.sql}`,
    )
    .get(t.params);
  const n = (k: string) => row?.[k] ?? 0;
  return {
    judged: n("judged"),
    yes: n("yes"),
    no: n("no"),
    uncertain: n("uncertain"),
    notEnough: n("not_enough"),
    waiting: n("waiting"),
    dissent: n("dissent"),
    falseWake: n("fw"),
    missedWake: n("mw"),
  };
}
