# 0006 Tooling: Bun, Biome for lint, mise tasks

- Status: accepted; amended by [0017](0017-the-worker.md)
- Date: 2026-11-17

## Context

The owner's rule is Bun wherever it has no verified gap, one command that
runs what CI runs, and reproducible pins with a single source of truth each.

## Decision

| Need                       | Tool                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolchain pins and tasks   | **mise** (`mise.toml`): installs Bun, Python and uv; `setup`, `dev`, `build`, `check`, `e2e` ([0017](0017-the-worker.md))                                                    |
| Format                     | `bun fmt` (Prettier-compatible), width 100 in `bunfig.toml`                                                                                                                  |
| Types                      | `bun check` (the TypeScript 7 built into Bun)                                                                                                                                |
| Lint                       | **Biome**, lint only (formatter and assist off)                                                                                                                              |
| Unit and integration tests | `bun test`                                                                                                                                                                   |
| E2E                        | Playwright under Bun (`bunx --bun playwright test`), Chromium                                                                                                                |
| Git hook                   | mise's own generator writes a pre-push hook that runs `mise run check`; no hook manager                                                                                      |
| Supply chain               | `bunfig.toml`: `exact = true`, `linker = "isolated"`, `minimumReleaseAge = 3 days`, with `scripts/verify-lockfile-age.ts` because Bun skips the age check on frozen installs |
| Drift                      | `scripts/check-versions.ts`: Bun, `@types/bun` and the Docker base tags follow `mise.toml`; the `typescript` devDependency follows Bun's bundled TypeScript                  |

Verified on Bun 1.4.4 on 2026-11-17:

- `bun lint` is not shipped (`error: Script not found "lint"`), hence Biome.
- `bun check` and `bun fmt` run a `package.json` script of the same name if
  one exists (their `--no-script` flag says so). The workspace therefore
  defines no `check` or `fmt` script, and `check` lives in mise.
- `bun test` also collects `*.spec.ts`, so `bunfig.toml` excludes
  `tests/e2e`, which Playwright owns.
- Playwright 1.65.1 runs under `bunx --bun`.

## Consequences

Contributors install mise once. When `bun lint` ships, Biome can go. The
lockfile-age check needs the npm registry, so `mise run check` fails closed
(exit 2) when offline.
