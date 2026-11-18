# Dependency updates

[Renovate](https://docs.renovatebot.com/) (the hosted GitHub app) raises
every dependency update as a pull request; `renovate.json` holds the
policy. Each pull request runs the full CI like any other and, where the
table says so, merges itself when `CI OK` passes. Nothing bypasses the
`main` ruleset. Renovate keeps a Dependency Dashboard issue listing pending
and rate-limited updates.

| What                                                              | Where                                    | Release age | Automerge                                     | Grouping             |
| ----------------------------------------------------------------- | ---------------------------------------- | ----------- | --------------------------------------------- | -------------------- |
| npm packages                                                      | `package.json`, `bun.lock`               | 3 days      | minor and patch (not 0.0.x patches)           | "npm dependencies"   |
| Bun, `@types/bun`, `typescript`, `oven/bun` images                | `mise.toml`, `package.json`, Dockerfile  | 7 days      | minor and patch                               | "Bun and TypeScript" |
| Base image digests (rebuilds of the same tag)                     | Dockerfile                               | none        | yes                                           | with Bun             |
| GitHub Actions (SHA pins with version comments)                   | `.github/workflows/`                     | 7 days      | non-major; majors only for Actions PR CI runs | "GitHub Actions"     |
| Linters and mise (actionlint, hadolint, shellcheck, zizmor, mise) | `mise.toml`, `MISE_VERSION` in workflows | 7 days      | minor and patch                               | "CI tools"           |
| The Renovate config validator                                     | `mise.toml` check task                   | 3 days      | yes, at most once a month                     | alone                |
| Lockfile maintenance (transitive refresh)                         | `bun.lock`                               | 3 days      | yes, Monday mornings                          | alone                |
| Security fixes                                                    | anywhere                                 | none        | yes                                           | alone                |

Majors, replacements and rollbacks always wait for a person.

Why:

- **Release age.** Most malicious npm releases are found and pulled within
  days, so nothing younger than 3 days is installed. `bunfig.toml` enforces
  the same age when Bun resolves, and `scripts/verify-lockfile-age.ts`
  checks `bun.lock` on every run because frozen installs skip it.
  Toolchains and Actions wait a week because a bad one breaks every job.
- **Publish-only Actions** (`docker/login-action`, `docker/metadata-action`,
  `actions/attest-build-provenance`, `anchore/scan-action`,
  `actions/download-artifact`, Scorecard and CodeQL's SARIF upload) never
  run in pull request CI. Their non-major updates still merge themselves
  because every push to `main` publishes the `edge` image with them, so a
  broken update shows up on `main` long before a release; their majors are
  reviewed.
- **The validator** is pinned so the check cannot change under a pull
  request. Renovate publishes many releases a day; a monthly schedule keeps
  that to one pull request a month.
- **Bun and TypeScript together**, because `scripts/check-versions.ts`
  fails when Bun, `@types/bun`, the `oven/bun` base tags and the
  `typescript` devDependency disagree.

Advisories: Dependabot alerts are on (they feed Renovate's security pull
requests); Dependabot's own update pull requests are off. A pull request
that adds a vulnerable dependency fails `Dependencies / review` in CI. An
advisory against something `main` already has is reported by the daily
`dependency-health.yml` run in one issue, which closes itself once a run is
clean; it never fails unrelated pull requests.
