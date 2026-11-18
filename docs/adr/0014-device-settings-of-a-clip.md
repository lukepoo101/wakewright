# 0014 The device settings a clip was recorded under

- Status: accepted
- Date: 2026-11-18

## Context

A Kiosk Satellite reports its settings (engine, wake words, sensitivity,
fine-tune) as they are now; a saved activation records only its own
engine, wake word, score and threshold. 0.0.1 stamped every clip with the
settings it had last read when it collected the clip. That is wrong for
clips a device already held: a device added on 18 November handed over
near misses from 8 November that microWakeWord had scored, and they were
shown as recorded under vsWakeWord at "Very sensitive, fine-tune 3", while
a clip whose own threshold was 12.5 was shown with settings that give
10.5. Settings were also re-read only every 5 minutes, so even a new clip
could carry settings a few minutes out of date.

## Options considered

1. **Stamp at collection** (0.0.1): simple, and wrong for any clip not
   recorded just before it was collected.
2. **A time series of settings observations**: a row each time the
   observed settings change (or are confirmed), and a clip's settings
   derived at query time from the observations around its recording.
   Correct in principle, but it adds a table, interval queries on every
   clip read, and a rule for the gap between two observations that differ
   (the change happened somewhere in it), and it still cannot know the
   settings of a clip recorded before the first observation, which is
   exactly the back-filled case. For clips collected as they happen it
   gives the same answer as option 3.
3. **Stamp only when read close to the recording**: the collector reads
   the settings again whenever a poll finds new clips, and stores them
   with a clip only when the read was close enough in time to the
   recording to describe it, and they name the clip's own engine.
   Otherwise the clip's settings are unknown.

## Decision

Option 3, as the simpler design that is correct for every clip it claims
settings for.

- A clip keeps the settings read at time R only when |R − recorded| ≤ 5
  minutes and the settings' engine is the clip's engine (ignoring case).
  Otherwise `sensitivity_json` is NULL and the UI says the settings are
  not known, and why.
- A poll that finds new clips reads the settings first, unless it has
  just done so, so a clip collected as it happens is stamped within
  seconds of its recording. The 5-minute bound covers short delays such as
  a device retrying after a failure; clips delayed longer, and the history
  a newly added device hands over, are unknown.
- The clip's own engine, wake word, score and threshold come from the
  device's entry and are always authoritative; only they are shown for
  the score.
- Migration 0002 corrects 0.0.1 rows. 0.0.1 read settings at most 5
  minutes before collecting a clip, so its snapshot meets the rule exactly
  when the clip was collected within 5 minutes of its recording (and the
  engines match); every other snapshot is cleared. Clips themselves are
  never deleted.

## Consequences

No new table and no query-time derivation: a clip row says what is known
about it. Settings changed and changed back within a few seconds of a clip
could still be mis-attributed; that is accepted. If a later source can
report the settings each clip was recorded with, it fills the same column
directly and the window no longer applies.
