# 0009 CI checks, fork safety and speed

- Status: accepted; amended by [0017](0017-the-worker.md)
- Date: 2026-11-17

## Context

Wakewright is public and has one maintainer, so CI is the reviewer: it has
to catch as much as it can, give a first-time contributor from a fork the
same useful feedback as the maintainer, and stay fast enough (about a
minute) that nobody waits on it. The design proposal (05-cicd-and-oss)
suggested path filters, a merge queue and a separate zizmor workflow; the
owner's previous project gated every pull request on `bun audit`, so one
upstream advisory failed all open pull requests at once.

## Decision

- **One CI workflow, one required check.** `ci.yml` runs on
  `pull_request` and pushes to `main`. Its jobs run in parallel and `CI OK`
  is the only check the `main` ruleset requires, so jobs can be added or
  renamed without editing the ruleset.
- **No path filters.** Every job runs on every change. The whole pipeline
  takes about a minute, so filtering would save little and could let a
  change skip the check that matters.
- **No merge queue, no `merge_group` trigger.** GitHub offers merge queues
  only for organisation-owned repositories (GitHub merge queue GA notes:
  <https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/>);
  this repository is in a personal account.
- **Fork safety.** Only `pull_request` is used, never
  `pull_request_target` or `workflow_run`, so fork code always runs with a
  read-only token and no secrets (GitHub Security Lab, "Preventing pwn
  requests": <https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/>).
  No pull request job needs a secret, so a fork pull request gets every
  check with no approval-only gaps. Every workflow sets `permissions: {}`
  and grants each job the least it needs; checkouts do not persist
  credentials. Jobs that publish (images, releases) run only on `main`.
- **Checks in `mise run check`, not separate actions.** actionlint (with
  shellcheck), zizmor and hadolint are pinned in `mise.toml` and run in
  the same task contributors run locally and as the pre-push hook. In CI the
  job's read-only token lets zizmor run its online audits (impostor commits,
  known-vulnerable actions). zizmor's SARIF action was not used: uploading
  SARIF needs `security-events: write`, which fork pull requests do not get.
- **Code scanning: CodeQL default setup** (JavaScript/TypeScript and
  Actions). It needs no workflow file, runs on fork pull requests, and the
  ruleset's code scanning rule blocks merges on its alerts.
- **Dependencies are gated on what a pull request adds.**
  `actions/dependency-review-action` fails a pull request that introduces a
  dependency with a known advisory of moderate severity or worse; it
  compares the pull request's lockfile with its base. Advisories against
  what `main` already has are found by the daily `dependency-health.yml`
  run (`bun audit`), which keeps one issue open until a run is clean, and
  are fixed by Renovate's pull requests. A new upstream advisory therefore
  never fails unrelated pull requests.
- **Licences** are checked offline from the installed packages by
  `scripts/check-licences.ts` against a permissive allow list, in
  `mise run check`, rather than with dependency review's licence option, so
  the same check runs locally.
- **Both architectures on every pull request.** The image job runs on
  `ubuntu-24.04` and the native `ubuntu-24.04-arm` runner (free for public
  repositories:
  <https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/>),
  building, starting and E2E-testing the image on each, in parallel.
- **Caches** (mise tools, Bun packages, Docker layers per architecture)
  are written only by `main` and read by pull requests, so pull requests
  cannot evict them. Playwright's headless shell is downloaded each run, as
  Playwright advises (<https://playwright.dev/docs/ci#caching-browsers>).
- **Concurrency.** A new push to a pull request cancels its previous run.
  Runs on `main` get a unique group, because GitHub cancels a _pending_
  run when a newer one joins the same group, even with
  `cancel-in-progress: false`
  (<https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency>),
  and `main` runs save the caches and publish images.

## Consequences

The pipeline stays one file and one required check. A container image
vulnerability in the base image does not fail pull requests (see ADR 0010
for where images are scanned). Adding a job means adding it to `CI OK`'s
`needs`.
