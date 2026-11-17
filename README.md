# Wakewright

Wakewright is a self-hosted service that improves wake word detection for
your voice satellites. It collects the short clips your satellites record
when a wake word fires (or nearly fires), keeps them on your own hardware,
and lets you browse and play them. Later versions will label clips, build
datasets, and train and compare wake word models offline.

It works with [Kiosk Satellite](https://github.com/jxlarrea/kiosk-satellite)
devices over their HTTP API. Wakewright only reads from a device; it never
changes its settings or installs anything on it.

> **Status: pre-alpha.** Nothing here is usable yet. The repository holds
> the foundation for v0.0.1: collect Kiosk Satellite clips, store them, and
> browse and play them in a web UI. There are no releases or published
> images.

## How it fits together

```
 Kiosk Satellite devices ──(HTTP, read only)──► parent ──► SQLite + blob store
                                                  │
                                    browser ◄─────┘ web UI (React SPA)
```

The **parent** is one TypeScript process on [Bun](https://bun.com): a
[Hono](https://hono.dev) API, the React SPA it serves, and SQLite. Python
**workers** for judging and training come in later versions. See
[docs/architecture.md](docs/architecture.md).

## Development quick start

You need [mise](https://mise.jdx.dev), which installs the pinned Bun.

```sh
mise install          # Bun, as pinned in mise.toml
mise run setup        # bun install --frozen-lockfile
mise run dev          # parent on http://localhost:8080 with hot reload,
                      # plus two fake Kiosk Satellite devices
mise run check        # everything CI checks: versions, lockfile, format, lint, types, tests
mise run e2e          # Playwright smoke test against the production build
```

The fake devices listen on ports 23241 and 23242 with the password `dev`
and serve synthetic clips (tones and noise, no speech).

More in [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/development.md](docs/development.md).

## Privacy

Clips are 3-second recordings from a room and can include anyone in it.
Wakewright keeps all audio on your hardware, runs no servers of its own and
sends no telemetry ([ADR 0007](docs/adr/0007-no-telemetry.md)).

## Licence

[Apache-2.0](LICENSE). Kiosk Satellite is a separate project under its own
licence; Wakewright contains none of its code or assets.
