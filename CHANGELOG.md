# Changelog

All notable changes to Wakewright. Each section is also the notes of its
GitHub release. `mise run release <version>` writes the next section from
the pull requests merged since the last release; see
[docs/RELEASING.md](docs/RELEASING.md). Versions follow
[Semantic Versioning](https://semver.org); before 1.0, a minor release may
break things and says how to upgrade.

## 0.4.0-rc.1 - 2026-11-18

### New features

- Pick a new judge's type from a drop-down on the Judges page by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/48
- Add collection sessions that boost one tablet's wake word sensitivity for a time limit, then put it back by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/49

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.3.1...v0.4.0-rc.1

## 0.3.1 - 2026-11-18

### Fixes

- Pause a cloud judge when the provider is out of credit by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/46

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.3.0...v0.3.1

## 0.3.0 - 2026-11-18

Judges are now configurable and weighted. A new **Judges** page lists each
judge with its weight, health and runs in the last 24 hours; add judges of
any type a worker offers (the form comes from the type), set weights and
daily limits, test a judge on one clip, turn it off or delete it. Two
cloud speech-to-text types are new: **OpenAI-compatible transcription**
(OpenAI, Groq, LiteLLM, self-hosted Whisper servers) and **ElevenLabs
Scribe**; none is set up by default, and API keys are stored encrypted and
never shown again. Each clip now has a **weighted outcome** (yes, no,
uncertain, not enough evidence, waiting) with a confidence, replacing "2 of
3 yes"; the Uncertain filter replaces Disagreements. See
[docs/judges.md](docs/judges.md).

Upgrading from 0.2:

- Upgrade the parent and every worker together: they speak worker
  protocol 2 now, and a 0.2 worker is refused until it is upgraded.
- The database migration turns the three judges into judges on the Judges
  page with weights 1.0 (speech to text) and 0.3 (openWakeWord,
  microWakeWord), keeps every verdict and judges nothing again.
- A worker's "may run" list now names judge types; the three names are
  unchanged. Workers offer the cloud types by default, but they run only
  for judges you add; leave them out of `WAKEWRIGHT_WORKER__JUDGES` to make
  sure a worker never sends clips to a cloud service.

### Breaking changes

- Configure weighted judges on a Judges page, with cloud speech-to-text judges by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/42

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.2.0...v0.3.0

## 0.2.0 - 2026-11-18

Each worker now has its own token. A new **Workers** page lists every
worker, whether it is connected, the judges it offers and may run, and what
it reports about itself. Create a worker there and Wakewright shows its
token once, with a pairing string (the parent's address and the token in
one value) and the command to start a worker with it; rename, pause, limit
its judges, give it a new token or delete it, with immediate effect. For
GitOps, declare workers in configuration with
`WAKEWRIGHT__WORKERS__<NAME>__TOKEN(_FILE)`, `__JUDGES`, `__NOTES` and
`__ENABLED`; they show as "Set by configuration" and are read-only in the
UI. The worker accepts the pairing string as `WAKEWRIGHT_WORKER__PAIRING`,
`WAKEWRIGHT_WORKER__PAIRING_FILE` or `run --pairing`. The worker protocol is
still version 1.

### Upgrading from 0.1

The shared `WAKEWRIGHT__WORKER__TOKEN` and `WAKEWRIGHT__WORKER__TOKEN_FILE`
are removed, and the parent refuses to start while either is set. Rename
the variable to declare a worker with the same token, and running workers
(0.1 or 0.2) carry on without a change:

```sh
# before
WAKEWRIGHT__WORKER__TOKEN_FILE=/run/secrets/worker_token
# after: a worker named "my-worker", same token
WAKEWRIGHT__WORKERS__MY_WORKER__TOKEN_FILE=/run/secrets/worker_token
```

Declared tokens are accepted as given (16 characters or more). The
database migrates on start: the list of workers seen so far is replaced by
the new worker records, and every verdict keeps the name of the worker that
gave it. Upgrade the parent and the worker together, as always. See
[docs/configuration.md](https://github.com/lukepoo101/wakewright/blob/main/docs/configuration.md#workers).

### Breaking changes

- Give each worker its own token, managed on a new Workers page or declared in configuration by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/39

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.1.0...v0.2.0

## 0.1.0 - 2026-11-18

Clips are now judged. A second image, `ghcr.io/lukepoo101/wakewright-worker`,
asks openWakeWord, microWakeWord and NVIDIA Parakeet speech to text whether
each clip contains its wake word, and the parent shows where they disagree
with each other and with the device: likely false wakes and likely missed
wake words. To use it, give the parent a worker token
(`WAKEWRIGHT__WORKER__TOKEN`) and start the worker from the same release
([docs/worker.md](https://github.com/lukepoo101/wakewright/blob/main/docs/worker.md)); it downloads about 2.5 GB of models on
first start. Without a worker, the parent works as before. Upgrading needs
no other change; the database migrates on start.

### Security

- Install Debian security updates in the worker image by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/34

### New features

- Judge clips with workers and show where the judges disagree by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/27
- Add a worker that judges clips with openWakeWord, microWakeWord and speech to text by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/28

### Fixes

- Keep the clip filters on one line, the judges' verdict beside the score on a phone and the judging summary first on Home by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/31
- Give the date filters their full width and move Clear filters next to the clip count by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/37

### Documentation

- Point the install examples at the newest release when releasing, and describe the current state in the README by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/30

### CI and tooling

- Publish the parent image again: keep its digests apart from the worker's by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/29
- Run the parent's image job without waiting for the path filter by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/32
- Tag the two images only once both have passed the scan by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/35
- Retry reading a new image index back from the registry when publishing by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/36

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.0.3...v0.1.0

## 0.0.3 - 2026-11-18

### New features

- Let sign-in be turned off for instances behind an authenticating proxy by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/25

### Documentation

- Add design documents for the project's direction by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/24

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.0.2...v0.0.3

## 0.0.2 - 2026-11-18

### Fixes

- Show device settings only for clips recorded near a settings read, list each wake word once and flag clipping only for runs by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/21
- Show each clip's engine, read every score bar against its own threshold and show device names in full by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/22

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.0.1...v0.0.2

## 0.0.1 - 2026-11-18

### New features

- Add the admin account with first-run setup and sign-in by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/2
- Add Kiosk Satellite devices and collect their clips by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/8
- Browse and play collected clips, with a home dashboard by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/12

### Fixes

- Stop repeating device error titles and shorten the kind filter by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/15
- Fix vsWakeWord score bars, the diagnostics-off status colour and the Clipped badge spacing by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/17

### Documentation

- Add CODEOWNERS, Discussions for questions, README badges and a project health page by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/7
- Document running Wakewright with Docker, its devices and privacy by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/14
- Renumber the duplicate ADR 0009 and point the install docs at the 0.0.1 release by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/18

### CI and tooling

- Harden CI: workflow and Dockerfile lint, licence and dependency review, arm64 E2E by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/1
- Set up Renovate for npm packages, Actions, base images and the toolchain by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/3
- Publish multi-arch images from main and release by merging a release pull request by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/4
- Attach the build-stage SBOMs to releases and document cosign verification by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/13

### New contributors

- @lukepoo101 made their first contribution in https://github.com/lukepoo101/wakewright/pull/1

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.0.0...v0.0.1
