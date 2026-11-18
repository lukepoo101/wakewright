-- 0003_judging: results from judges that workers run on clips, the short
-- leases that stop two workers judging the same clip, and the workers seen.
-- There is no job table: a clip needs judging while it lacks a result for a
-- (judge, version) that a worker offers (ADR 0016).

-- One judge's answer to "does this clip contain its wake word?". A new
-- version of a judge adds a row beside the old one; agreement uses each
-- judge's latest result (src/db/judging.ts).
CREATE TABLE judge_results (
  clip_id TEXT NOT NULL REFERENCES clips(id),
  judge TEXT NOT NULL,                  -- 'openwakeword', 'microwakeword', 'stt', ...
  version TEXT NOT NULL,                -- changes when the judge's model or logic changes
  verdict TEXT NOT NULL CHECK (verdict IN ('yes', 'no', 'abstain')),
  score REAL,
  threshold REAL,
  transcript TEXT,
  detail TEXT,                          -- why it abstained, or anything else worth showing
  duration_ms INTEGER NOT NULL,
  worker TEXT NOT NULL,                 -- the worker's name
  judged_at TEXT NOT NULL,
  PRIMARY KEY (clip_id, judge, version)
) STRICT;

-- A worker's claim on one clip, for the judges named in judges_json. The id
-- is the job id the worker sees. Rows past expires_at mean nothing and are
-- deleted at the next claim.
CREATE TABLE judge_leases (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id),
  worker TEXT NOT NULL,
  judges_json TEXT NOT NULL,            -- [{"name": ..., "version": ...}]
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX judge_leases_clip ON judge_leases(clip_id, expires_at);

-- Every worker that has claimed jobs, by name, with what it last offered.
CREATE TABLE workers (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  judges_json TEXT NOT NULL,            -- [{"name", "version", "wakeWords": [...] | null}]
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
