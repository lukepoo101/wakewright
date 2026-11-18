import type { Database } from "bun:sqlite";
import { getClip, getClipRow } from "./db/clips.ts";
import {
  type AdvertisedType,
  attemptsSince,
  clipFailures,
  finishTest,
  getInstance,
  getTest,
  type InstanceRow,
  insertTest,
  listInstances,
  openTests,
  pruneAttempts,
  pruneTests,
  recordAttempt,
  recordFailure,
  recordSuccess,
  recordTypes,
  type TestRow,
} from "./db/judges.ts";
import {
  countUnjudged,
  countWaiting,
  deleteExpiredLeases,
  deleteLease,
  findWork,
  getLease,
  insertLease,
  insertResult,
  type JudgeResultRow,
  judgingCounts,
  latestResults,
  type LeasedJudge,
  leasedCounts,
  nextLeaseExpiry,
  type OutcomeContext,
  type Runnable,
  type Verdict,
} from "./db/judging.ts";
import { getWorker, listWorkers, recordReport, touchWorker } from "./db/workers.ts";
import type { SettingValue } from "./judge-settings.ts";
import type { JudgeTypeInfo, Judges } from "./judges.ts";
import type { Logger } from "./log.ts";
import { routedTypes, toRecord, type WorkerIdentity, type WorkerRecord } from "./workers.ts";

// Judging: workers claim clips to judge over /api/worker/v1 (api/worker.ts)
// and send back each judge's verdict. ADRs 0016 and 0019.
//
// - Workers advertise judge types; the owner configures judges (instances
//   of a type with settings and a weight) on the Judges page. A job carries
//   the judges to run on its clip, with their settings.
// - No stored queue: a clip needs judging while it lacks a current result
//   (the type version the worker offers, the judge's settings fingerprint)
//   from an enabled judge whose type the claiming worker offers for the
//   clip's wake word and may run. Newest clips first.
// - A judge that fails temporarily is paused (retry_at) with backoff, or as
//   long as the service asked; a daily limit caps how many clips it judges
//   in any 24 hours, newest first.
// - A claim leases each clip it hands out for LEASE_MS; a second worker
//   skips leased clips, and results for an expired lease are refused.
// - A claim with nothing to do waits (long poll) until a clip is stored, a
//   judge or lease changes, the wait ends, the worker goes away or the
//   server stops.

/** Wire protocol versions this parent speaks. */
export const PROTOCOL = { min: 2, max: 2 } as const;
export const LEASE_MS = 2 * 60_000;
/** A worker counts as connected while polling, or this long after it was last seen. */
export const CONNECTED_MS = 2 * 60_000;
/** Workers seen this recently define what a clip waits for. */
const RECENT_MS = 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;
/** How long a test waits for a worker to take it. */
export const TEST_MS = 3 * 60_000;
/** Failures on one clip (not about the whole service) before it is given up on. */
export const GIVE_UP_AFTER = 5;

export type FailureReason = "auth" | "rate_limit" | "quota" | "network" | "server" | "other";

/** How long to pause a judge after its `failures`-th failure in a row. */
export function retryDelayMs(
  reason: FailureReason,
  failures: number,
  retryAfterSeconds: number | null,
): number {
  if (retryAfterSeconds !== null) {
    return Math.min(DAY_MS, Math.max(5_000, Math.round(retryAfterSeconds * 1000)));
  }
  const min = 60_000;
  const table: Record<FailureReason, [number, number]> = {
    auth: [15 * min, 6 * 60 * min],
    quota: [60 * min, 12 * 60 * min],
    rate_limit: [min / 2, 15 * min],
    network: [min / 2, 30 * min],
    server: [min / 2, 30 * min],
    other: [2 * min, 60 * min],
  };
  const [base, cap] = table[reason];
  return Math.min(cap, base * 2 ** Math.max(0, failures - 1));
}

export interface ClaimRequest {
  worker: { name: string; version: string };
  types: AdvertisedType[];
  max: number;
  waitSeconds: number;
}

export interface JobJudge {
  instance: string;
  type: string;
  settings: Record<string, SettingValue>;
}

export interface Job {
  id: string;
  clipId: string;
  wakeWord: string;
  judges: JobJudge[];
  leaseExpiresAt: string;
}

