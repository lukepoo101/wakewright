# Agent instructions

Instructions for AI coding agents working on Wakewright. Humans should read
[CONTRIBUTING.md](CONTRIBUTING.md); the same rules apply.

## Commands

- `mise run setup`: install dependencies (`bun install --frozen-lockfile`).
- `mise run check`: versions, lockfile age, format, lint, types and unit
  tests. Run it before every push; it must pass. Never bypass Git hooks.
- `bun fmt`: fix formatting. `bun test <path>`: run some tests.
- `mise run e2e`: Playwright smoke test against the production build.
- `mise run dev`: parent on :8080, rebuilt on change, plus fake devices on
  :23241/:23242 (password `dev`).

Do not add `check` or `fmt` scripts to a `package.json`: `bun check` and
`bun fmt` would run the script instead of the built-in tool.

## Conventions

- Bun for everything on the TypeScript side; add another tool only for a
  verified gap (today only Biome, for lint). Keep the server on Web-standard
  APIs (Hono, `fetch`, `Request`, `Response`, `crypto.subtle`).
- Validate every route's input and output with zod via `@hono/zod-openapi`;
  mount each API area with `.route()` in `apps/parent/src/api/index.ts` so
  `AppType` reaches the SPA's typed client.
- Plain SQL with typed `db.query<Row, Params>()`; schema changes are numbered
  `.sql` files listed in `apps/parent/src/db/migrate.ts`.
- Configuration is `WAKEWRIGHT__SECTION__KEY` environment variables,
  validated in `apps/parent/src/config.ts`.
- Device access is read only. Never call a Kiosk Satellite command that
  changes the device.
- No real audio, credentials or third-party assets in the repository; test
  audio is generated in code (`devtools/fake-kiosk/src/synth.ts`).
- Dependencies are pinned exactly; actions by commit SHA; images by digest.
- British English in docs and UI text, sentence-case headings.

## Where things are

See [docs/architecture.md](docs/architecture.md) for the layout and where new
features go, [docs/development.md](docs/development.md) for tooling and CI,
and [docs/adr/](docs/adr/) for the decisions behind them.
