# Changelog

All notable changes to Wakewright. Each section is also the notes of its
GitHub release. `mise run release <version>` writes the next section from
the pull requests merged since the last release; see
[docs/RELEASING.md](docs/RELEASING.md). Versions follow
[Semantic Versioning](https://semver.org); before 1.0, a minor release may
break things and says how to upgrade.

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
