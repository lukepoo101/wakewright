# Changelog

All notable changes to Wakewright. Each section is also the notes of its
GitHub release. `mise run release <version>` writes the next section from
the pull requests merged since the last release; see
[docs/RELEASING.md](docs/RELEASING.md). Versions follow
[Semantic Versioning](https://semver.org); before 1.0, a minor release may
break things and says how to upgrade.

## 0.0.1-rc.1 - 2026-11-18

### Documentation

- Add CODEOWNERS, Discussions for questions, README badges and a project health page by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/7

### Dependencies

- Set up Renovate for npm packages, Actions, base images and the toolchain by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/3

### CI and tooling

- Harden CI: workflow and Dockerfile lint, licence and dependency review, arm64 E2E by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/1
- Publish multi-arch images from main and release by merging a release pull request by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/4
- Run the publish jobs after CI on main (they were always skipped) by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/5
- Cache Grype's database and shorten the publish job names by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/6
- Group CI pull requests in the changelog and drop GitHub's generator comment by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/9
- Let the release script pass the pre-push hook in its worktree by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/10

### Other changes

- Add the admin account with first-run setup and sign-in by @lukepoo101 in https://github.com/lukepoo101/wakewright/pull/2

### New contributors

- @lukepoo101 made their first contribution in https://github.com/lukepoo101/wakewright/pull/1

**Full Changelog**: https://github.com/lukepoo101/wakewright/compare/v0.0.0...v0.0.1-rc.1
