import type { Database } from "bun:sqlite";
import {
  countUsers,
  deleteExpiredSessions,
  deleteSession,
  deleteUserSessions,
  extendSession,
  firstAdmin,
  insertSession,
  insertUser,
  sessionByHash,
  type UserRow,
  updateUser,
  userById,
  userByName,
} from "./db/users.ts";
import type { AuthMode } from "./config.ts";
import type { Logger } from "./log.ts";

// The single local admin account and its browser sessions.
//
// - Passwords are hashed with Bun.password (argon2id).
// - A session is a random 256-bit token in an HttpOnly cookie; the database
//   holds only its SHA-256, so sessions can be listed and revoked and a
//   database copy cannot be used to sign in. Sessions slide: each day of use
//   extends them to SESSION_DAYS from then.
// - Failed sign-ins are throttled per client address (LoginThrottle).
// - When the password comes from configuration (WAKEWRIGHT__ADMIN__PASSWORD
//   or _FILE), configuration is the source of truth: the account is created
//   or updated to match on every start and first-run setup is disabled.
// - With mode "none" (WAKEWRIGHT__AUTH__MODE=none) nothing here is used: no
//   setup, no sign-in, no sessions. A reverse proxy in front must
//   authenticate every request instead. The account, if one exists, is
//   kept, so switching back to "local" restores it.

export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface User {
  id: string;
  username: string;
}

export type LoginResult =
  | { ok: true; user: User; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "throttled"; retryAfterS: number };

export interface AuthOptions {
  db: Database;
  log: Logger;
  /** True when the admin password is managed by configuration. */
  managed: boolean;
  /** "none" turns sign-in off; "local" (the default) requires it. */
  mode?: AuthMode;
  now?: () => number;
  /** Hash parameters; Bun's argon2id defaults unless a test needs speed. */
  hashOptions?: Bun.Password.Argon2Algorithm;
}

export class Auth {
  readonly managed: boolean;
  readonly mode: AuthMode;
  readonly throttle: LoginThrottle;
  private readonly db: Database;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly hashOptions: Bun.Password.Argon2Algorithm | undefined;
  private dummyHash: Promise<string> | undefined;

  constructor(options: AuthOptions) {
    this.db = options.db;
    this.log = options.log;
    this.managed = options.managed;
    this.mode = options.mode ?? "local";
    this.now = options.now ?? Date.now;
    this.throttle = new LoginThrottle(this.now);
    this.hashOptions = options.hashOptions;
  }

  /** "setup" until the admin account exists. */
  state(): "setup" | "ready" {
    return countUsers(this.db) === 0 ? "setup" : "ready";
  }

  /**
   * Makes the account match configuration: creates it, or renames it and
   * replaces its password (ending its sessions) when they differ.
   */
  async applyConfiguredAdmin(admin: { username: string; password: string }): Promise<void> {
    const existing = firstAdmin(this.db);
    const at = this.iso();
    if (!existing) {
      insertUser(this.db, {
        id: Bun.randomUUIDv7(),
        username: admin.username,
        passwordHash: await this.hash(admin.password),
        at,
      });
      this.log.info("created the admin account from configuration", { username: admin.username });
      return;
    }
    const samePassword = await Bun.password.verify(admin.password, existing.password_hash);
    if (samePassword && existing.username === admin.username) return;
    updateUser(this.db, existing.id, {
      username: admin.username,
      passwordHash: samePassword ? existing.password_hash : await this.hash(admin.password),
      at: samePassword ? null : at,
    });
    if (!samePassword) deleteUserSessions(this.db, existing.id);
    this.log.info("updated the admin account from configuration", {
      username: admin.username,
      passwordChanged: !samePassword,
    });
  }

  /** First-run setup: creates the admin account and signs it in. */
  async setup(
    username: string,
    password: string,
  ): Promise<{ ok: true; user: User; token: string; expiresAt: Date } | { ok: false }> {
    if (this.managed || this.mode === "none") return { ok: false };
    const passwordHash = await this.hash(password);
    // Check and insert in one transaction, after the slow hash, so two
    // racing setups cannot both create an account.
    const created = this.db.transaction(() => {
      if (countUsers(this.db) > 0) return null;
      const user = { id: Bun.randomUUIDv7(), username, passwordHash, at: this.iso() };
      insertUser(this.db, user);
      return user;
    })();
    if (!created) return { ok: false };
    this.log.info("created the admin account in first-run setup", { username });
    return { ok: true, user: { id: created.id, username }, ...this.startSession(created.id) };
  }