export interface ResultInput {
  instance: string;
  type: string;
  version: string;
  verdict: Verdict | "failed";
  score: number | null;
  threshold: number | null;
  transcript: string | null;
  detail: string | null;
  failure: { reason: FailureReason; retryAfterSeconds: number | null } | null;
  durationMs: number;
}

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; reason: "stale" }
  | { ok: false; reason: "unexpected"; message: string };

/** A worker record with whether it is connected now. */
export interface WorkerStatus extends WorkerRecord {
  connected: boolean;
}

/** Why a judge is not judging right now, if it is not. */
export type JudgeHealth = "ok" | "idle" | "off" | "failing" | "limited" | "no_worker" | "no_type";

export interface JudgeState {
  health: JudgeHealth;
  /** Workers that may run it and offer its type now (or within the last day). */
  workers: string[];
  /** Runs in the last 24 hours, and how many gave an answer. */
  attempts24h: number;
  judged24h: number;
}

export interface TestResult {
  verdict: Verdict | "failed";
  score: number | null;
  threshold: number | null;
  transcript: string | null;
  detail: string | null;
  failure: { reason: FailureReason; retryAfterSeconds: number | null } | null;
  durationMs: number;
  worker: string;
  version: string;
}

export interface TestView {
  id: string;
  judgeId: string;
  clipId: string;
  createdAt: string;
  expiresAt: string;
  state: "waiting" | "running" | "done" | "expired";
  result: TestResult | null;
}

export interface JudgingOptions {
  db: Database;
  log: Logger;
  judges: Judges;
  now?: () => number;
  leaseMs?: number;
}

export class Judging {
  private readonly db: Database;
  private readonly log: Logger;
  private readonly judges: Judges;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly waiters = new Set<() => void>();
  /** Claims waiting right now, per worker id. */
  private readonly polling = new Map<string, number>();
  private closed = false;

  constructor(options: JudgingOptions) {
    this.db = options.db;
    this.log = options.log.child({ component: "judging" });
    this.judges = options.judges;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? LEASE_MS;
  }

  /**
   * Leases up to `max` clips to the worker, waiting up to `waitSeconds` for
   * one when there is nothing to do now. Records what the worker reported
   * and the types it advertised. Ends with no jobs as soon as the worker is
   * deleted or its token replaced; while it is paused it waits and gets none.
   */
  async claim(worker: WorkerIdentity, request: ClaimRequest, signal?: AbortSignal): Promise<Job[]> {
    const { id } = worker;
    const at = this.iso();
    const offered = request.types.map((t) => ({
      id: t.id,
      version: t.version,
      wakeWords: t.wakeWords,
    }));
    this.db.transaction(() => {
      recordReport(this.db, id, { ...request.worker, types: offered }, at);
      recordTypes(this.db, request.types, at);
    })();
    const deadline = this.now() + request.waitSeconds * 1000;
    this.polling.set(id, (this.polling.get(id) ?? 0) + 1);
    try {
      for (;;) {
        const row = getWorker(this.db, id);
        if (!row || row.token_sha256 !== worker.tokenSha256) return [];
        const leased = this.take(id, request.max, routedTypes(offered, toRecord(row)));
        if (leased.length > 0) {
          const jobs = await this.withSettings(leased);
          this.log.debug("leased clips", { worker: row.name, jobs: jobs.length });
          if (jobs.length > 0) return jobs;
        }
        const left = deadline - this.now();
        if (left <= 0 || this.closed || signal?.aborted) return [];
        // Wake at the deadline, when the next lease expires, or when the
        // first paused judge may run again, whichever comes first.
        const wakes = [left];
        const expiry = nextLeaseExpiry(this.db, this.iso());
        if (expiry !== null) wakes.push(Date.parse(expiry) - this.now() + 1);
        const retry = this.nextRetry();
        if (retry !== null) wakes.push(retry - this.now() + 1);
        await this.wait(Math.max(1, Math.min(...wakes)), signal);
      }
    } finally {
      const n = (this.polling.get(id) ?? 1) - 1;
      if (n > 0) this.polling.set(id, n);
      else this.polling.delete(id);
      touchWorker(this.db, id, this.iso());
    }
  }

