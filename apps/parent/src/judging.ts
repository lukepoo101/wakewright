import type { Database } from "bun:sqlite";
import { getClip } from "./db/clips.ts";
import {
  countUnjudged,
  countWaiting,
  deleteExpiredLeases,
  findWork,
  getLease,
  insertLease,
  type JudgeResultRow,
  judgingCounts,
  latestResults,
  listWorkers,
  nextLeaseExpiry,
  type OfferedJudge,
  recordResults,
  touchWorker,
  upsertWorker,
  type Verdict,
} from "./db/judging.ts";
import type { Logger } from "./log.ts";

// Judging: workers claim clips to judge over /api/worker/v1 (api/worker.ts)
// and send back each judge's verdict. ADR 0016.
//
// - No stored queue: a clip needs judging while it lacks a result for a
//   (judge, version) the claiming worker offers for its wake word. Newest
//   clips first, so new clips and the backlog are both judged.
// - A claim leases each clip it hands out for LEASE_MS; a second worker
//   skips leased clips, and results for an expired lease are refused, so the
//   clip goes to whoever claims it next.
// - A claim with nothing to do waits (long poll) until a clip is stored, a
//   lease expires, the wait ends, the worker goes away or the server stops.

/** Wire protocol versions this parent speaks. */
export const PROTOCOL = { min: 1, max: 1 } as const;
export const LEASE_MS = 2 * 60_000;
/** A worker counts as connected while polling, or this long after it was last seen. */
export const CONNECTED_MS = 2 * 60_000;
/** Workers seen this recently define the judges a clip waits for. */
const RECENT_MS = 24 * 3_600_000;

export interface ClaimRequest {
  worker: { name: string; version: string };
  judges: OfferedJudge[];
  max: number;
  waitSeconds: number;
}

export interface Job {
  id: string;
  clipId: string;
  wakeWord: string;
  judges: string[];
  leaseExpiresAt: string;
}

export interface ResultInput {
  judge: string;
  version: string;
  verdict: Verdict;
  score: number | null;
  threshold: number | null;
  transcript: string | null;
  detail: string | null;
  durationMs: number;
}

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; reason: "stale" }
  | { ok: false; reason: "unexpected"; message: string };

export interface WorkerStatus {
  name: string;
  version: string;
  judges: OfferedJudge[];
  lastSeenAt: string;
  connected: boolean;
}

export interface JudgingOptions {
  db: Database;
  log: Logger;
  /** Whether a worker token is configured; without one there is no worker API. */
  configured: boolean;
  now?: () => number;
  leaseMs?: number;
}

export class Judging {
  readonly configured: boolean;
  private readonly db: Database;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly waiters = new Set<() => void>();
  /** Claims waiting right now, per worker name. */
  private readonly polling = new Map<string, number>();
  private closed = false;

  constructor(options: JudgingOptions) {
    this.db = options.db;
    this.log = options.log.child({ component: "judging" });
    this.configured = options.configured;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? LEASE_MS;
  }

  /**
   * Leases up to `max` clips to the worker, waiting up to `waitSeconds` for
   * one when there is nothing to do now. Records the worker as seen.
   */
  async claim(request: ClaimRequest, signal?: AbortSignal): Promise<Job[]> {
    const { name } = request.worker;
    upsertWorker(this.db, { ...request.worker, judges: request.judges }, this.iso());
    const deadline = this.now() + request.waitSeconds * 1000;
    this.polling.set(name, (this.polling.get(name) ?? 0) + 1);
    try {
      for (;;) {
        const jobs = this.take(request);
        if (jobs.length > 0) {
          this.log.debug("leased clips", { worker: name, jobs: jobs.length });
          return jobs;
        }
        const left = deadline - this.now();
        if (left <= 0 || this.closed || signal?.aborted) return [];
        // Wake at the deadline, or when the next lease expires and its clip
        // can be handed out again, whichever comes first.
        const expiry = nextLeaseExpiry(this.db, this.iso());
        const untilExpiry = expiry === null ? left : Date.parse(expiry) - this.now() + 1;
        await this.wait(Math.max(1, Math.min(left, untilExpiry)), signal);
      }
    } finally {
      const n = (this.polling.get(name) ?? 1) - 1;
      if (n > 0) this.polling.set(name, n);
      else this.polling.delete(name);
      touchWorker(this.db, name, this.iso());
    }
  }

