import type { Database } from "bun:sqlite";
import type { DeclaredWorker } from "./config.ts";
import type { OfferedJudge } from "./db/judging.ts";
import {
  deleteWorker,
  getWorker,
  insertWorker,
  listWorkers,
  releaseLeases,
  setWorkerToken,
  updateWorker,
  type WorkerChanges,
  type WorkerRow,
  type WorkerSource,
  workerByName,
  workerTokenHashes,
} from "./db/workers.ts";
import type { Logger } from "./log.ts";

// Workers as records the parent owns (ADR 0018).
//
// - Each worker has its own token. The database keeps only its SHA-256, as
//   for sessions, so a database copy cannot judge clips. A token is checked
//   against every worker's hash in constant time, without stopping at a
//   match, so timing says nothing about which part matched.
// - A worker is created in the UI, which shows its token once, or declared
//   in configuration (WAKEWRIGHT__WORKERS__<NAME>__*). Configuration is the
//   source of truth for declared workers: applyDeclared() makes the
//   database match it on every start, deletes declared workers no longer
//   configured, and the UI cannot change them.
// - Pausing, deleting or regenerating the token takes effect at once: the
//   worker's leases are released and waiting claims wake (`onChange`).

/** Generated tokens start with this, so secret scanners can recognise them. */
export const TOKEN_PREFIX = "wwk_";
const TOKEN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 43 base62 characters: just over 256 bits. */
const TOKEN_LENGTH = 43;
const HINT_LENGTH = TOKEN_PREFIX.length + 4;

export const WORKER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
export const NOTES_MAX = 500;

/** A new random token: `wwk_` and 43 letters and digits. */
export function generateToken(): string {
  let out = TOKEN_PREFIX;
  while (out.length < TOKEN_PREFIX.length + TOKEN_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(64))) {
      // 248 = 4 × 62: reject the rest so every character is equally likely.
      if (byte < 248 && out.length < TOKEN_PREFIX.length + TOKEN_LENGTH) {
        out += TOKEN_CHARS[byte % 62];
      }
    }
  }
  return out;
}

