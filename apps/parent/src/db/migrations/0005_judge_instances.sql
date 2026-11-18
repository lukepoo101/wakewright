-- 0005_judge_instances: judges become instances the owner configures, of
-- judge types that workers advertise, with weights (ADR 0019).
--
-- - judge_types: every type a worker has advertised, with its settings
--   schema, so the Judges page can show a form for it with no code per type.
-- - judge_instances: a judge as the owner set it up: a type, settings (secret
--   values sealed in `secrets`), weight, enabled, a daily limit and its
--   health. The three judges every worker ran so far become instances with
--   the type's id as their id, so their verdicts carry over unchanged.
-- - judge_results gains the instance and the fingerprint of the settings
--   that can change a verdict. Existing results belong to the migrated
--   instances, whose settings are empty: sha256("{}") below. Nothing already
--   judged is judged again.
-- - judge_attempts counts what each judge did (for the daily limit, "today"
--   and giving up on a clip that keeps failing); judge_tests holds the Judges
--   page's test runs; judging_rule holds the outcome's margin and minimum.
-- - The worker protocol changes (2), so running leases are dropped.

DROP TABLE judge_leases;

CREATE TABLE judge_types (
  id TEXT PRIMARY KEY,                  -- 'openwakeword', 'stt', 'openai-compatible', ...
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wake_word_model', 'speech_to_text')),
  description TEXT NOT NULL DEFAULT '',
  external INTEGER NOT NULL DEFAULT 0 CHECK (external IN (0, 1)), -- sends clips off the worker
  version TEXT NOT NULL,                -- the version a worker last advertised
  wake_words_json TEXT,                 -- ["alexa", ...]; NULL: any wake word
  settings_json TEXT NOT NULL DEFAULT '[]', -- the settings schema (api/worker.ts)
  last_seen_at TEXT                     -- NULL: known only from earlier results
) STRICT;

CREATE TABLE judge_instances (
  id TEXT PRIMARY KEY,                  -- UUIDv7; the migrated three use their type's id
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}', -- values of the non-secret settings
  secret_id TEXT REFERENCES secrets(id),    -- the secret settings, sealed as one JSON object
  fingerprint TEXT NOT NULL,            -- sha256 of the settings that can change a verdict
  weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 10),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  daily_limit INTEGER CHECK (daily_limit IS NULL OR daily_limit >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,                      -- deleted: not run or counted, its history kept
  -- Health: temporary failures pause the judge until retry_at.
  failures INTEGER NOT NULL DEFAULT 0,  -- in a row
  last_error TEXT,
  last_error_reason TEXT,               -- auth, rate_limit, quota, network, server, other
  last_error_at TEXT,
  retry_at TEXT,
  last_result_at TEXT
) STRICT;
CREATE UNIQUE INDEX judge_instances_name ON judge_instances(name COLLATE NOCASE)
  WHERE deleted_at IS NULL;

-- The types and instances every worker had until now. Each type's version
-- is the one its latest result has, so those results stay current.
INSERT INTO judge_types (id, name, kind, description, version)
VALUES
  ('openwakeword', 'openWakeWord', 'wake_word_model', '',
    coalesce((SELECT version FROM judge_results WHERE judge = 'openwakeword'
              ORDER BY judged_at DESC LIMIT 1), '')),
  ('microwakeword', 'microWakeWord', 'wake_word_model', '',
    coalesce((SELECT version FROM judge_results WHERE judge = 'microwakeword'
              ORDER BY judged_at DESC LIMIT 1), '')),
  ('stt', 'Parakeet speech to text', 'speech_to_text', '',
    coalesce((SELECT version FROM judge_results WHERE judge = 'stt'
              ORDER BY judged_at DESC LIMIT 1), ''));

