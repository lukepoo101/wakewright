# 0010 Releases, changelog and published images

- Status: accepted
- Date: 2026-11-18

## Context

Wakewright needs one SemVer version for the product (pre-1.0), a
`CHANGELOG.md` in the repository, a GitHub release with notes and a
`vX.Y.Z` tag for each release, and multi-arch images on GHCR. A release
must be cut by merging a pull request or one deliberate action, never by
editing versions by hand in several files. Contributors write plain-English,
imperative pull request titles ("Show the clip's score on the clip page");
pull requests are squash-merged, so the title is the commit. There is one
maintainer. The owner's previous project had a release workflow that never
ran; this one has to run on every merge.

## Options considered

| Tool                                                                                                                                                  | What contributors must do                                          | CHANGELOG.md                                     | Cut by                                      | Verdict                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [release-please](https://github.com/googleapis/release-please)                                                                                        | Conventional Commit titles (`feat(web): ...`), enforced by a check | yes                                              | merging its release pull request            | Rejected: it reads only Conventional Commits, which the owner's plain-English titles are not      |
| [changesets](https://github.com/changesets/changesets)                                                                                                | add a `.changeset/*.md` file to every pull request                 | yes                                              | merging its "Version Packages" pull request | Rejected: per-pull-request ceremony, and versions per npm package rather than one product version |
| [release-drafter](https://github.com/release-drafter/release-drafter)                                                                                 | nothing (labels optional)                                          | no, notes live only in a draft release           | publishing the draft                        | Rejected: no changelog file, and a third-party action holding `contents: write` on every push     |
| [git-cliff](https://git-cliff.org/docs/)                                                                                                              | nothing if grouping uses title words or labels via the API         | yes                                              | a hand-made tag and commit                  | Rejected: a capable generator, but adds a tool and leaves tagging and the version bump manual     |
| [GitHub generated notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes) + a small script | nothing (labels optional)                                          | yes, written by the script into the pull request | merging the "Release X.Y.Z" pull request    | **Chosen**                                                                                        |

## Decision

- **Version.** The product version is `apps/parent/package.json`'s
  `version` (the server reports it); every workspace package carries the
  same one. `scripts/check-versions.ts` fails CI if they differ or if
  `CHANGELOG.md`'s newest section is not that version.
- **Notes.** GitHub's generated release notes list the merged pull
  requests by title and author, grouped by label as
  `.github/release.yml` says (breaking, security, features, fixes, docs,
  dependencies, other). Plain-English titles are exactly what they show,
  so there is nothing for contributors to learn; labels only improve the
  grouping, and unlabelled pull requests land in "Other changes".
  Renovate labels its own pull requests `dependencies`.
- **Preparing a release** is one command, `mise run release X.Y.Z`
  (`scripts/release.ts`). It asks GitHub for the notes since the previous
  release, writes them as the version's `CHANGELOG.md` section, sets the
  version in every workspace package and `bun.lock`, and opens a
  "Release X.Y.Z" pull request labelled `release`. The maintainer can
  reword or regroup the section in that pull request; it goes through CI
  like any other.
- **Cutting it** is merging that pull request. On the merged commit, after
  `CI OK` passes, `ci.yml` calls `publish.yml`, which sees a version with no
  tag and publishes the images, then creates the GitHub release (and with it
  the tag) with the `CHANGELOG.md` section as its notes and the SBOMs
  attached. A version with a hyphen (`0.0.1-rc.1`) is published as a
  pre-release. A stable release's section covers everything since the
  previous stable release and replaces its own release candidates'
  sections.
- **History anchor.** The tag `v0.0.0` marks the first commit, so the
  first release's notes have a starting point. It has no release.
- **The release runs on GitHub's token, no app or PAT.** The tag and
  release are created by the publish job's `GITHUB_TOKEN`
  (`contents: write`, that job only). The release pull request is opened by
  the maintainer's own `gh`, so CI runs on it normally; a pull request
  opened by `GITHUB_TOKEN` would not trigger CI and could never satisfy
  the required check.
- **Images** go to `ghcr.io/lukepoo101/wakewright` from every push to
  `main`: native amd64 and arm64 builds (no QEMU), pushed by digest and
  merged into one index (Docker's documented pattern,
  <https://docs.docker.com/build/ci/github-actions/multi-platform/>).
  Tags: `edge` and `sha-<short>` on every push; `X.Y.Z` for every release;
  `X.Y` and `latest` for stable releases. Publishing `edge` on every merge
  means the whole publish path runs many times before any release, so a
  release cannot be the first time it runs.
- **Gates before tagging.** The index is pushed under its immutable
  `sha-<short>` tag, scanned with Grype, and attested before any moving tag
  points at it. A release fails on a fixable vulnerability of high or
  critical severity; `edge` only reports (to code scanning), so an upstream
  advisory does not stop `main` publishing. The daily dependency health run
  rescans the newest release.
- **Provenance and SBOM.** A GitHub artifact attestation (SLSA build
  provenance, signed keylessly through Sigstore with the
  `publish.yml` workflow identity) is pushed to the registry for the index
  digest
  (<https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>).
  BuildKit adds an SPDX SBOM per platform, including the build stage so
  the npm packages bundled into `main.js` are listed; the index digest the
  attestation signs covers those SBOM manifests. The release also attaches
  them as files.
- **No separate cosign signature.** The attestation already is a Sigstore
  signature over the image digest by this workflow's identity, and
  `gh attestation verify` checks it. A second signature of the same digest
  by the same identity would add a step and a tool and prove nothing new.

## Consequences

Contributors do nothing for the changelog beyond a good title. The
maintainer runs one command and merges one pull request. The changelog is
only as good as the titles and labels, and the release pull request is the
place to fix it. Rejected tools need no configuration to remove. If the
project ever moves to an organisation, the image name and the attestation
identity change (`docs/RELEASING.md` tells users to pin by digest).
