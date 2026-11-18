# Project health

What keeps the repository healthy, what is automated, and what is not.
One maintainer runs the project, so CI is the reviewer: everything a person
would check by habit is a check instead.

## Automated

- [x] **Every change goes through a pull request.** Ruleset `main`: pull
      request required, `CI OK` required and up to date with `main`,
      conversations resolved, CodeQL alerts (high or errors) block, linear
      history, no force pushes or deletion, no bypass for anyone, zero
      approvals required.
- [x] **Squash merge only**, the pull request title becoming the commit;
      auto-merge allowed; branches deleted on merge.
- [x] **CI on every pull request, forks included**, in about a minute: format,
      lint, types, unit tests, lockfile release age, licences, workflow lint
      and security (actionlint, zizmor), Dockerfile lint, Renovate config,
      image build and E2E on amd64 and arm64, dependency review
      ([development.md](development.md#ci), [ADR 0009](adr/0009-ci-checks-and-fork-safety.md)).
- [x] **Code scanning**: CodeQL default setup (TypeScript, Actions);
      Grype image scans and Scorecard results upload to it too.
- [x] **Dependency updates**: Renovate, with release ages, grouping and
      automerge through CI ([dependency-updates.md](dependency-updates.md)).
      Dependabot alerts on.
- [x] **Daily dependency health**: `bun audit` of `main` and a Grype scan of
      the newest published image, reported in one issue that closes itself.
- [x] **Publishing**: every merge to `main` publishes the `edge` image,
      and every release its version tags (amd64 and arm64), with SBOMs and
      a signed provenance attestation.
- [x] **Releases**: `mise run release X.Y.Z` opens the release pull request;
      merging it tags, releases and publishes ([RELEASING.md](RELEASING.md)).
      Releases are immutable.
- [x] **Supply chain**: actions pinned by SHA (also enforced by the
      repository's Actions policy), images by digest, dependencies exact,
      default workflow token read-only, Actions cannot approve pull
      requests, no long-lived secrets anywhere.
- [x] **Secret scanning with push protection**, and private vulnerability
      reporting ([SECURITY.md](../SECURITY.md)).
- [x] **OpenSSF Scorecard** weekly, published for the README badge.

## By hand, on purpose

- Labelling pull requests (it picks the changelog section; unlabelled
  ones land in "Other changes"). Renovate labels its own.
- Reading the release pull request's changelog section before merging.
- Triage of issues and Discussions (questions go to Discussions Q&A).
- Approving workflow runs for first-time contributors whose GitHub account
  is new (GitHub's spam guard); everyone else's pull requests run at once.

## Not used, and why

- **Stale bot**: closing unanswered issues by timer loses real reports, and
  the volume does not need it.
- **Merge queue**: not available to personal-account repositories; strict
  "up to date" checks do the same job at this volume.
- **Required approvals and DCO sign-off**: one maintainer cannot approve
  their own pull requests, and Apache-2.0 section 5 already makes
  contributions inbound = outbound.
- **Path filters**: every job runs on every change; the pipeline is fast
  enough that skipping saves little and risks missing a check.

## Known gaps

- Scorecard's Code-Review and Contributors checks will stay low while one
  person maintains the project.
- No OpenSSF Best Practices badge yet.
- The image scan cannot see inside the bundled `main.js`; npm packages are
  covered by `bun audit` and dependency review instead.
