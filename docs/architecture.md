# Architecture

Wakewright has two kinds of process:

- The **parent**: always on, one replica. It owns all state (clips,
  metadata, later labels, datasets and the model registry), pulls clips from
  devices and serves the web UI and API. It contains no machine-learning
  libraries. TypeScript on Bun.
- **Workers**: stateless processes that pull work from the parent over
  HTTP(S) and need no inbound port. Today they judge clips; training and
  evaluation come later. The parent runs and shows clips with no worker.

The planned design, from the workers' pull protocol to training and
offline evaluation, is in [design/](design/).

Built so far: the parent adds Kiosk Satellite devices, collects their wake
word clips, stores them and lets you browse and play them; the worker
judges each clip with the judges configured on the Judges page, and the
parent weighs their votes into an outcome per clip.

## The parent

```
            ┌───────────────────────── parent (one Bun process) ─────────────────────────┐
 browser ──►│ Bun.serve ─► Hono: /healthz /readyz /api/*  ─┐    static SPA (dist/public)  │
            │                                              ▼                              │
            │   collector ──► Source (Kiosk) ──► blob store + bun:sqlite (WAL, /data)     │
            └──────────────────────│───────────────────────────────────────────────────┘
                                   ▼ HTTP: reads; wake word settings only in a collection session
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
- **Collection sessions** (`sessions.ts`, `db/sessions.ts`,
  `kiosk/collection-mode.ts`, `/api/v1/collection-sessions`): the one
  write to a device. For a time limit the user sets, one device runs its
  most sensitive wake word settings (engine, sensitivity, fine-tune) and
  is polled every 2 s; its clips are tagged with the session. The values
  it changes are saved with a hash before the write, confirmed after it,
  and written back and confirmed on Stop, at the time limit (a loop in the
  parent), on pause and at start-up after a crash, retried with backoff
  until a read of the device matches
  ([ADR 0020](adr/0020-collection-sessions.md)).
- **Clips**: `/api/v1/clips` lists clips newest first with filters (device,
  kind, engine, time, collection session) and paging; one clip comes with its newer and older neighbours
  under the same filter, and its audio is served with `Range`, `ETag` and a
  private cache policy so the browser can seek. The SPA draws the waveform
  with wavesurfer.js from the WAV itself; lists play through one shared
  `<audio>` element. Home shows the first-run steps until the first clip
  arrives, then collection health, judging and the latest clips.
- **Workers** (`workers.ts`, `db/workers.ts`): each worker is a record
  with its own token, of which only the SHA-256 is stored, created on the
  Workers page (`/api/v1/workers`, which shows the token once with a
  pairing string) or declared in configuration
  (`WAKEWRIGHT__WORKERS__<NAME>__*`, applied on every start and read-only
  in the UI). Pausing, deleting or a new token releases its leases at once
  ([ADR 0018](adr/0018-workers-with-their-own-tokens.md)).
- **Judges** (`judges.ts`, `db/judges.ts`, `judge-settings.ts`,
  `/api/v1/judges`): workers advertise judge types with a settings schema
  in each claim; the parent keeps the latest (`judge_types`). A judge is an
  instance of a type set up on the Judges page: settings checked against
  the schema, secret ones sealed with the instance key, a weight, an
  optional daily limit and a health state (paused after a temporary
  failure). A test run sends one judge and clip to the next suitable
  claim ([ADR 0019](adr/0019-configurable-weighted-judges.md),
  [judges.md](judges.md)).
- **Judging** (`judging.ts`, `db/judging.ts`): workers call
  `/api/worker/v1` (protocol 2) with their own token to claim clips (a long
  poll that the collector wakes when it stores a clip), download their
  audio and send back each judge's result ([workers.md](workers.md)).
  There is no job table: a clip needs judging while it lacks a current
  result (the offered type version, the judge's settings fingerprint)
  from an enabled judge whose type the worker offers for its wake word and
  may run, within the judge's daily limit; a two-minute lease keeps two
  workers off one clip. The weighted outcome (`outcome.ts`: yes, no,
  uncertain, not enough evidence, waiting) and disagreement with the
  device (likely false wake, likely missed wake word) are computed in SQL
  from each judge's latest result, so the clip list filters on them and a
  new weight applies at once ([ADR 0016](adr/0016-judging-queue-and-agreement.md),
  [ADR 0019](adr/0019-configurable-weighted-judges.md)).
  `docs/api/worker-v1.openapi.json` is the committed wire format.
- **Backups**: `Bun.cron` runs `VACUUM INTO /data/backups/wakewright-YYYYMMDD.sqlite3`
  at 03:30 every night and keeps 14. Audio blobs are immutable, so
  file-level backup tools copy them incrementally.
- **Health**: `/healthz` (the process is alive) and `/readyz` (the database
  is migrated and writable). The image's `HEALTHCHECK` runs
  `main.js healthcheck`, because the distroless base has no shell or curl.

## The worker

```
 parent ◄──── HTTP(S), outbound only ────┐
 /api/worker/v1: claim, audio, results   │
                     ┌─────────────── worker (one Python process) ───────────────┐
                     │ loop.py: claim (long poll) → audio → judges → results     │
                     │ judges/: types · registry · speech · http + one per type  │
                     │ models.py: pinned downloads ──► cache dir (/cache)        │
                     └───────────────────────────────────────────────────────────┘
