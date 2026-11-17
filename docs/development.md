# Development

## Tools

[mise](https://mise.jdx.dev) installs the pinned Bun (`mise.toml`) and runs
the project's tasks. Bun is the runtime, package manager, bundler, test
runner, type checker (`bun check`) and formatter (`bun fmt`). Biome does
linting only, because `bun lint` does not exist yet ([ADR 0006](adr/0006-tooling.md)).

| Task             | What it runs                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `mise run setup` | `bun install --frozen-lockfile`                                                                                          |
| `mise run dev`   | `devtools/dev.ts`: the parent's dev entry with HMR on :8080 (data in `.dev-data/`) and fake devices on :23241 and :23242 |
| `mise run build` | `bun run build`: the SPA into `dist/public`, the server into `dist/main.js`                                              |
| `mise run check` | the checks below, in order                                                                                               |
| `mise run e2e`   | Playwright: builds `dist/` and tests it, or tests `E2E_BASE_URL` when set                                                |

`mise run check`:

1. `scripts/check-versions.ts`: the running Bun, `@types/bun` and every
   `oven/bun` base image match `mise.toml`; `typescript` matches the
   TypeScript built into Bun, so editors and `bun check` agree.
2. `scripts/verify-lockfile-age.ts`: every entry in `bun.lock` is at least
   as old as `bunfig.toml`'s `minimumReleaseAge` (3 days). Bun enforces the
   age only when it resolves, not on frozen installs. The check needs the
   npm registry; exit 2 means it could not check, which is not a pass.
3. `bun fmt --check`: Prettier-compatible formatting of code, JSON, YAML,
   TOML and Markdown (width 100, set in `bunfig.toml`).
4. `bunx biome lint --error-on-warnings`: Biome's recommended rules.
5. `bun check`: TypeScript, one `tsconfig.json` for the workspace.
6. `bun test`: unit and in-process integration tests (`tests/e2e` excluded
   in `bunfig.toml`).

Install it as a pre-push hook with
`mise generate git-pre-commit --write --hook pre-push --task check`.

Two Bun behaviours to know: `bun check` and `bun fmt` run a `package.json`
script of the same name instead of the built-in tool if one exists, so the
workspace defines none; and `bun test` also picks up `*.spec.ts`, which is
why Playwright's directory is excluded.

## Running the production build

```sh
mise run build
WAKEWRIGHT__STORAGE__DATA_DIR=/tmp/ww bun dist/main.js serve
```

| Variable                         | Default                       | Meaning                            |
| -------------------------------- | ----------------------------- | ---------------------------------- |
| `WAKEWRIGHT__SERVER__HOST`       | `0.0.0.0`                     | Listen address                     |
| `WAKEWRIGHT__SERVER__PORT`       | `8080`                        | Listen port                        |
| `WAKEWRIGHT__SERVER__STATIC_DIR` | `public/` next to the bundle  | The built SPA                      |
| `WAKEWRIGHT__STORAGE__DATA_DIR`  | `data` (`/data` in the image) | Database, backups and blobs        |
| `WAKEWRIGHT__LOG__LEVEL`         | `info`                        | `debug`, `info`, `warn` or `error` |

## Container image

`deploy/docker/parent.Dockerfile` builds on `oven/bun:1.4.4-slim` and runs
on `oven/bun:1.4.4-distroless`, both pinned by digest. The runtime image
holds only `main.js`, the SPA and the licence, runs as uid 10001 and writes
only to `/data` and `/tmp`, so it works with a read-only root filesystem.
Docker is not needed locally; CI builds and tests the image.

## CI

One workflow, `.github/workflows/ci.yml`, runs on pull requests, the merge
queue and pushes to `main`:

| Job                      | What it does                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Check / mise run check` | installs the pinned Bun with mise, then `mise run setup` and `mise run check`                                                                                 |
| `Image / build + E2E`    | builds the image (not pushed), checks it holds no Python or native addons, runs it read-only, waits for its health check, then runs `mise run e2e` against it |
| `CI OK`                  | passes only if both jobs passed; the one check to require on `main`                                                                                           |

Rules: actions pinned by commit SHA, `permissions: {}` at the top and
`contents: read` per job, no persisted checkout credentials, superseded
pull request runs cancelled. Caches (mise, Bun packages, Docker layers) are
written only by `main` and read by everyone, so pull requests cannot evict
`main`'s caches. Playwright's browsers are downloaded each run, as
Playwright recommends.
