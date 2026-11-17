# Architecture

Wakewright has two kinds of process:

- The **parent**: always on, one replica. It owns all state (clips,
  metadata, later labels, datasets and the model registry), pulls clips from
  devices and serves the web UI and API. It contains no machine-learning
  libraries. TypeScript on Bun.
- **Workers** (from a later milestone): stateless Python processes that pull
  judging, training and evaluation jobs from the parent over HTTPS. They are
  not part of v0.0.1.

v0.0.1 is the parent only: add Kiosk Satellite devices, collect their wake
word clips, store them, and browse and play them.

## The parent

```
            ┌───────────────────────── parent (one Bun process) ─────────────────────────┐
 browser ──►│ Bun.serve ─► Hono: /healthz /readyz /api/*  ─┐    static SPA (dist/public)  │
            │                                              ▼                              │
            │   ingest loop ──► kiosk client ──► blob store + bun:sqlite (WAL, /data)     │
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
  validated by zod at start-up. Settings a user edits (devices and so on)
  live in the database.
- **Health**: `/healthz` (the process is alive) and `/readyz` (the database
  is migrated and writable). The image's `HEALTHCHECK` runs
  `main.js healthcheck`, because the distroless base has no shell or curl.

## Repository layout

```
apps/parent/          @wakewright/parent: the server
  src/main.ts         production entry: serve | migrate | healthcheck
  src/dev.ts          development entry: same API + the SPA via Bun's HTML import (HMR)
  src/boot.ts         shared start-up: open DB, migrate, build the API, start loops
  src/config.ts       WAKEWRIGHT__* environment schema
  src/log.ts          JSON-lines logger
  src/spa.ts          serves the built SPA
  src/api/            one file per API area, mounted in api/index.ts (exports AppType)
  src/db/             db.ts (connection), migrate.ts (runner + list), migrations/NNNN_*.sql
  src/kiosk/          Kiosk Satellite client; shapes.ts holds the zod response shapes
  test/               bun test: unit and in-process integration tests
apps/web/             @wakewright/web: the SPA
  index.html  src/{main.tsx,router.tsx,api.ts,tokens.css}
  src/pages/          one component per screen, routed in router.tsx
  src/components/     shared components
devtools/
  dev.ts              `mise run dev`: parent + two fake devices
  fake-kiosk/         @wakewright/fake-kiosk: fake device + synthetic clips
deploy/docker/        parent.Dockerfile
scripts/              repository checks run by `mise run check`
tests/e2e/            Playwright smoke tests
docs/                 this documentation and the ADRs
```

## Where the v0.0.1 features go

| Feature                                                   | Location                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Admin login, signed session cookie, CSRF check            | `apps/parent/src/auth.ts`, `src/api/session.ts`, `apps/web/src/pages/LoginPage.tsx`                              |
| Device password encryption (AES-256-GCM, `crypto.subtle`) | `apps/parent/src/crypto.ts`                                                                                      |
| Schema for users, devices, secrets, blobs, clips          | `apps/parent/src/db/migrations/0001_init.sql` (editable until v0.0.1 is released), queries in `src/db/<area>.ts` |
| Content-addressed blob store                              | `apps/parent/src/blobs.ts`                                                                                       |
| Kiosk REST client                                         | `apps/parent/src/kiosk/client.ts`, parsing with `kiosk/shapes.ts`                                                |
| Poll loop, cursors, gap detection                         | `apps/parent/src/ingest.ts`, started from `boot.ts`                                                              |
| Device and clip APIs                                      | `apps/parent/src/api/devices.ts`, `api/clips.ts`, mounted in `api/index.ts`                                      |
| Devices, clips and clip pages; waveform player            | `apps/web/src/pages/`, `apps/web/src/components/AudioPlayer.tsx`                                                 |
| Nightly `VACUUM INTO` backup                              | `Bun.cron`, started from `boot.ts`                                                                               |

The fake device in `devtools/fake-kiosk` builds its responses from the same
`kiosk/shapes.ts`, so the client and the fake cannot drift apart silently.
Extend the fake (fault injection, more clips) alongside the client.

## Decisions

Architecture decisions are recorded in [adr/](adr/):

1. [Licence: Apache-2.0](adr/0001-licence-apache-2.0.md)
2. [A parent and stateless workers](adr/0002-parent-and-workers.md)
3. [TypeScript on Bun for the parent](adr/0003-typescript-on-bun.md)
4. [Hono API with a React SPA](adr/0004-hono-api-and-react-spa.md)
5. [SQLite with plain SQL and numbered migrations](adr/0005-sqlite-and-migrations.md)
6. [Tooling: Bun, Biome for lint, mise tasks](adr/0006-tooling.md)
7. [No telemetry](adr/0007-no-telemetry.md)
8. [Read-only device access](adr/0008-read-only-device-access.md)