```

`apps/worker` is Wakewright's own worker: Python 3.13, uv, a headless core
with a console entry point (`wakewright-worker`), configured by
`WAKEWRIGHT_WORKER__*` variables, so the same code runs in its image, under
`uv run` on any machine and later inside a desktop wrapper. Each judge
Each judge type subclasses one small class (`judges/__init__.py`) and is
registered in `judges/registry.py`; speech-to-text types share the
transcript rule (`judges/speech.py`) and cloud ones the HTTP error mapping
(`judges/http.py`) ([judges.md](judges.md)). Local models are downloaded
on first use into the cache directory, pinned by revision and SHA-256, and
never shipped ([models.md](models.md)). The loop prepares the types,
offers the ready ones in each claim, runs each judge a job names with its
settings, reports a judge that crashes on a clip as `abstain` and one that
cannot answer now as `failed` (skipping it for the rest of the claim),
backs off while the parent is unreachable and stops cleanly on SIGTERM. It holds no state of its own: any number can
run. Running it: [worker.md](worker.md); decisions:
[ADR 0017](adr/0017-the-worker.md).

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
  src/sessions.ts     collection sessions: save, boost, time limit, restore and confirm
  src/judging.ts      judging: claims and leases, routing, the long poll, results, backoff, tests
  src/judges.ts       judges: instances of advertised types, settings, sealed secrets, the rule
  src/judge-settings.ts checking settings against a type's schema; the settings fingerprint
  src/outcome.ts      the weighted outcome (shared with the SPA)
  src/workers.ts      workers: tokens, declared workers applied at start, pause, revoke
  src/pairing.ts      the pairing string (address + token) a worker is set up with
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
  src/kiosk/          Kiosk Satellite: client.ts, source.ts (the adapter), shapes.ts (zod shapes),
                      collection-mode.ts (what a collection session changes)
  test/               bun test: unit and in-process integration tests
apps/web/             @wakewright/web: the SPA
  index.html  src/{main.tsx,router.tsx,api.ts,tokens.css}
  src/pages/          one component per screen, routed in router.tsx (AuthPages: setup, sign-in)
  src/player.tsx      the shared <audio> element for list playback
  src/components/     shared components (AudioPlayer: wavesurfer.js waveform)
apps/worker/          wakewright-worker: the Python worker (uv project, not a Bun workspace)
  src/wakewright_worker/  cli.py, config.py, client.py, loop.py, models.py, audio.py, log.py
    judges/           __init__.py (the JudgeType interface), registry.py, speech.py, http.py,
                      openwakeword.py, microwakeword.py, stt.py (Parakeet),
                      openai_compatible.py, elevenlabs.py; fake.py for tests
  tests/              pytest: fakes.py (fake parent, fake judges), unit and contract tests;
                      test_real_models.py is opt-in (`-m models`)
  scripts/            check_licences.py, check_lock_age.py (run by `mise run check:worker`)
  pyproject.toml uv.lock
devtools/
  dev.ts              `mise run dev`: parent + two fake devices + the fake worker
  worker-integration.ts `mise run integration`: parent + fake device + the real worker loop
  fake-kiosk/         @wakewright/fake-kiosk: fake device + synthetic clips
  fake-worker/        @wakewright/fake-worker: a worker with deterministic fake verdicts
deploy/docker/        parent.Dockerfile; worker.Dockerfile (+ its .dockerignore)
deploy/compose/       docker-compose.yml: the reference Compose file (parent + worker)
scripts/              repository checks run by `mise run check`; worker-openapi.ts writes docs/api/
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
full scale at one sample or clip outright, fleet membership, and
`PATCH /api/settings` of the wake word engine, sensitivity and fine-tune,
checked key by key as the app does and recorded in `writes`.
Tests inject faults through `faults` (offline, slow, malformed list, invalid
audio, a download that breaks, a device that answers 503, keys it refuses); `mise run dev` and E2E reach the same
controls over HTTP under `/_fake/`. Extend it alongside the client.

## The fake worker

`devtools/fake-worker` speaks the worker protocol like a real worker but
judges nothing: each clip's verdicts are picked from a hash of its audio, so
the fake device's synthetic clips always get the same ones and cover every
outcome with the default weights (yes, no, uncertain, a dissent, not
enough evidence). It offers openWakeWord for "alexa" only, so clips of
other wake words show a judge without a model, and an OpenAI-compatible
type with the real settings form that calls nothing: an API key starting
with `bad` fails as a refused key, a base URL containing `unreachable` as a
network failure. It takes a token or a pairing string. `mise run
dev` runs it as the declared worker `dev-worker`; tests and E2E run it
in-process (`runFakeWorker`) and predict its verdicts with `fakeVerdicts`.

## Decisions

Architecture decisions are recorded in [adr/](adr/):

- 0001 [Licence: Apache-2.0](adr/0001-licence-apache-2.0.md)
- 0002 [A parent and stateless workers](adr/0002-parent-and-workers.md)
- 0003 [TypeScript on Bun for the parent](adr/0003-typescript-on-bun.md)
- 0004 [Hono API with a React SPA](adr/0004-hono-api-and-react-spa.md)
- 0005 [SQLite with plain SQL and numbered migrations](adr/0005-sqlite-and-migrations.md)
- 0006 [Tooling: Bun, Biome for lint, mise tasks](adr/0006-tooling.md)
- 0007 [No telemetry](adr/0007-no-telemetry.md)
- 0008 [Read-only device access](adr/0008-read-only-device-access.md), amended by 0020
- 0009 [CI checks, fork safety and speed](adr/0009-ci-checks-and-fork-safety.md)
- 0010 [Releases, changelog and published images](adr/0010-releases-changelog-and-images.md)
- 0011 [Collecting clips: a Source interface and an idempotent poller](adr/0011-collecting-clips.md)
- 0012 [Device passwords encrypted with an instance key](adr/0012-device-password-encryption.md)
- 0013 [One local admin account with server-side sessions](adr/0013-admin-account-and-sessions.md)
- 0014 [The device settings a clip was recorded under](adr/0014-device-settings-of-a-clip.md)
- 0015 [Sign-in can be turned off for an authenticating proxy](adr/0015-sign-in-off-behind-a-proxy.md)
- 0016 [Judging: a derived queue with leases, a shared token, unweighted agreement](adr/0016-judging-queue-and-agreement.md)
- 0017 [The worker: Python with uv, three downloaded judges, a second image](adr/0017-the-worker.md)
- 0018 [Workers as records with their own tokens, created in the UI or declared](adr/0018-workers-with-their-own-tokens.md)
- 0019 [Configurable, weighted judges: types in the worker, instances in the parent](adr/0019-configurable-weighted-judges.md)
- 0020 [Collection sessions: the one write to a device](adr/0020-collection-sessions.md)
