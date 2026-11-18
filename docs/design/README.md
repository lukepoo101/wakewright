# Design

Where Wakewright is going and why. These pages describe the intended
design, not a promise: anything past the next milestone will change as
real data comes in. What is built today is described in
[architecture.md](../architecture.md), and the decisions already taken
are recorded as [ADRs](../adr/).

- [Architecture](architecture.md): the parent, the workers and the pull
  protocol between them.
- [Machine learning](machine-learning.md): judges, agreement, labelling,
  datasets, training, offline evaluation, and the traps that come with a
  small home dataset.
- [User experience](user-experience.md): principles and the main user
  stories.

## Vision

A voice satellite's wake word model is trained on other people's voices
in other people's rooms. It misses some of the times you say the wake word
and fires on some things you did not say. Wakewright helps you measure
that on your own devices, and later improve it, without sending any audio
off your hardware.

The loop it is built towards:

1. **Collect** the short clips your satellites already record when the
   wake word fires or nearly fires.
2. **Judge** each clip with several independent models, and show you the
   clips they disagree on.
3. **Label** clips, mostly automatically, with a person settling the hard
   cases.
4. **Build datasets** from labelled clips and **train** candidate models.
5. **Evaluate** each candidate offline against the model the device runs
   today, with honest confidence intervals, and offer the best one as a
   download with written install instructions.

Wakewright only reads from devices ([ADR 0008](../adr/0008-read-only-device-access.md)).
You apply any setting or model yourself.

## Scope

In scope: wake word detection for self-hosted voice satellites, starting
with [Kiosk Satellite](../kiosk-satellite.md); everything running on the
user's own hardware; plain Docker Compose or Kubernetes.

Out of scope for now:

- Sending anything to a device: settings, models or test audio. A
  "deployer" that installs a model, and canary testing of a model on one
  device before others, are possible future work and would each need a
  new ADR.
- Automatic deployment, promotion or rollback.
- Cloud services, telemetry and hosted offerings
  ([ADR 0007](../adr/0007-no-telemetry.md)).
- General speech-to-text or text-to-speech.

Two product rules shape everything else:

- **Keep everything.** Clips are kept until the user deletes them; there
  are no retention timers. Storage usage and clean-up tools (delete by
  filter, delete everything) are planned.
- **No guest or household distinction.** Anyone who says the wake word is
  a valid example of it. There is no guest mode; pause is the control
  for moments that should not be recorded ([privacy](../privacy.md)).

## Roadmap

| Stage                 | What it delivers                                                                                                                                                                          | Status         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Collect               | Parent on Bun/TypeScript: add Kiosk Satellite devices, collect clips with their device settings, browse and play them, pause                                                              | Built (v0.0.2) |
| Judge                 | Python worker with three judges (openWakeWord, microWakeWord, CPU speech-to-text), counted without weights; a view of the clips they disagree on, and where they disagree with the device | In progress    |
| Review                | A fast review screen where a person labels the clips the judges disagree on; storage view and clean-up tools                                                                              | Later          |
| Label fusion          | Combining judges into calibrated labels so most clips label themselves, with a measured error rate                                                                                        | Later          |
| Datasets and training | Reproducible dataset snapshots, a frozen benchmark, and training of candidate openWakeWord and microWakeWord models                                                                       | Later          |
| Offline evaluation    | Candidates compared with the device's current model, with confidence intervals; the best one offered as a download with install instructions                                              | Later          |
| Desktop worker        | The worker packaged as a Windows app, so a gaming PC's GPU can help                                                                                                                       | Later          |

Each stage is useful on its own. If the data shows a trained model cannot
beat the device's own model, Wakewright remains a tool for collecting,
labelling and understanding wake word behaviour, which is still worth
having.
