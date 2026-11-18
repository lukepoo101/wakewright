-- 0006_collection_sessions: collection sessions (ADR 0020), the one time
-- Wakewright writes to a device. A user starts one for one device; the
-- parent raises the device's wake word sensitivity for a time limit,
-- collects every clip it saves quickly, then puts the settings back and
-- confirms them by reading them again.
--
-- - collection_sessions: one row per session. snapshot_json holds the
--   device's values of the keys the session changes, read before anything
--   was written, with their SHA-256 so a damaged row is noticed rather than
--   restored wrongly. A row is kept for good: it is the history, and the
--   snapshot outlives the device's own row being removed.
-- - collection_session_writes: every settings write a session made, with
--   the keys and values written (never a token or password) and how the
--   device answered, so a change on a device can be traced to its session.
-- - clips.collection_session_id: the session a clip was recorded in.

CREATE TABLE collection_sessions (
  id TEXT PRIMARY KEY,                  -- UUIDv7
  device_id TEXT NOT NULL REFERENCES devices(id),
  device_name TEXT NOT NULL,            -- as it was named when the session started
  -- starting: writing; running: boosted; restoring: putting the snapshot
  -- back; ended: confirmed back (or nothing was changed); needs_attention:
  -- the snapshot cannot be used, the user must put the settings back.
  state TEXT NOT NULL
    CHECK (state IN ('starting', 'running', 'restoring', 'ended', 'needs_attention')),
  note TEXT CHECK (note IS NULL OR note IN ('wake_word', 'not_wake_word', 'mixed')),
  engine TEXT NOT NULL,                 -- the engine setting value the session runs
  limit_seconds INTEGER NOT NULL CHECK (limit_seconds BETWEEN 30 AND 3600),
  snapshot_json TEXT NOT NULL,          -- {setting key: value before}, only the keys changed
  snapshot_sha256 TEXT NOT NULL,
  target_json TEXT NOT NULL,            -- {setting key: value written}
  applied_settings_json TEXT,           -- the settings read back once boosted (clip stamps)
  created_at TEXT NOT NULL,             -- asked to start
  started_at TEXT,                      -- the boosted settings were confirmed
  ends_at TEXT,                         -- started_at + limit_seconds
  restore_started_at TEXT,
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN
    ('stopped', 'time_limit', 'paused', 'parent_restart', 'start_failed')),
  restore_attempts INTEGER NOT NULL DEFAULT 0,
  next_restore_at TEXT,
  last_error TEXT,
  restored_at TEXT,                     -- the device was read back with every snapshot value
  resolved_by_hand_at TEXT,             -- needs_attention: the user put them back
  ended_at TEXT,
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL
) STRICT;

-- One unfinished session per device.
CREATE UNIQUE INDEX collection_sessions_one_open ON collection_sessions(device_id)
  WHERE state IN ('starting', 'running', 'restoring', 'needs_attention');
CREATE INDEX collection_sessions_time ON collection_sessions(created_at DESC);

CREATE TABLE collection_session_writes (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES collection_sessions(id),
  at TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('apply', 'undo_start', 'restore')),
  values_json TEXT NOT NULL,            -- {setting key: value} sent
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'rejected', 'failed')),
  detail TEXT
) STRICT;
CREATE INDEX collection_session_writes_session ON collection_session_writes(session_id, id);

ALTER TABLE clips ADD COLUMN collection_session_id TEXT REFERENCES collection_sessions(id);
CREATE INDEX clips_collection_session ON clips(collection_session_id)
  WHERE collection_session_id IS NOT NULL;
