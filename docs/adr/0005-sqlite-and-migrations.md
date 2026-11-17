# 0005 SQLite with plain SQL and numbered migrations

- Status: accepted
- Date: 2026-11-17

## Context

About 10–20 clips a day, one writer, users on plain Docker as well as
Kubernetes. An extra database container would cost more than it gives.

## Decision

- **`bun:sqlite`**, opened with `strict: true`, `journal_mode=WAL`,
  `synchronous=NORMAL`, `foreign_keys=ON` and `busy_timeout=5000`. Audio
  lives in a content-addressed blob store beside it on the same volume.
- **Plain SQL** with typed `db.query<Row, Params>()` helpers, one module per
  area. A query builder (Drizzle) only if dynamic filtering grows.
- **Migrations** are numbered files `apps/parent/src/db/migrations/NNNN_name.sql`,
  applied in order, one transaction each, tracked by `PRAGMA user_version`.
  Forward only. Before changing an existing schema the parent writes a
  `VACUUM INTO` backup, and it refuses to start on a schema newer than it
  knows.
- The `.sql` files are imported as text (`with { type: "text" }`) and listed
  in `migrate.ts`, so they are bundled into `main.js` and the image needs no
  separate migrations directory. A test checks the list against the
  directory, so a new file cannot be forgotten.

## Consequences

The database volume must be block or local storage, never NFS or CephFS.
The parent runs as one replica. Until v0.0.1 is released, `0001_init.sql`
may still be edited; after that, every schema change is a new file.
