import type { Database } from "bun:sqlite";

// Users and sessions. Plain SQL; row types sit next to their queries.

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: "admin";
  created_at: string;
  password_changed_at: string;
}

export function countUsers(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM users").get()?.n ?? 0;
}

export function firstAdmin(db: Database): UserRow | null {
  return db
    .query<UserRow, []>("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1")
    .get();
}

export function userByName(db: Database, username: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE username = ?").get(username);
}

export function userById(db: Database, id: string): UserRow | null {
  return db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id);
}

export function insertUser(
  db: Database,
  user: { id: string; username: string; passwordHash: string; at: string },
): void {
  db.query(
    `INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at)
     VALUES (?1, ?2, ?3, 'admin', ?4, ?4)`,
  ).run(user.id, user.username, user.passwordHash, user.at);
}

export function updateUser(
  db: Database,
  id: string,
  change: { username: string; passwordHash: string; at: string | null },
): void {
  db.query(
    `UPDATE users SET username = ?2, password_hash = ?3,
       password_changed_at = coalesce(?4, password_changed_at)
     WHERE id = ?1`,
  ).run(id, change.username, change.passwordHash, change.at);
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export function insertSession(db: Database, s: SessionRow): void {
  db.query(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(s.token_hash, s.user_id, s.created_at, s.expires_at);
}

export function sessionByHash(db: Database, tokenHash: string): SessionRow | null {
  return db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE token_hash = ?")
    .get(tokenHash);
}

export function extendSession(db: Database, tokenHash: string, expiresAt: string): void {
  db.query("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(expiresAt, tokenHash);
}

export function deleteSession(db: Database, tokenHash: string): void {
  db.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteUserSessions(db: Database, userId: string): void {
  db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function deleteExpiredSessions(db: Database, now: string): number {
  return db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes;
}