INSERT INTO judge_instances (id, name, type, fingerprint, weight, created_at, updated_at)
VALUES
  ('stt', 'Speech to text', 'stt',
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 1.0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('openwakeword', 'openWakeWord', 'openwakeword',
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 0.3,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('microwakeword', 'microWakeWord', 'microwakeword',
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 0.3,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Any other judge a worker reported (another implementation of the
-- protocol) becomes a wake word type and an instance of it too.
INSERT INTO judge_types (id, name, kind, version)
SELECT judge, judge, 'wake_word_model', max(version) FROM judge_results
WHERE judge NOT IN ('openwakeword', 'microwakeword', 'stt')
GROUP BY judge;
INSERT INTO judge_instances (id, name, type, fingerprint, weight, created_at, updated_at)
SELECT DISTINCT judge, judge, judge,
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', 0.3,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM judge_results WHERE judge NOT IN ('openwakeword', 'microwakeword', 'stt');

UPDATE judge_instances SET last_result_at =
  (SELECT max(judged_at) FROM judge_results r WHERE r.judge = judge_instances.id);

-- One judge's answer to "does this clip contain its wake word?", from one
-- instance at one type version and settings fingerprint. A new version or
-- fingerprint adds a row beside the old one; the outcome uses each
-- instance's latest result (src/db/judging.ts).
CREATE TABLE judge_results_v2 (
  clip_id TEXT NOT NULL REFERENCES clips(id),
  instance_id TEXT NOT NULL REFERENCES judge_instances(id),
  type TEXT NOT NULL,
  version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('yes', 'no', 'abstain')),
  score REAL,
  threshold REAL,
  transcript TEXT,
  detail TEXT,
  duration_ms INTEGER NOT NULL,
  worker TEXT NOT NULL,
  judged_at TEXT NOT NULL,
  PRIMARY KEY (clip_id, instance_id, version, fingerprint)
) STRICT;
INSERT INTO judge_results_v2 (clip_id, instance_id, type, version, fingerprint, verdict, score,
  threshold, transcript, detail, duration_ms, worker, judged_at)
SELECT clip_id, judge, judge, version,
  '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', verdict, score,
  threshold, transcript, detail, duration_ms, worker, judged_at
FROM judge_results;
DROP TABLE judge_results;
ALTER TABLE judge_results_v2 RENAME TO judge_results;
CREATE INDEX judge_results_instance ON judge_results(instance_id, judged_at);

-- Every run of a judge on a clip, kept for a week.
CREATE TABLE judge_attempts (
  instance_id TEXT NOT NULL REFERENCES judge_instances(id),
  clip_id TEXT NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('verdict', 'abstain', 'failed')),
  reason TEXT                           -- for a failure: auth, rate_limit, quota, ...
) STRICT;
CREATE INDEX judge_attempts_instance ON judge_attempts(instance_id, at);
CREATE INDEX judge_attempts_clip ON judge_attempts(clip_id, instance_id);

-- A worker's claim on one clip, for the judges in judges_json:
-- [{"instance", "type", "version", "fingerprint", "test": id | null}].
CREATE TABLE judge_leases (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id),
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  judges_json TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX judge_leases_clip ON judge_leases(clip_id, expires_at);
CREATE INDEX judge_leases_worker ON judge_leases(worker_id);

-- "Test" on the Judges page: run one judge on one clip and show what it said.
CREATE TABLE judge_tests (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES judge_instances(id),
  clip_id TEXT NOT NULL REFERENCES clips(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,             -- no worker took it by then: given up
  finished_at TEXT,
  result_json TEXT                      -- what the worker sent, with its name
) STRICT;

-- How the weighted votes become an outcome (src/outcome.ts).
CREATE TABLE judging_rule (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  margin REAL NOT NULL CHECK (margin >= 0 AND margin <= 1),
  minimum REAL NOT NULL CHECK (minimum >= 0),
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO judging_rule VALUES (1, 0.5, 1.0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- What a worker last offered, in the new shape: [{"id", "version", "wakeWords"}].
UPDATE workers SET offered_judges_json = (
  SELECT json_group_array(json_object(
    'id', json_extract(j.value, '$.name'),
    'version', json_extract(j.value, '$.version'),
    'wakeWords', json(coalesce(json_extract(j.value, '$.wakeWords'), 'null'))))
  FROM json_each(workers.offered_judges_json) j)
WHERE offered_judges_json IS NOT NULL;
