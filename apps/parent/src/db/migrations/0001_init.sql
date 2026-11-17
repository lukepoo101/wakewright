-- 0001_init: the first schema.
--
-- `instance` holds one row that identifies this installation. Later tables
-- for v0.0.1 (users, devices, secrets, blobs, clips) belong in this file
-- until v0.0.1 is released; after a release, migrations are forward only
-- and every change is a new numbered file.

CREATE TABLE instance (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO instance (id, instance_id, created_at)
VALUES (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
