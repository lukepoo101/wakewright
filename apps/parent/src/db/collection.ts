import type { Database } from "bun:sqlite";

// "Pause collection": an open row in collection_pauses means paused.

export interface PauseRow {
  id: string;
  started_at: string;
  ended_at: string | null;
}

export function openPause(db: Database): PauseRow | null {
  return db
    .query<PauseRow, []>(
      "SELECT id, started_at, ended_at FROM collection_pauses WHERE ended_at IS NULL",
    )
    .get();
}

/** Starts a pause unless one is open; returns the open pause. */
export function startPause(
  db: Database,
  p: { id: string; at: string; userId: string | null },
): PauseRow {
  db.query(
    `INSERT INTO collection_pauses (id, started_at, started_by) VALUES (?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(p.id, p.at, p.userId);
  return openPause(db) as PauseRow;
}

export function endPause(db: Database, at: string): void {
  db.query("UPDATE collection_pauses SET ended_at = ? WHERE ended_at IS NULL").run(at);
}

/** True when `at` falls inside any pause, open or closed. */
export function insidePause(db: Database, at: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM collection_pauses
         WHERE started_at <= ?1 AND (ended_at IS NULL OR ended_at >= ?1)`,
      )
      .get(at)?.n !== 0
  );
}
