-- 0001_init: the v0.0.1 schema.
--
-- This file may still be edited until v0.0.1 is released; after a release,
-- migrations are forward only and every change is a new numbered file.
-- IDs are UUIDv7 text (time-sortable) unless stated. Timestamps are UTC
-- ISO 8601 text with milliseconds and a Z, so they sort as text.

-- One row that identifies this installation.
CREATE TABLE instance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO instance (id, instance_id, created_at)
VALUES (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Accounts. v0.0.1 has exactly one, the admin.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,          -- Bun.password (argon2id)
  role TEXT NOT NULL CHECK (role IN ('admin')),
  created_at TEXT NOT NULL,
  password_changed_at TEXT NOT NULL
) STRICT;

-- Signed-in browsers. The cookie holds a random token; only its SHA-256 is
-- stored, so a database copy cannot be used to sign in.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);

-- Encrypted values (device passwords): AES-256-GCM with the instance's
-- secret key, which is never stored in the database. Never returned by
-- any API.
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                   -- 'device_password'
  ciphertext BLOB NOT NULL,             -- 12-byte IV || ciphertext || 16-byte tag
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- Voice satellites Wakewright collects from.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  source TEXT NOT NULL,                 -- 'kiosk_satellite'
  config_json TEXT NOT NULL,            -- the source's settings, e.g. {"baseUrl": ...}
  secret_id TEXT REFERENCES secrets(id),
  cursor_json TEXT,                     -- owned by the source: what it has already seen
  reported_json TEXT,                   -- last state read from the device (engine, sensitivity...)
  reported_at TEXT,
  last_poll_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,                 -- NULL after a successful poll
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,  -- consecutive failed polls
  gaps INTEGER NOT NULL DEFAULT 0,      -- polls that found the device's buffer had overflowed
  last_gap_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT                       -- removed devices keep their clips
) STRICT;
CREATE UNIQUE INDEX devices_name ON devices(name) WHERE removed_at IS NULL;

-- Content-addressed files in <data>/blobs/sha256/ab/cd/<sha256>.
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  privacy_class TEXT NOT NULL,          -- 'audio'
  created_at TEXT NOT NULL
) STRICT;

-- One wake word activation or near miss saved by a device.
CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  source_ref TEXT NOT NULL,             -- the device's id for the entry (Kiosk: ms epoch)
  audio_sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  captured_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  capture_reason TEXT NOT NULL CHECK (capture_reason IN ('fired', 'near_miss')),
  wake_word TEXT NOT NULL,
  engine TEXT NOT NULL,
  score REAL,
  threshold REAL,
  peak_db REAL,
  rms_db REAL,
  clipped_samples INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  sensitivity_json TEXT,                -- sensitivity the device reported when the clip arrived
  source_meta_json TEXT NOT NULL,       -- the raw entry: phonemes, edit distance, trigger...
  UNIQUE (device_id, source_ref)
) STRICT;
CREATE INDEX clips_time ON clips(captured_at DESC, id DESC);
CREATE INDEX clips_device_time ON clips(device_id, captured_at DESC);

-- "Pause collection". While a pause is open nothing is pulled, and clips a
-- device captured inside any pause window are never stored.
CREATE TABLE collection_pauses (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  started_by TEXT REFERENCES users(id) ON DELETE SET NULL
) STRICT;
CREATE UNIQUE INDEX collection_pauses_open ON collection_pauses((1)) WHERE ended_at IS NULL;
