# Machine learning

How Wakewright decides what is in a clip, and how it plans to turn that
into better wake word models. Judging is the next milestone and is
described in detail; the later stages are sketched, and will be designed
properly when the data exists to test them.

## What a clip is, and what it is not

Kiosk Satellite, a third-party app, keeps a clip when **wake word
diagnostics** are on ([how to turn them on](../kiosk-satellite.md)). For
each wake word activation, and each near miss (a score of at least 75%
of the threshold that did not fire), it saves a 3-second, 16 kHz mono
16-bit WAV with the engine's score, threshold and some signal levels. It
keeps the last 10 of each kind and overwrites the oldest. The clip ends at
the moment of detection, so the wake word sits near its end.

That shapes everything downstream:

- **Selection bias.** A clip exists only where the device's own model
  scored close to or above its threshold. A wake word the model missed
  badly is never recorded, and neither is the silence in between, so
  household clips give rates _conditional_ on the device noticing
  something, never an absolute false wake rate per hour. Every metric says
  which kind of clip it was computed on.
- **Small numbers.** A home produces tens of clips a day at most. Every
  comparison needs a confidence interval, and many will honestly be "not
  distinguishable yet".
- **The device's model is a baseline, not something to retrain.** The
  bundled vsWakeWord engine has
  [no public trainer](https://github.com/jxlarrea/kiosk-satellite/issues/992), and the app and its
  models are licensed CC BY-NC-ND 4.0. Wakewright uses only the score and
  threshold the device recorded, which give its decision on every clip it
  produced, and contains no code or models from the app.

## Judges

A judge answers one question about a clip: does it contain its wake word?
The verdict is `yes`, `no` or `abstain`. The first three judges run in the
worker:

| Judge           | How it decides                                                                                                                                   | Yes when                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `openwakeword`  | The [openWakeWord](https://github.com/dscripka/openWakeWord) pretrained model for the clip's wake word, highest score over the clip              | score ≥ 0.5                           |
| `microwakeword` | The [microWakeWord](https://github.com/esphome/micro-wake-word-models) pretrained model for the clip's wake word, with its manifest's own cutoff | the model fires                       |
| `stt`           | CPU speech-to-text; the transcript is lower-cased and stripped of punctuation                                                                    | the transcript contains the wake word |

A judge with no model for a clip's wake word abstains and says why. Judges
are pure functions of the audio and the clip's metadata: they never see
each other's answers, so any of them can be re-run when its version
changes.

They were chosen because they fail differently. Two acoustic detectors
with different architectures disagree on different clips, and speech-to-text
answers through words rather than sound, so it catches clips that sound
right but are not (and stumbles on homophones and mumbling). None of them
can tell a person from a television saying the same word.

### Models and licences

| Model                             | Licence                                  | Consequence                                                             |
| --------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| openWakeWord pretrained models    | CC BY-NC-SA 4.0 (the code is Apache-2.0) | Downloaded by the worker on first use; never in the repository or image |
| microWakeWord models from ESPHome | Apache-2.0                               | Downloaded the same way, for consistency                                |
| vsWakeWord (on the device)        | CC BY-NC-ND 4.0                          | Used only through the score the device recorded                         |

## Agreement

The first milestone keeps this deliberately simple: no weights, no
calibration, just a count. Using each judge's latest result and ignoring
abstentions, a clip is:

| State                    | Meaning                          |
| ------------------------ | -------------------------------- |
| `waiting`                | no results yet                   |
| `agree_yes` / `agree_no` | at least two votes, all the same |
| `disagree`               | the votes differ                 |
| `inconclusive`           | fewer than two votes             |

The most useful view compares the judges with the **device**. A clip
the device fired on that the judges agree is not the wake word is likely a
false wake; a near miss the judges agree _is_ the wake word is likely a
missed wake. Those are the clips that teach a model something, and the
UI makes them easy to find.

## Later: review and label fusion

Disagreements go to a person. A review screen plays each clip and takes a
one-key answer: the wake word said by a person, the wake word from a
television or speaker, not the wake word, or unsure. Clips from a speaker
are kept apart because training them as negatives would teach a model to
reject anything heard through a loudspeaker channel, which far-field
speech partly shares.

With enough human labels, a fitted combination of the judges can replace
the simple count: plain rules at first, then a small logistic model that
gives a calibrated probability, refitted as labels grow. Clips the model
is very sure of, and that at least two independent judges agree on, are
labelled automatically; the rest go to review. A random sample of
automatic labels is reviewed blind every week, so the automatic error rate
is measured, not assumed. If it stays high, training waits.

## Later: datasets and training

A dataset is an immutable snapshot: a manifest listing each clip by hash
with its label, where the label came from, and its split. Two rules guard
against leakage:

- **Episodes.** Clips seconds apart (a retry, or two devices hearing the
  same words) are near-identical, so they form one episode and always
  land in the same split.
- **Time, not chance.** Splits are by time, with the newest episodes held
  out for validation. A frozen, human-labelled **benchmark** is the test
  set; its episodes never enter training, and it is replaced by a new
  version rather than edited.

Household clips alone are too few to train on. Candidates mix them,
weighted up, with synthetic speech and public negative audio downloaded
on first use. The first training track is a small openWakeWord classifier
on CPU; microWakeWord follows on a GPU worker. Licences carry through: a
model built on a non-commercially licensed base is marked as such and is
for personal use.

A model that needs no training comes first if the data supports it: from
labelled clips and the scores the device recorded, a recommendation for
the device's own sensitivity setting, which the user applies by hand.

## Later: offline evaluation

Every candidate is compared with the device's current model on the same
clips, both on the frozen benchmark and on clips collected after the
candidate was trained. The headline is the miss rate at a fixed false
wake rate per hour, with paired confidence intervals (a bootstrap over
episodes). Absolute false wakes per hour can only come from long public
recordings, for the selection bias reason above. A candidate is
recommended only when it is not worse on any measure and better by enough
to be worth installing; "insufficient data" is a normal answer.

Evaluation is offline only. Wakewright scores its own models with an
offline copy of the device's detection logic and never replays audio on a
device, so a model that wins offline may still behave differently once
installed. The clips it produces after a hand install are the check.

## Traps

- **Circularity.** A model must not learn from labels it helped produce.
  When training a model of one family (say openWakeWord), clips enter only
  if a person labelled them, or if a label combination fitted _without_
  that family's judges is confident. The benchmark is human-only, so
  circularity cannot reach the evaluation.
- **Selection bias.** Clips exist only where the device nearly fired.
  Report metrics per capture kind, use public audio for absolute rates,
  and accept that badly missed wake words are a blind spot. Guided
  sessions, where the user turns the device's sensitivity up by hand for a
  few minutes and says the wake word at different distances, widen what is
  captured.
- **Small numbers.** With 200 benchmark positives only differences of
  several percentage points in miss rate can be shown. Always compare
  paired, on the same clips; keep hyperparameter searches tiny; never
  select on the benchmark.
- **Leakage.** Near-duplicate clips across splits flatter every model;
  episode grouping and time splits exist to prevent it.