  async login(username: string, password: string, client: string): Promise<LoginResult> {
    const wait = this.throttle.retryAfter(client);
    if (wait > 0) return { ok: false, reason: "throttled", retryAfterS: wait };

    const row = userByName(this.db, username);
    // Verify against a dummy hash for unknown names so the response time
    // does not reveal whether the name exists.
    const hash = row?.password_hash ?? (await this.getDummyHash());
    const valid = (await Bun.password.verify(password, hash)) && row !== null;
    if (!valid || !row) {
      this.throttle.fail(client);
      this.log.warn("failed sign-in", { client });
      return { ok: false, reason: "invalid" };
    }
    this.throttle.succeed(client);
    deleteExpiredSessions(this.db, this.iso());
    return { ok: true, user: toUser(row), ...this.startSession(row.id) };
  }

  /**
   * The user a session token belongs to, or null. `renewed` is set when the
   * session was extended and the cookie should be sent again.
   */
  authenticate(token: string | undefined): { user: User; renewed?: Date } | null {
    if (!token) return null;
    const hash = hashToken(token);
    const session = sessionByHash(this.db, hash);
    if (!session) return null;
    const now = this.now();
    const expires = Date.parse(session.expires_at);
    if (expires <= now) {
      deleteSession(this.db, hash);
      return null;
    }
    const user = userById(this.db, session.user_id);
    if (!user) return null;
    if (expires - now < (SESSION_DAYS - 1) * DAY_MS) {
      const renewed = new Date(now + SESSION_DAYS * DAY_MS);
      extendSession(this.db, hash, renewed.toISOString());
      return { user: toUser(user), renewed };
    }
    return { user: toUser(user) };
  }

  logout(token: string | undefined): void {
    if (token) deleteSession(this.db, hashToken(token));
  }

  private startSession(userId: string): { token: string; expiresAt: Date } {
    const token = crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: "base64url" });
    const now = this.now();
    const expiresAt = new Date(now + SESSION_DAYS * DAY_MS);
    insertSession(this.db, {
      token_hash: hashToken(token),
      user_id: userId,
      created_at: new Date(now).toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    return { token, expiresAt };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hash(crypto.randomUUID());
    return this.dummyHash;
  }

  private hash(password: string): Promise<string> {
    return this.hashOptions
      ? Bun.password.hash(password, this.hashOptions)
      : Bun.password.hash(password);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

function toUser(row: UserRow): User {
  return { id: row.id, username: row.username };
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/**
 * Failed sign-ins per client address: the first FREE_FAILURES are free,
 * then each further failure locks the address out for twice as long as the
 * last (1 s, 2 s, 4 s ... up to 15 minutes). An address is forgotten 15
 * minutes after its last failure, or at once when it signs in.
 *
 * Behind a reverse proxy every client has the proxy's address, so the limit
 * then applies to everyone together.
 */
export class LoginThrottle {
  static readonly FREE_FAILURES = 5;
  static readonly MAX_LOCK_MS = 15 * 60_000;
  private static readonly MAX_ENTRIES = 10_000;
  private readonly entries = new Map<
    string,
    { failures: number; lockedUntil: number; last: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds the client must wait before trying again; 0 when it may try. */
  retryAfter(client: string): number {
    const entry = this.entries.get(client);
    if (!entry) return 0;
    const now = this.now();
    if (now - entry.last > LoginThrottle.MAX_LOCK_MS && now >= entry.lockedUntil) {
      this.entries.delete(client);
      return 0;
    }
    return Math.max(0, Math.ceil((entry.lockedUntil - now) / 1000));
  }

  fail(client: string): void {
    const now = this.now();
    const entry = this.entries.get(client) ?? { failures: 0, lockedUntil: 0, last: now };
    entry.failures++;
    entry.last = now;
    const over = entry.failures - LoginThrottle.FREE_FAILURES;
    if (over > 0) {
      entry.lockedUntil = now + Math.min(1000 * 2 ** (over - 1), LoginThrottle.MAX_LOCK_MS);
    }
    this.entries.delete(client);
    this.entries.set(client, entry);
    // Oldest first, so a flood of addresses evicts the stalest.
    if (this.entries.size > LoginThrottle.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  succeed(client: string): void {
    this.entries.delete(client);
  }
}
