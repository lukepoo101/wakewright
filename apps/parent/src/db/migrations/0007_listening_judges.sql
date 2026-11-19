-- 0007_listening_judges: a third kind of judge type, `listening` (a model
-- asked directly whether someone says the wake word), beside wake word
-- models and speech to text. SQLite cannot change a CHECK constraint, so
-- judge_types is rebuilt with the wider one; nothing references it by
-- foreign key, and every row is kept as it is. Nothing is judged again.

CREATE TABLE judge_types_v2 (
  id TEXT PRIMARY KEY,                  -- 'openwakeword', 'stt', 'audio-question', ...
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wake_word_model', 'speech_to_text', 'listening')),
  description TEXT NOT NULL DEFAULT '',
  external INTEGER NOT NULL DEFAULT 0 CHECK (external IN (0, 1)), -- sends clips off the worker
  version TEXT NOT NULL,                -- the version a worker last advertised
  wake_words_json TEXT,                 -- ["alexa", ...]; NULL: any wake word
  settings_json TEXT NOT NULL DEFAULT '[]', -- the settings schema (api/worker.ts)
  last_seen_at TEXT                     -- NULL: known only from earlier results
) STRICT;
INSERT INTO judge_types_v2 (id, name, kind, description, external, version, wake_words_json,
  settings_json, last_seen_at)
SELECT id, name, kind, description, external, version, wake_words_json, settings_json,
  last_seen_at
FROM judge_types;
DROP TABLE judge_types;
ALTER TABLE judge_types_v2 RENAME TO judge_types;