  /**
   * Stores a job's results and ends its lease. Refused when its lease has
   * expired, never existed, was released, or belongs to another worker.
   * A verdict or abstention is a result; a failure pauses the judge.
   */
  submit(worker: WorkerIdentity, jobId: string, results: ResultInput[]): SubmitOutcome {
    const now = this.iso();
    const lease = getLease(this.db, jobId);
    if (!lease || lease.expires_at <= now || lease.worker_id !== worker.id) {
      return { ok: false, reason: "stale" };
    }
    const row = getWorker(this.db, worker.id);
    if (!row) return { ok: false, reason: "stale" };
    const leased = JSON.parse(lease.judges_json) as LeasedJudge[];
    const seen = new Set<string>();
    for (const r of results) {
      if (!leased.some((j) => j.instance === r.instance && j.type === r.type)) {
        return {
          ok: false,
          reason: "unexpected",
          message: `This job did not ask for judge ${r.instance} (${r.type}).`,
        };
      }
      if (!leased.some((j) => j.instance === r.instance && j.version === r.version)) {
        return {
          ok: false,
          reason: "unexpected",
          message: `This job asked for ${r.type} at another version than ${r.version}.`,
        };
      }
      if (seen.has(r.instance)) {
        return { ok: false, reason: "unexpected", message: `Two results for ${r.instance}.` };
      }
      seen.add(r.instance);
    }
    this.db.transaction(() => {
      for (const r of results) {
        const j = leased.find((x) => x.instance === r.instance) as LeasedJudge;
        this.record(lease.clip_id, j, r, row.name, now);
      }
      deleteLease(this.db, jobId);
      pruneAttempts(this.db, new Date(this.now() - 7 * DAY_MS).toISOString());
      pruneTests(this.db, new Date(this.now() - DAY_MS).toISOString());
    })();
    touchWorker(this.db, worker.id, now);
    // A failure can pause a judge, a result can finish a test: look again.
    this.notify();
    return { ok: true };
  }

  /** Asks a worker to run one judge on one clip, for the Judges page. */
  startTest(judgeId: string, clipId: string): TestView | null {
    const judge = this.judges.get(judgeId);
    if (!judge || !getClipRow(this.db, clipId)) return null;
    const id = Bun.randomUUIDv7();
    insertTest(this.db, {
      id,
      instance_id: judge.id,
      clip_id: clipId,
      created_at: this.iso(),
      expires_at: new Date(this.now() + TEST_MS).toISOString(),
    });
    this.notify();
    return this.test(id);
  }

  test(id: string): TestView | null {
    const row = getTest(this.db, id);
    return row ? this.testView(row) : null;
  }

