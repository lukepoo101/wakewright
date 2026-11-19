# Wakewright

[![CI](https://github.com/lukepoo101/wakewright/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lukepoo101/wakewright/actions/workflows/ci.yml?query=branch%3Amain)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lukepoo101/wakewright/badge)](https://scorecard.dev/viewer/?uri=github.com/lukepoo101/wakewright)
[![Release](https://img.shields.io/github/v/release/lukepoo101/wakewright?include_prereleases&sort=semver)](https://github.com/lukepoo101/wakewright/releases)
[![Licence](https://img.shields.io/github/license/lukepoo101/wakewright)](LICENSE)

Wakewright is a self-hosted service that improves wake word detection for
your voice satellites. It collects the short clips your satellites record
when a wake word fires (or nearly fires), keeps them on your own hardware,
and lets you browse and play them. Later versions will label clips, build
datasets, and train and compare wake word models offline.

It works with [Kiosk Satellite](https://github.com/jxlarrea/kiosk-satellite)
devices over their HTTP API. Wakewright reads from a device and never
installs anything on it. The one thing it changes is the wake word
sensitivity, during a collection session you start, for a time limit, and
it always puts the settings back and confirms they are back.

> **Status: pre-alpha.** Wakewright collects Kiosk Satellite clips,
> stores them, and lets you browse and play them in a web UI. A worker
> judges each clip with the judges you configure (openWakeWord,
> microWakeWord, local speech to text, and optional cloud speech-to-text
> and audio-model APIs), weighs their votes into an outcome, and the UI shows the uncertain
> clips and where the outcome disagrees with the device. A collection
> session turns one tablet's sensitivity right up for a few minutes to
> gather many clips at once. Labelling, datasets and training are not built yet. Two images,
> `ghcr.io/lukepoo101/wakewright` (the parent) and
> `ghcr.io/lukepoo101/wakewright-worker`, for amd64 and arm64, carry each
> [release](https://github.com/lukepoo101/wakewright/releases)'s version
> (`latest` is the newest); `edge` is built from every merge to `main`, for
> testing. Expect breaking changes between minor versions before 1.0.

## Using it

- [Getting started with Docker](docs/getting-started.md): `docker run`,
  Docker Compose, Kubernetes, the port, volume and health checks.
- [Configuration reference](docs/configuration.md): every environment
  variable, including the admin password and secret key for GitOps.
- [Kiosk Satellite devices](docs/kiosk-satellite.md): turning on wake word
  diagnostics, adding a device, and what each problem means.
- [Privacy](docs/privacy.md): what is kept, where, and for how long.

## How it fits together

```
 Kiosk Satellite devices ──(HTTP, reads)──► parent ──► SQLite + blob store
                                                  │
                                    browser ◄─────┘ web UI (React SPA)
```

The **parent** is one TypeScript process on [Bun](https://bun.com): a
[Hono](https://hono.dev) API, the React SPA it serves, and SQLite. The
**worker** is a separate Python process that judges clips with plugin
judge types (openWakeWord, microWakeWord, speech to text, cloud
transcription APIs, audio models asked about the wake word) and needs no open port
([docs/worker.md](docs/worker.md), [docs/judges.md](docs/judges.md)); training comes in later versions. See
[docs/architecture.md](docs/architecture.md), and
[docs/design/](docs/design/) for where the project is going and why.

## Development quick start

You need [mise](https://mise.jdx.dev), which installs the pinned Bun.

```sh
mise install          # Bun, as pinned in mise.toml
mise run setup        # bun install --frozen-lockfile
mise run dev          # parent on http://localhost:8080, rebuilt on change,
                      # plus two fake Kiosk Satellite devices
mise run check        # everything CI checks: versions, lockfile, format, lint, types, tests
mise run e2e          # Playwright smoke test against the production build
```

The fake devices listen on ports 23241 and 23242 with the password `dev`
and serve synthetic clips (tones and noise, no speech).

More in [CONTRIBUTING.md](CONTRIBUTING.md),
[docs/development.md](docs/development.md) (tooling and CI),
[docs/RELEASING.md](docs/RELEASING.md) (releases and verifying images) and
[docs/project-health.md](docs/project-health.md) (what is automated).

## Privacy

Clips are 3-second recordings from a room and can include anyone in it.
Wakewright keeps all audio on your hardware, runs no servers of its own and
sends no telemetry ([ADR 0007](docs/adr/0007-no-telemetry.md)). More in
[docs/privacy.md](docs/privacy.md).

## Licence

[Apache-2.0](LICENSE). Kiosk Satellite is a separate project under its own
licence; Wakewright contains none of its code or assets.
