-- 0004_managed_workers: a worker becomes a record the parent owns, with its
-- own token, instead of a name a worker reported with the shared token
-- (ADR 0018). Workers are created in the UI or declared in configuration;
-- what a worker reports about itself is kept beside the record.
--
-- The old `workers` table only remembered names that had claimed jobs and
-- had no token to carry over, so it is dropped. Judge results keep the
-- worker name they were recorded with. Leases last two minutes, so the
-- running ones are dropped rather than converted.

DROP TABLE workers;
DROP TABLE judge_leases;

CREATE TABLE workers (
  id TEXT PRIMARY KEY,                  -- UUIDv7
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  allowed_judges_json TEXT,             -- ["stt", ...]; NULL: every judge
  source TEXT NOT NULL CHECK (source IN ('config', 'ui')),
  token_sha256 TEXT NOT NULL UNIQUE,    -- hex SHA-256 of the token; the token is never stored
  token_hint TEXT,                      -- the start of a generated token, to tell tokens apart
  token_created_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- What the worker last reported in a claim; NULL until it first connects.
  reported_name TEXT,                   -- usually its host name
  reported_version TEXT,
  offered_judges_json TEXT,             -- [{"name", "version", "wakeWords": [...] | null}]
  first_seen_at TEXT,
  last_seen_at TEXT
) STRICT;

-- A worker's claim on one clip, for the judges named in judges_json. The id
-- is the job id the worker sees. Rows past expires_at mean nothing and are
-- deleted at the next claim; a worker's rows go when it is paused, deleted
-- or given a new token.
CREATE TABLE judge_leases (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id),
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  judges_json TEXT NOT NULL,            -- [{"name": ..., "version": ...}]
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX judge_leases_clip ON judge_leases(clip_id, expires_at);
CREATE INDEX judge_leases_worker ON judge_leases(worker_id);
