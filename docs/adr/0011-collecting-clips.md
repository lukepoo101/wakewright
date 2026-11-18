# 0011 Collecting clips: a Source interface and an idempotent poller

- Status: accepted
- Date: 2026-11-18

## Context

A Kiosk Satellite device with wake word diagnostics on keeps its last 10
activations and last 10 near misses, each with a 3-second clip, and
overwrites the oldest. Wakewright must copy every clip before it is
overwritten, survive devices that are off, slow or answering nonsense, and
survive its own restarts, without ever writing to a device (ADR 0008).
More kinds of device may follow.

## Decision

- **Source interface** (`apps/parent/src/source.ts`): `connect()` takes a
  device's settings and password and returns a connection with
  `readState()`, `poll(cursor)` and `fetchAudio(entry)`. Errors are a `SourceError` with a code
  (`unreachable`, `timeout`, `auth_failed`, `rate_limited`, `bad_response`,
  `device_error`) that the UI turns into advice. The Kiosk Satellite adapter
  is the first implementation, built in; it becomes a plugin package when a
  second source or the plugin loader arrives.
- **Kiosk adapter**: logs in with the admin password asking for a one-day
  token, keeps it, and logs in again once on a 401. It calls only `login`,
  `health`, `GET /api/settings`, `getWakeWordActivations` and
  `getWakeWordActivationAudio`, with a timeout on every call, no redirects
  and a size limit on answers, and parses every answer with the zod shapes
  the fake device is built from.
- **Polling**, every 10 s by default (`WAKEWRIGHT__COLLECTOR__INTERVAL_SECONDS`).
  The design said 60 s; a device's single extra request every 10 s costs
  little and makes a new clip appear in the UI within seconds. Failures back
  off (interval × 2ⁿ, at most 5 minutes). Settings and health are re-read
  every 5 minutes and after a failure, not on every poll.
- **Idempotent storage**: a clip is unique on `(device_id, source_ref)`.
  Its audio must pass a RIFF check (16 kHz, mono, 16-bit PCM, at most 30 s)
  and is written to the content-addressed blob store (temp file, fsync,
  rename) before the row is inserted, so a crash or restart mid-download
  leaves nothing half-stored, and the next poll fetches it again. A clip the
  device cannot provide as a valid WAV is skipped and logged without
  holding up the others.
- **Gaps**: the cursor is the newest id seen of each kind. A full buffer
  whose oldest entry is newer than the cursor means entries may have been
  overwritten unseen; the device's gap count and time are shown.
- **Pause**: a global toggle stored as a time window. While paused nothing
  is polled, and clips captured inside any pause window are skipped and
  never stored, even after resuming. The device is not touched.
- **Removing a device** forgets its password and stops collection; its
  clips stay, because nothing is deleted except by the user.

## Consequences

Collection needs no worker and no WebSocket; the activations WebSocket can
later wake the poller early. HTTPS devices need a certificate the parent
trusts; fingerprint pinning for self-signed certificates is future work.
One parent replica polls; two would each store every clip once but would
double the device traffic.
