-- 0002_clip_settings_and_clipping: corrections from the first real data.

-- 1. "Device settings then". 0.0.1 stored the settings the device reported
-- when a clip was collected, which is wrong for older clips a device hands
-- over when it is added. A clip now keeps settings only when they were read
-- within 5 minutes of the moment it was recorded and name the clip's own
-- engine (src/clip-settings.ts, ADR 0014). 0.0.1 read settings at most
-- 5 minutes before collecting a clip, so a snapshot meets that rule when
-- the clip was collected within 5 minutes of being recorded. Every other
-- snapshot becomes unknown.
UPDATE clips SET sensitivity_json = NULL
WHERE sensitivity_json IS NOT NULL
  AND (
    julianday(ingested_at) - julianday(captured_at) > 5.0 / 1440
    OR lower(json_extract(sensitivity_json, '$.engine')) <> lower(engine)
  );

-- 2. A device can report the same wake word in both of its slots; keep
-- each wake word once, in slot order, in clips and in each device's last
-- reported state.
UPDATE clips
SET sensitivity_json = json_set(sensitivity_json, '$.wakeWords', json((
  SELECT json_group_array(value) FROM (
    SELECT value, min(key) AS slot
    FROM json_each(clips.sensitivity_json, '$.wakeWords')
    GROUP BY value ORDER BY slot
  )
)))
WHERE json_type(sensitivity_json, '$.wakeWords') = 'array';

UPDATE devices
SET reported_json = json_set(reported_json, '$.wakeWords', json((
  SELECT json_group_array(value) FROM (
    SELECT value, min(key) AS slot
    FROM json_each(devices.reported_json, '$.wakeWords')
    GROUP BY value ORDER BY slot
  )
)))
WHERE json_type(reported_json, '$.wakeWords') = 'array';

-- 3. Clipping is judged by the longest run of consecutive full-scale
-- samples (src/clipping.ts), measured from the audio when a clip is
-- stored. A clip the device counted no full-scale samples in has none;
-- the rest stay NULL until the parent measures their audio at start-up.
ALTER TABLE clips ADD COLUMN clipped_longest_run INTEGER;
UPDATE clips SET clipped_longest_run = 0 WHERE clipped_samples = 0;