  /** New clips were stored, or a worker or judge changed: waiting claims look again. */
  notify(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /** Ends every waiting claim (with no jobs) and stops new ones waiting. */
  close(): void {
    this.closed = true;
    this.notify();
  }

  /** What the outcome SQL needs: the rule, and the judges that can run now. */
  context(workers = this.workers()): OutcomeContext {
    return { rule: this.judges.rule(), runnable: this.runnableNow(workers) };
  }

  /** Workers, whether one is connected, what is waiting and the outcomes. For the UI. */
  status() {
    const workers = this.workers();
    const ctx = this.context(workers);
    const { waiting: pending, ...counts } = judgingCounts(this.db, ctx);
    return {
      workers,
      waiting:
        ctx.runnable.length > 0 ? countWaiting(this.db, ctx.runnable) : countUnjudged(this.db),
      rule: ctx.rule,
      pending,
      ...counts,
    };
  }

  /** Each judge's state: health, the workers that can run it, its runs today. */
  judgeStates(workers = this.workers()): Map<string, JudgeState> {
    const now = this.now();
    const since = new Date(now - DAY_MS).toISOString();
    const runs = attemptsSince(this.db, since);
    const offers = this.recentOffers(workers);
    const types = new Map(this.judges.types().map((t) => [t.id, t]));
    const inFlight = leasedCounts(this.db, this.iso());
    const out = new Map<string, JudgeState>();
    for (const row of listInstances(this.db)) {
      const able = offers.filter((o) => o.type === row.type).map((o) => o.worker);
      const r = runs.get(row.id) ?? { attempts: 0, answered: 0 };
      const leased = inFlight.get(row.id) ?? 0;
      let health: JudgeHealth = "ok";
      if (!row.enabled) health = "off";
      else if (!types.has(row.type)) health = "no_type";
      else if (row.retry_at !== null && Date.parse(row.retry_at) > now) health = "failing";
      else if (row.daily_limit !== null && r.attempts + leased >= row.daily_limit) {
        health = "limited";
      } else if (able.length === 0) health = "no_worker";
      else if (row.last_result_at === null) health = "idle";
      out.set(row.id, {
        health,
        workers: [...new Set(able)].sort((a, b) => a.localeCompare(b)),
        attempts24h: r.attempts,
        judged24h: r.answered,
      });
    }
    return out;
  }

  /**
   * A clip's latest result from each judge (deleted ones included), and the
   * judges that count but have not answered, with why.
   */
  forClip(clipId: string) {
    const workers = this.workers();
    const ctx = this.context(workers);
    const clip = getClip(this.db, clipId, ctx);
    if (!clip) return null;
    const results = latestResults(this.db, clipId);
    const states = this.judgeStates(workers);
    const types = new Map(this.judges.types().map((t) => [t.id, t]));
    const word = clip.wake_word.toLowerCase();
    const pending: { instance: string; reason: PendingReason }[] = [];
    for (const row of listInstances(this.db)) {
      if (!row.enabled) continue;
      const type = types.get(row.type);
      const latest = results.find((r) => r.instance_id === row.id);
      const current =
        latest !== undefined &&
        latest.fingerprint === row.fingerprint &&
        (type === undefined || latest.version === type.version);
      if (current) continue;
      const reason = pendingReason(row, type, states.get(row.id), word);
      pending.push({
        instance: row.id,
        reason: latest !== undefined && reason === "waiting" ? "rejudging" : reason,
      });
    }
    return { clip, results, pending };
  }

  /** Every worker, declared ones first, with whether it is connected. */
  workers(): WorkerStatus[] {
    const now = this.now();
    return listWorkers(this.db).map((row) => {
      const record = toRecord(row);
      const seen = record.reported.lastSeenAt;
      return {
        ...record,
        connected:
          this.polling.has(row.id) || (seen !== null && now - Date.parse(seen) < CONNECTED_MS),
      };
    });
  }

  /** One worker with whether it is connected, or null. */
  worker(id: string): WorkerStatus | null {
    return this.workers().find((w) => w.id === id) ?? null;
  }

  // -- internals --------------------------------------------------------------

  /** Each type that recent, enabled workers offer and may run, per worker. */
  recentOffers(workers: WorkerStatus[] = this.workers()) {
    const since = this.now() - RECENT_MS;
    const out: { worker: string; type: string; version: string; wakeWords: string[] | null }[] = [];
    for (const w of workers) {
      const seen = w.reported.lastSeenAt;
      if (seen === null || (!w.connected && Date.parse(seen) < since)) continue;
      for (const t of routedTypes(w.reported.types, w)) {
        out.push({
          worker: w.name,
          type: t.id,
          version: t.version,
          wakeWords: t.wakeWords?.map((x) => x.toLowerCase()) ?? null,
        });
      }
    }
    return out;
  }

  // The judges that count, can run on a recent worker and are not paused
  // or at their limit: what a clip waits for.
  private runnableNow(workers: WorkerStatus[]): Runnable[] {
    const states = this.judgeStates(workers);
    const offers = this.recentOffers(workers);
    const out = new Map<string, Runnable>();
    for (const row of listInstances(this.db)) {
      if (!row.enabled || row.weight <= 0) continue;
      const health = states.get(row.id)?.health;
      if (health !== "ok" && health !== "idle") continue;
      for (const o of offers.filter((x) => x.type === row.type)) {
        const r: Runnable = {
          instance: row.id,
          type: row.type,
          version: o.version,
          fingerprint: row.fingerprint,
          wakeWords: o.wakeWords,
        };
        out.set(JSON.stringify(r), r);
      }
    }
    return [...out.values()];
  }

  // The judges this worker can run now, for the types it offers and may run.
  private claimable(
    types: { id: string; version: string; wakeWords: string[] | null }[],
    now: number,
  ): { runnable: Runnable[]; remaining: Map<string, number> } {
    const runs = attemptsSince(this.db, new Date(now - DAY_MS).toISOString());
    const leased = leasedCounts(this.db, new Date(now).toISOString());
    const runnable: Runnable[] = [];
    const remaining = new Map<string, number>();
    for (const row of listInstances(this.db)) {
      const t = types.find((x) => x.id === row.type);
      if (!t || !row.enabled) continue;
      if (row.retry_at !== null && Date.parse(row.retry_at) > now) continue;
      if (row.daily_limit !== null) {
        const left =
          row.daily_limit - (runs.get(row.id)?.attempts ?? 0) - (leased.get(row.id) ?? 0);
        if (left <= 0) continue;
        remaining.set(row.id, left);
      }
      runnable.push({
        instance: row.id,
        type: row.type,
        version: t.version,
        fingerprint: row.fingerprint,
        wakeWords: t.wakeWords?.map((w) => w.toLowerCase()) ?? null,
      });
    }
    return { runnable, remaining };
  }

  // One transaction: forget expired leases, lease waiting tests, then clips
  // newest first for the judges this worker can run, within daily limits.
  private take(
    workerId: string,
    max: number,
    types: { id: string; version: string; wakeWords: string[] | null }[],
  ): {
    lease: string;
    clipId: string;
    wakeWord: string;
    judges: LeasedJudge[];
    expiresAt: string;
  }[] {
    if (types.length === 0) return [];
    return this.db.transaction(() => {
      const nowMs = this.now();
      const now = new Date(nowMs).toISOString();
      deleteExpiredLeases(this.db, now);
      const expiresAt = new Date(nowMs + this.leaseMs).toISOString();
      const out: ReturnType<Judging["take"]> = [];
      const lease = (clipId: string, wakeWord: string, judges: LeasedJudge[]) => {
        const id = Bun.randomUUIDv7();
        insertLease(this.db, {
          id,
          clip_id: clipId,
          worker_id: workerId,
          judges_json: JSON.stringify(judges),
          claimed_at: now,
          expires_at: expiresAt,
        });
        out.push({ lease: id, clipId, wakeWord, judges, expiresAt });
      };

      for (const t of openTests(this.db, now)) {
        if (out.length >= max) break;
        const row = getInstance(this.db, t.instance_id);
        const type = row && types.find((x) => x.id === row.type);
        const clip = getClipRow(this.db, t.clip_id);
        if (!row || !type || !clip || row.deleted_at !== null) continue;
        lease(clip.id, clip.wake_word, [
          {
            instance: row.id,
            type: row.type,
            version: type.version,
            fingerprint: row.fingerprint,
            test: t.id,
          },
        ]);
      }

      const { runnable, remaining } = this.claimable(types, nowMs);
      for (const w of findWork(this.db, runnable, now, max - out.length)) {
        const judges: LeasedJudge[] = [];
        for (const j of w.judges) {
          const left = remaining.get(j.instance);
          if (left !== undefined) {
            if (left <= 0) continue;
            remaining.set(j.instance, left - 1);
          }
          judges.push({ ...j, test: null });
        }
        if (judges.length > 0) lease(w.clipId, w.wakeWord, judges);
      }
      return out;
    })();
  }

  // The leased judges with their settings, secrets included, for the worker.
  private async withSettings(leased: ReturnType<Judging["take"]>): Promise<Job[]> {
    const settings = new Map<string, Record<string, SettingValue> | null>();
    const jobs: Job[] = [];
    for (const l of leased) {
      const judges: JobJudge[] = [];
      for (const j of l.judges) {
        if (!settings.has(j.instance)) {
          const row = getInstance(this.db, j.instance);
          settings.set(j.instance, row ? await this.judges.settingsFor(row) : null);
        }
        const s = settings.get(j.instance);
        if (s) judges.push({ instance: j.instance, type: j.type, settings: s });
      }
      if (judges.length === 0) {
        deleteLease(this.db, l.lease);
        continue;
      }
      jobs.push({
        id: l.lease,
        clipId: l.clipId,
        wakeWord: l.wakeWord,
        judges,
        leaseExpiresAt: l.expiresAt,
      });
    }
    return jobs;
  }

  private record(clipId: string, j: LeasedJudge, r: ResultInput, worker: string, now: string) {
    const test: TestResult = {
      verdict: r.verdict,
      score: r.score,
      threshold: r.threshold,
      transcript: r.transcript,
      detail: r.detail,
      failure: r.failure,
      durationMs: Math.round(r.durationMs),
      worker,
      version: r.version,
    };
    if (j.test) finishTest(this.db, j.test, JSON.stringify(test), now);
    const row: JudgeResultRow = {
      clip_id: clipId,
      instance_id: j.instance,
      type: j.type,
      version: j.version,
      fingerprint: j.fingerprint,
      verdict: r.verdict === "failed" ? "abstain" : r.verdict,
      score: r.score,
      threshold: r.threshold,
      transcript: r.transcript,
      detail: r.detail,
      duration_ms: Math.round(r.durationMs),
      worker,
      judged_at: now,
    };
    if (r.verdict !== "failed") {
      insertResult(this.db, row);
      recordAttempt(this.db, {
        instanceId: j.instance,
        clipId,
        at: now,
        outcome: r.verdict === "abstain" ? "abstain" : "verdict",
      });
      recordSuccess(this.db, j.instance, now);
      return;
    }
    const reason = r.failure?.reason ?? "other";
    recordAttempt(this.db, { instanceId: j.instance, clipId, at: now, outcome: "failed", reason });
    const instance = getInstance(this.db, j.instance);
    // Already paused (other clips of the same claim failing the same way):
    // the pause stands; it does not count as another failure in a row.
    if (instance?.retry_at && Date.parse(instance.retry_at) > this.now()) return;
    const failures = (instance?.failures ?? 0) + 1;
    const delay = retryDelayMs(reason, failures, r.failure?.retryAfterSeconds ?? null);
    const message = (r.detail ?? "it failed without saying why").slice(0, 500);
    recordFailure(this.db, j.instance, {
      message,
      reason,
      at: now,
      retryAt: new Date(this.now() + delay).toISOString(),
    });
    this.log.warn("a judge failed and is paused", {
      judge: instance?.name ?? j.instance,
      reason,
      retryInSeconds: Math.round(delay / 1000),
    });
    // A clip that keeps failing on its own, while the service answers
    // others, is given up on with an abstention, so it cannot block the judge.
    if (
      !j.test &&
      !["auth", "rate_limit", "quota"].includes(reason) &&
      clipFailures(this.db, j.instance, clipId) >= GIVE_UP_AFTER
    ) {
      insertResult(this.db, {
        ...row,
        verdict: "abstain",
        detail: `gave up after ${GIVE_UP_AFTER} failed attempts: ${message}`.slice(0, 2000),
      });
    }
  }

  private testView(row: TestRow): TestView {
    const now = this.iso();
    const result = row.result_json === null ? null : (JSON.parse(row.result_json) as TestResult);
    const running = this.db
      .query<{ n: number }, [string, string]>(
        `SELECT count(*) AS n FROM judge_leases l, json_each(l.judges_json) j
         WHERE l.expires_at > ? AND json_extract(j.value, '$.test') = ?`,
      )
      .get(now, row.id);
    return {
      id: row.id,
      judgeId: row.instance_id,
      clipId: row.clip_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      state:
        result !== null
          ? "done"
          : (running?.n ?? 0) > 0
            ? "running"
            : row.expires_at <= now
              ? "expired"
              : "waiting",
      result,
    };
  }

  private nextRetry(): number | null {
    const now = this.now();
    let next: number | null = null;
    for (const row of listInstances(this.db)) {
      if (!row.enabled || row.retry_at === null) continue;
      const at = Date.parse(row.retry_at);
      if (at > now && (next === null || at < next)) next = at;
    }
    return next;
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** Why a judge that counts has not answered a clip. */
export type PendingReason =
  "waiting" | "rejudging" | "no_model" | "failing" | "limited" | "no_worker" | "not_counted";

function pendingReason(
  row: InstanceRow,
  type: JudgeTypeInfo | undefined,
  state: JudgeState | undefined,
  wakeWord: string,
): PendingReason {
  if (type?.wakeWords && !type.wakeWords.includes(wakeWord)) return "no_model";
  if (row.weight <= 0) return "not_counted";
  switch (state?.health) {
    case "failing":
      return "failing";
    case "limited":
      return "limited";
    case "no_worker":
    case "no_type":
      return "no_worker";
    default:
      return "waiting";
  }
}