  /** Stores a job's results. Refused when its lease has expired or never existed. */
  submit(jobId: string, results: ResultInput[]): SubmitOutcome {
    const now = this.iso();
    const lease = getLease(this.db, jobId);
    if (!lease || lease.expires_at <= now) return { ok: false, reason: "stale" };
    const leased = JSON.parse(lease.judges_json) as { name: string; version: string }[];
    const seen = new Set<string>();
    for (const r of results) {
      if (!leased.some((j) => j.name === r.judge && j.version === r.version)) {
        return {
          ok: false,
          reason: "unexpected",
          message: `This job did not ask for ${r.judge} ${r.version}.`,
        };
      }
      if (seen.has(r.judge)) {
        return { ok: false, reason: "unexpected", message: `Two results for ${r.judge}.` };
      }
      seen.add(r.judge);
    }
    const rows: JudgeResultRow[] = results.map((r) => ({
      clip_id: lease.clip_id,
      judge: r.judge,
      version: r.version,
      verdict: r.verdict,
      score: r.score,
      threshold: r.threshold,
      transcript: r.transcript,
      detail: r.detail,
      duration_ms: Math.round(r.durationMs),
      worker: lease.worker,
      judged_at: now,
    }));
    recordResults(this.db, jobId, rows);
    touchWorker(this.db, lease.worker, now);
    return { ok: true };
  }

  /** New clips were stored: waiting claims look again. */
  notify(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /** Ends every waiting claim (with no jobs) and stops new ones waiting. */
  close(): void {
    this.closed = true;
    this.notify();
  }

  /** Workers, whether one is connected, and what is waiting. For the UI. */
  status() {
    const workers = this.workers();
    const offered = this.recentJudges(workers);
    return {
      configured: this.configured,
      workers,
      waiting: offered.length > 0 ? countWaiting(this.db, offered) : countUnjudged(this.db),
      ...judgingCounts(this.db),
    };
  }

  /**
   * A clip's latest result from each judge, and the judges recent workers
   * offer that have not answered: waiting, or without a model for the
   * clip's wake word.
   */
  forClip(clipId: string) {
    const clip = getClip(this.db, clipId);
    if (!clip) return null;
    const results = latestResults(this.db, clipId);
    const answered = new Set(results.map((r) => r.judge));
    const word = clip.wake_word.toLowerCase();
    const byName = new Map<string, OfferedJudge[]>();
    for (const j of this.recentJudges()) {
      byName.set(j.name, [...(byName.get(j.name) ?? []), j]);
    }
    const pending = [...byName]
      .filter(([name]) => !answered.has(name))
      .map(([name, offers]) => ({
        judge: name,
        reason: offers.some((o) => o.wakeWords === null || o.wakeWords.includes(word))
          ? ("waiting" as const)
          : ("no_model" as const),
      }))
      .sort((a, b) => a.judge.localeCompare(b.judge));
    return { results, pending };
  }

  private workers(): WorkerStatus[] {
    const now = this.now();
    return listWorkers(this.db).map((w) => ({
      name: w.name,
      version: w.version,
      judges: JSON.parse(w.judges_json) as OfferedJudge[],
      lastSeenAt: w.last_seen_at,
      connected: this.polling.has(w.name) || now - Date.parse(w.last_seen_at) < CONNECTED_MS,
    }));
  }

  // Each judge recent workers offer, once per (name, version, wake words),
  // with wake words in lower case.
  private recentJudges(workers = this.workers()): OfferedJudge[] {
    const since = this.now() - RECENT_MS;
    const out = new Map<string, OfferedJudge>();
    for (const w of workers) {
      if (!w.connected && Date.parse(w.lastSeenAt) < since) continue;
      for (const j of w.judges) {
        const judge = { ...j, wakeWords: j.wakeWords?.map((x) => x.toLowerCase()) ?? null };
        out.set(JSON.stringify(judge), judge);
      }
    }
    return [...out.values()];
  }

  // One transaction: forget expired leases, find work and lease it.
  private take(request: ClaimRequest): Job[] {
    return this.db.transaction(() => {
      const now = this.iso();
      deleteExpiredLeases(this.db, now);
      const work = findWork(this.db, request.judges, now, request.max);
      const expiresAt = new Date(this.now() + this.leaseMs).toISOString();
      return work.map((w) => {
        const id = Bun.randomUUIDv7();
        insertLease(this.db, {
          id,
          clip_id: w.clipId,
          worker: request.worker.name,
          judges_json: JSON.stringify(w.judges),
          claimed_at: now,
          expires_at: expiresAt,
        });
        return {
          id,
          clipId: w.clipId,
          wakeWord: w.wakeWord,
          judges: w.judges.map((j) => j.name),
          leaseExpiresAt: expiresAt,
        };
      });
    })();
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
