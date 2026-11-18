# 0020 Collection sessions: the one write to a device

- Status: accepted
- Date: 2026-11-18
- Amends: [0008 Read-only device access](0008-read-only-device-access.md)

## Context

Wakewright learns from the clips a device saves when its wake word fires
or nearly fires. At everyday settings that is a few clips a day, mostly of
the same kind. Training and evaluation later need many more, of both the
wake word said in different ways and of speech that is not the wake word.
The quickest way to get them is to have a person walk round the room
while the tablet is far more sensitive than usual, for a few minutes.

Doing that by hand means changing three settings in Kiosk Satellite,
remembering the old values and putting them back. A forgotten restore
leaves a tablet that wakes on everything. ADR 0008 kept Wakewright read
only, because a bad change to a voice satellite can break voice control.

## Decision

Wakewright may write to a device in exactly one case, a **collection
session**:

- **Started by the user** from the UI (or API) for one device. One
  unfinished session per device; sessions on several devices at once are
  allowed. Not while collection is paused.
- **Time limited**: 30 seconds to 60 minutes (the UI offers 2 to 60
  minutes, 10 by default). The parent ends it, not the browser.
- **Wake word settings only**: `voice.wake_word_engine`,
  `voice.wake_word_sensitivity` and `voice.wake_word_fine_tune`, through
  `PATCH /api/settings` with the device login the collector already uses.
  The source refuses any other key before sending anything. The wake
  words themselves are never written.
- **Saved first**: the device's settings are read, and the current values
  of exactly the keys the session will change are stored with their
  SHA-256 before anything is written.
- **Confirmed both ways**: the session runs only once a read of the
  device reports every new value. If the device refuses any key or the
  write fails, whatever did change is put back and confirmed, and the
  start fails with nothing left changed.
- **Always restored**: on Stop, at the time limit, when collection is
  paused, and at start-up for any session left starting or running (a
  crash or restart). Restoring reads the device, writes back each saved
  key that differs, reads again and confirms every key matches. Until it
  does, the session stays "restoring", is retried with backoff (5 s,
  doubling, at most 2 minutes apart) and a banner on Home, Devices and the
  session says the tablet is still in collection mode. A saved snapshot
  that fails its hash is never written: the session asks the user to put
  the settings back by hand and shows what was saved. A device with an
  unfinished session cannot be removed or given another address, so its
  password and snapshot stay usable.
- **Traceable**: every write is stored with the session (keys, values,
  purpose, the device's answer) and logged. Values are setting values
  only, never a token or password.

What "most sensitive" means, from Kiosk Satellite's settings definitions
and wake word code (app 2026.11.23):

- Sensitivity `very` (from slightly / moderately / very) multiplies every
  confidence gate of vsWakeWord and microWakeWord by 0.9 and lowers
  openWakeWord's cutoff by 0.1.
- Fine-tune at its maximum, read from the setting's definition (10, on
  -10 to 10), lowers them by a further 0.2 (openWakeWord: 0.1). Together:
  gates at 0.7 of normal, openWakeWord's cutoff 0.3 instead of 0.5.
- The app does not rank its engines. The session recommends
  **microWakeWord**: its probability cutoffs (0.85 to 0.97) fall to 0.6 to
  0.68, and it is the engine that has woken most readily in the
  maintainer's use. The user can pick another. All models ship with the
  app, so switching needs no download and applies at once; but each engine
  has its own wake word ids, and an id the new engine lacks makes the app
  listen for another wake word and tell Home Assistant so. So only engines
  that have every wake word the device listens for are offered.

Kiosk Satellite **fleets** sync the engine and sensitivity from a leader
to its followers and overwrite a follower's own change; the fine-tune is
never synced. On a tablet that leads or follows a fleet (its health says
so), a session raises only the fine-tune.

While a session is open the device is polled every 2 seconds instead of
the usual 10: it keeps only 10 wake words and 10 near misses, and an
engine fires at most every 2 seconds. The app's WebSocket has no topic for
new activations (only a `wakeword-state` change notice), so polling stays.
Each clip recorded in a session is tagged with it, and carries the boosted
settings the session confirmed as its "device settings then" (ADR 0014);
clips recorded while settings were changing get none. The user may note
what they will be doing (saying the wake word, not saying it, mixed); the
note is stored on the session for later training and never votes.

## Consequences

- Wakewright still never installs models, sends audio or changes any
  other setting; recommendations are still applied by hand. A deployer
  would need its own ADR.
- A session can leave a tablet boosted for as long as it cannot be
  reached. That is made loud rather than silent: the banner stays until a
  read of the device confirms the old values.
- Switching engine makes the app ask Home Assistant to reload the
  tablet's ESPHome entry, twice per session: a few seconds without voice
  at the start and the end.
- If someone changes these settings on the tablet during a session, the
  restore still puts back the values saved at the start.
- The fake device accepts and reflects these writes, so unit and E2E
  tests cover start, tagging, Stop, the time limit, a restart, an
  unreachable device and a refused write.