export function tokenSha256(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/** Compares two equal-length hex digests without an early exit. */
export function sameDigest(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** The start of a generated token, shown to tell tokens apart; null for others. */
function tokenHint(token: string): string | null {
  return token.startsWith(TOKEN_PREFIX) ? token.slice(0, HINT_LENGTH) : null;
}

/** An authenticated worker, as the worker API sees it. */
export interface WorkerIdentity {
  id: string;
  name: string;
  /** The hash of the token it authenticated with; a new token ends its claims. */
  tokenSha256: string;
}

export interface WorkerInput {
  name: string;
  notes?: string;
  enabled?: boolean;
  allowedJudges?: string[] | null;
}

export type WorkerFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "name_taken"; byConfiguration: boolean }
  | { ok: false; reason: "managed" };

export type WorkerOutcome<T> = ({ ok: true } & T) | WorkerFailure;

export interface WorkersOptions {
  db: Database;
  log: Logger;
  now?: () => number;
  /** A worker was paused, deleted or given a new token. */
  onChange?: (workerId: string) => void;
}

export class Workers {
  private readonly db: Database;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly onChange: (workerId: string) => void;

  constructor(options: WorkersOptions) {
    this.db = options.db;
    this.log = options.log.child({ component: "workers" });
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
  }

  /**
   * Makes the declared workers in the database match configuration: adds
   * new ones, updates changed ones (a changed token ends the old one), and
   * deletes declared workers that are no longer configured. A worker made
   * in the UI that has a declared worker's name is renamed, and keeps
   * working, so configuration gets the name it asks for.
   */
  applyDeclared(declared: readonly DeclaredWorker[]): void {
    const at = this.iso();
    const changed: string[] = [];
    this.db.transaction(() => {
      const existing = listWorkers(this.db);
      const wanted = new Map(declared.map((d) => [d.name.toLowerCase(), d]));
      for (const row of existing) {
        if (row.source === "config" && !wanted.has(row.name.toLowerCase())) {
          deleteWorker(this.db, row.id);
          changed.push(row.id);
          this.log.info("removed a worker no longer in configuration", { worker: row.name });
        }
      }
      for (const d of declared) {
        const hash = tokenSha256(d.token);
        const same = workerByName(this.db, d.name);
        if (same && same.source === "ui") {
          const renamed = this.freeName(`${same.name}-created-here`);
          updateWorker(this.db, same.id, { name: renamed }, at);
          this.log.warn(
            "configuration declares a worker with the name of one created in the UI; " +
              "renamed the UI one, which keeps its token",
            { worker: d.name, renamedTo: renamed },
          );
        }
        // A token in use by another worker would make two workers one.
        const owner = workerTokenHashes(this.db).find((w) => sameDigest(w.token_sha256, hash));
        const current = same?.source === "config" ? same : null;
        if (owner && owner.id !== current?.id) {
          throw new Error(
            `Invalid configuration: worker ${d.name}'s token is already another worker's token; ` +
              "give each worker its own",
          );
        }
        if (!current) {
          insertWorker(this.db, {
            id: Bun.randomUUIDv7(),
            name: d.name,
            notes: d.notes,
            enabled: d.enabled,
            allowedJudges: d.judges,
            source: "config",
            tokenSha256: hash,
            tokenHint: tokenHint(d.token),
            at,
          });
          this.log.info("added a worker from configuration", { worker: d.name });
          continue;
        }
        const allowed = d.judges === null ? null : JSON.stringify(d.judges);
        const tokenChanged = !sameDigest(current.token_sha256, hash);
        const differs =
          current.name !== d.name ||
          current.notes !== d.notes ||
          Boolean(current.enabled) !== d.enabled ||
          current.allowed_judges_json !== allowed;
        if (differs) {
          updateWorker(
            this.db,
            current.id,
            { name: d.name, notes: d.notes, enabled: d.enabled, allowedJudges: d.judges },
            at,
          );
        }
        if (tokenChanged) {
          setWorkerToken(this.db, current.id, { sha256: hash, hint: tokenHint(d.token) }, at);
        }
        if (differs || tokenChanged) {
          releaseLeases(this.db, current.id);
          changed.push(current.id);
          this.log.info("updated a worker from configuration", {
            worker: d.name,
            tokenChanged,
          });
        }
      }
    })();
    for (const id of changed) this.onChange(id);
  }

  /** The worker a token belongs to, or null. Never says why not. */
  authenticate(token: string): WorkerIdentity | null {
    if (!token) return null;
    const hash = tokenSha256(token);
    let match: string | null = null;
    for (const w of workerTokenHashes(this.db)) {
      if (sameDigest(w.token_sha256, hash)) match = w.id;
    }
    if (match === null) return null;
    const row = getWorker(this.db, match);
    return row ? { id: row.id, name: row.name, tokenSha256: row.token_sha256 } : null;
  }

  list(): WorkerRow[] {
    return listWorkers(this.db);
  }

  get(id: string): WorkerRow | null {
    return getWorker(this.db, id);
  }

  /** Creates a worker; the token is returned once and never stored. */
  create(input: WorkerInput): WorkerOutcome<{ worker: WorkerRow; token: string }> {
    const taken = this.nameTaken(input.name);
    if (taken) return taken;
    const token = generateToken();
    const id = Bun.randomUUIDv7();
    insertWorker(this.db, {
      id,
      name: input.name,
      notes: input.notes ?? "",
      enabled: input.enabled ?? true,
      allowedJudges: input.allowedJudges ?? null,
      source: "ui",
      tokenSha256: tokenSha256(token),
      tokenHint: tokenHint(token),
      at: this.iso(),
    });
    this.log.info("created a worker", { worker: input.name });
    return { ok: true, worker: getWorker(this.db, id) as WorkerRow, token };
  }

  update(id: string, changes: WorkerChanges): WorkerOutcome<{ worker: WorkerRow }> {
    const row = getWorker(this.db, id);
    if (!row) return { ok: false, reason: "not_found" };
    if (row.source === "config") return { ok: false, reason: "managed" };
    if (changes.name !== undefined) {
      const taken = this.nameTaken(changes.name, id);
      if (taken) return taken;
    }
    const pausing = changes.enabled === false && Boolean(row.enabled);
    const judgesChanged =
      changes.allowedJudges !== undefined &&
      JSON.stringify(changes.allowedJudges) !== (row.allowed_judges_json ?? "null");
    updateWorker(this.db, id, changes, this.iso());
    if (pausing || judgesChanged) releaseLeases(this.db, id);
    this.onChange(id);
    if (pausing) this.log.info("paused a worker", { worker: row.name });
    return { ok: true, worker: getWorker(this.db, id) as WorkerRow };
  }

  /** A new token; the old one stops working at once. */
  regenerateToken(id: string): WorkerOutcome<{ worker: WorkerRow; token: string }> {
    const row = getWorker(this.db, id);
    if (!row) return { ok: false, reason: "not_found" };
    if (row.source === "config") return { ok: false, reason: "managed" };
    const token = generateToken();
    this.db.transaction(() => {
      setWorkerToken(
        this.db,
        id,
        { sha256: tokenSha256(token), hint: tokenHint(token) },
        this.iso(),
      );
      releaseLeases(this.db, id);
    })();
    this.onChange(id);
    this.log.info("gave a worker a new token", { worker: row.name });
    return { ok: true, worker: getWorker(this.db, id) as WorkerRow, token };
  }

  /** Deletes the worker: its token stops working; its past results keep its name. */
  delete(id: string): WorkerOutcome<object> {
    const row = getWorker(this.db, id);
    if (!row) return { ok: false, reason: "not_found" };
    if (row.source === "config") return { ok: false, reason: "managed" };
    deleteWorker(this.db, id);
    this.onChange(id);
    this.log.info("deleted a worker", { worker: row.name });
    return { ok: true };
  }

  private nameTaken(name: string, except?: string): WorkerFailure | null {
    const other = workerByName(this.db, name);
    if (!other || other.id === except) return null;
    return { ok: false, reason: "name_taken", byConfiguration: other.source === "config" };
  }

  private freeName(base: string): string {
    let name = base.slice(0, 64);
    for (let n = 2; workerByName(this.db, name); n++) name = `${base.slice(0, 58)}-${n}`;
    return name;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

/** What the worker API and the UI need from a row. */
export interface WorkerRecord {
  id: string;
  name: string;
  notes: string;
  enabled: boolean;
  source: WorkerSource;
  /** The judges it may run; null for every judge. */
  allowedJudges: string[] | null;
  reported: {
    name: string | null;
    version: string | null;
    judges: OfferedJudge[];
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  };
  token: { hint: string | null; createdAt: string };
  createdAt: string;
  updatedAt: string;
}

export function toRecord(row: WorkerRow): WorkerRecord {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    enabled: Boolean(row.enabled),
    source: row.source,
    allowedJudges:
      row.allowed_judges_json === null ? null : (JSON.parse(row.allowed_judges_json) as string[]),
    reported: {
      name: row.reported_name,
      version: row.reported_version,
      judges:
        row.offered_judges_json === null
          ? []
          : (JSON.parse(row.offered_judges_json) as OfferedJudge[]),
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    },
    token: { hint: row.token_hint, createdAt: row.token_created_at },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The offered judges this worker may run: none while paused. */
export function routedJudges(
  offered: readonly OfferedJudge[],
  worker: { enabled: boolean; allowedJudges: string[] | null },
): OfferedJudge[] {
  if (!worker.enabled) return [];
  const allowed = worker.allowedJudges;
  return allowed === null ? [...offered] : offered.filter((j) => allowed.includes(j.name));
}
