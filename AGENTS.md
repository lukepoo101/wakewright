# Agent instructions

Instructions for AI coding agents working on Wakewright. Humans should read
[CONTRIBUTING.md](CONTRIBUTING.md); the same rules apply.

## Commands

- `mise run setup`: install dependencies (`bun install --frozen-lockfile`,
  `uv sync --frozen` in `apps/worker`).
- `mise run check`: versions, lockfile age, format, lint, types and unit
  tests for both languages (`check:repo`, `check:bun`, `check:worker`). Run
  it before every push; it must pass. Never bypass Git hooks.
- `bun fmt`: fix formatting. `bun test <path>`: run some tests.
- `mise run e2e`: Playwright smoke test against the production build.
- `mise run dev`: parent on :8080, rebuilt on change, plus fake devices on
  :23241/:23242 (password `dev`) and a fake worker that judges every clip.
- `mise run integration`: the parent and the real worker loop with fake
  judges, together. `mise run worker-models-test`: the worker's real models
  (downloads about 2.5 GB; never needed for unit tests).
- `mise run openapi`: rewrite `docs/api/worker-v1.openapi.json` after
  changing the worker API (a unit test fails while it is stale).
- `mise run release <version>`: open the release pull request (maintainer
  only; see [docs/RELEASING.md](docs/RELEASING.md)). Never edit versions or
  `CHANGELOG.md` by hand in a feature pull request.

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
- Device access is read only, with one exception: a collection session
  (`sessions.ts`, [ADR 0020](docs/adr/0020-collection-sessions.md)) may
  `PATCH` the wake word engine, sensitivity and fine-tune, saving them
  first and always putting them back and confirming. Never call any other
  Kiosk Satellite write or command that changes a device.
- No real audio, credentials or third-party assets in the repository; test
  audio is generated in code (`devtools/fake-kiosk/src/synth.ts`).
- The worker (`apps/worker`) is Python 3.13 with uv: `uv add --exact`,
  `uv.lock` committed, ruff for format and lint, pyright strict, pytest.
  Configuration is `WAKEWRIGHT_WORKER__KEY` variables in `config.py`; keep
  it a headless core with no Docker-only assumptions (paths from config,
  `pathlib`, dependencies with Windows wheels). A judge type subclasses
  `JudgeType` in `judges/__init__.py` (speech to text: `SpeechToTextJudge`
  in `judges/speech.py`), is registered in `judges/registry.py`, and
  changes its `version` when its model or logic changes
  ([docs/judges.md](docs/judges.md)). The parent has no code per type.
- Never commit or bake a model into an image: judges download pinned,
  checksummed files on first use (`models.py`; list each in
  `docs/models.md` with its licence). Worker tests use fake judges and the
  fake parent in `apps/worker/tests/fakes.py` and never touch the network.
- The worker API's wire format is `docs/api/worker-v1.openapi.json`; the
  worker's contract tests read it.
- Dependencies are pinned exactly; actions by commit SHA; images by digest.
- British English in docs and UI text, sentence-case headings.

## Where things are

See [docs/architecture.md](docs/architecture.md) for the layout and where new
features go, [docs/development.md](docs/development.md) for tooling and CI,
and [docs/adr/](docs/adr/) for the decisions behind them.
