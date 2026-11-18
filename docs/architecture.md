# Architecture

Wakewright has two kinds of process:

- The **parent**: always on, one replica. It owns all state (clips,
  metadata, later labels, datasets and the model registry), pulls clips from
  devices and serves the web UI and API. It contains no machine-learning
  libraries. TypeScript on Bun.
- **Workers** (from a later milestone): stateless Python processes that pull
  judging, training and evaluation jobs from the parent over HTTPS. They are
  not part of v0.0.1.

The planned design, from the workers' pull protocol to training and
offline evaluation, is in [design/](design/).

v0.0.1 is the parent only: add Kiosk Satellite devices, collect their wake
word clips, store them, and browse and play them.

## The parent

```
            ┌───────────────────────── parent (one Bun process) ─────────────────────────┐
 browser ──►│ Bun.serve ─► Hono: /healthz /readyz /api/*  ─┐    static SPA (dist/public)  │
            │                                              ▼                              │
            │   collector ──► Source (Kiosk) ──► blob store + bun:sqlite (WAL, /data)     │
            └──────────────────────│───────────────────────────────────────────────────┘
                                   ▼ HTTP, read only
                       Kiosk Satellite devices (:2324)
```

- **HTTP**: [Hono](https://hono.dev) on `Bun.serve`. Every route is declared
  with `@hono/zod-openapi`, so zod validates it and the OpenAPI 3.1 document
  at `/api/openapi.json` describes it. The SPA calls the API through
  `hc<AppType>()`, typed from the server's routes with no code generation.
- **Web UI**: a React SPA (TanStack Router and Query, CSS Modules on the
  custom properties in `tokens.css`), built by `bun build` and served as
  static files from the same origin. Every non-API GET answers `index.html`
  so client-side routes survive a reload.
- **Data**: `bun:sqlite` with WAL, plain SQL and numbered migrations on
  `PRAGMA user_version`; audio in a content-addressed blob store under
  `/data/blobs/sha256/`. The database must live on block or local storage,
  never NFS or CephFS.
- **Configuration**: `WAKEWRIGHT__SECTION__KEY` environment variables,
  validated by zod at start-up ([configuration.md](configuration.md)).
  Settings a user edits (devices and so on) live in the database.
- **Sign-in**: one local admin account (`Bun.password`, argon2id), created
  in first-run setup or from configuration, with server-side sessions in an
  `HttpOnly`, `SameSite=Lax` cookie, a same-origin check on changes and a
  throttled login ([ADR 0013](adr/0013-admin-account-and-sessions.md)). The
  SPA shows setup or sign-in in place of every screen until it has a session.
  `WAKEWRIGHT__AUTH__MODE=none` turns sign-in off for deployments behind an
  authenticating proxy ([ADR 0015](adr/0015-sign-in-off-behind-a-proxy.md)).
- **Collection**: the collector (`ingest.ts`) polls each device through a
  `Source` (`source.ts`; the Kiosk Satellite adapter is in `kiosk/`), every
  10 s by default with backoff on failure, and stores each new clip once:
  audio checked as 16 kHz mono PCM WAV and written to the blob store, then
  its row inserted, unique per device and source id. A clip keeps the
  device's settings only when they were read within 5 minutes of its
  recording ([ADR 0014](adr/0014-device-settings-of-a-clip.md)), and the
  longest run of full-scale samples is measured from its audio for the
  clipping flag (`clipping.ts`). A pause toggle stops
  polling and skips clips captured while paused. Device passwords are
  encrypted with AES-256-GCM under a key kept outside the database
  ([ADR 0011](adr/0011-collecting-clips.md),
  [ADR 0012](adr/0012-device-password-encryption.md)).
- **Clips**: `/api/v1/clips` lists clips newest first with filters (device,
  kind, engine, time) and paging; one clip comes with its newer and older neighbours
  under the same filter, and its audio is served with `Range`, `ETag` and a
  private cache policy so the browser can seek. The SPA draws the waveform
  with wavesurfer.js from the WAV itself; lists play through one shared
  `<audio>` element. Home shows the first-run steps until the first clip
  arrives, then collection health and the latest clips.
- **Backups**: `Bun.cron` runs `VACUUM INTO /data/backups/wakewright-YYYYMMDD.sqlite3`
  at 03:30 every night and keeps 14. Audio blobs are immutable, so
  file-level backup tools copy them incrementally.
- **Health**: `/healthz` (the process is alive) and `/readyz` (the database
  is migrated and writable). The image's `HEALTHCHECK` runs
  `main.js healthcheck`, because the distroless base has no shell or curl.

## Repository layout

```
apps/parent/          @wakewright/parent: the server
  src/main.ts         production entry: serve | migrate | healthcheck
  src/dev.ts          development entry: same API + the SPA via Bun's HTML import
  src/boot.ts         shared start-up: open DB, migrate, build the API, start loops
  src/config.ts       WAKEWRIGHT__* environment schema
  src/auth.ts         admin account, sessions, login throttle
  src/source.ts       the Source interface every kind of device implements
  src/ingest.ts       the collector: polling, storing clips, status, pause
  src/clip-settings.ts which device settings a clip may claim (ADR 0014)
  src/clipping.ts     measuring full-scale runs; clipping-rule.ts: when a clip counts as clipped
  src/devices.ts      device management: sources, encrypted passwords, testing
  src/crypto.ts       AES-256-GCM for stored secrets; the instance key
  src/blobs.ts        content-addressed blob store
  src/wav.ts          RIFF/WAVE header reader
  src/backup.ts       nightly VACUUM INTO backups
  src/log.ts          JSON-lines logger
  src/spa.ts          serves the built SPA
  src/api/            one file per API area, mounted in api/index.ts (exports AppType)
  src/db/             db.ts (connection), migrate.ts (runner + list), migrations/NNNN_*.sql
  src/kiosk/          Kiosk Satellite: client.ts, source.ts (the adapter), shapes.ts (zod shapes)
  test/               bun test: unit and in-process integration tests
apps/web/             @wakewright/web: the SPA
  index.html  src/{main.tsx,router.tsx,api.ts,tokens.css}
  src/pages/          one component per screen, routed in router.tsx (AuthPages: setup, sign-in)
  src/player.tsx      the shared <audio> element for list playback
  src/components/     shared components (AudioPlayer: wavesurfer.js waveform)
devtools/
  dev.ts              `mise run dev`: parent + two fake devices
  fake-kiosk/         @wakewright/fake-kiosk: fake device + synthetic clips
deploy/docker/        parent.Dockerfile
deploy/compose/       docker-compose.yml: the reference Compose file
scripts/              repository checks run by `mise run check`
tests/e2e/            Playwright: smoke tests and the first-run path against a fake device
docs/                 this documentation and the ADRs
```

## The fake device

The fake device in `devtools/fake-kiosk` builds its responses from the same
`kiosk/shapes.ts`, so the client and the fake cannot drift apart silently.
It behaves like the real app where Wakewright depends on it: a password,
tokens that expire, login throttling, a ring buffer of 10 per kind, settings
with wake word diagnostics on or off that can change (`setSettings()`), new
clips over time (`hear()`), older clips from an earlier engine handed over
at start (`history`), the same wake word in two slots, and clips that touch
full scale at one sample or clip outright.
Tests inject faults through `faults` (offline, slow, malformed list, invalid
audio, a download that breaks); `mise run dev` and E2E reach the same
controls over HTTP under `/_fake/`. Extend it alongside the client.

## Decisions

Architecture decisions are recorded in [adr/](adr/):

- 0001 [Licence: Apache-2.0](adr/0001-licence-apache-2.0.md)
- 0002 [A parent and stateless workers](adr/0002-parent-and-workers.md)
- 0003 [TypeScript on Bun for the parent](adr/0003-typescript-on-bun.md)
- 0004 [Hono API with a React SPA](adr/0004-hono-api-and-react-spa.md)
- 0005 [SQLite with plain SQL and numbered migrations](adr/0005-sqlite-and-migrations.md)
- 0006 [Tooling: Bun, Biome for lint, mise tasks](adr/0006-tooling.md)
- 0007 [No telemetry](adr/0007-no-telemetry.md)
- 0008 [Read-only device access](adr/0008-read-only-device-access.md)
- 0009 [CI checks, fork safety and speed](adr/0009-ci-checks-and-fork-safety.md)
- 0010 [Releases, changelog and published images](adr/0010-releases-changelog-and-images.md)
- 0011 [Collecting clips: a Source interface and an idempotent poller](adr/0011-collecting-clips.md)
- 0012 [Device passwords encrypted with an instance key](adr/0012-device-password-encryption.md)
- 0013 [One local admin account with server-side sessions](adr/0013-admin-account-and-sessions.md)
- 0014 [The device settings a clip was recorded under](adr/0014-device-settings-of-a-clip.md)
- 0015 [Sign-in can be turned off for an authenticating proxy](adr/0015-sign-in-off-behind-a-proxy.md)
