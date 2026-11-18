# Releasing

A release is one command and one merge. Why it works this way:
[ADR 0010](adr/0010-releases-changelog-and-images.md).

## Cut a release

You need `gh` signed in as a maintainer and a clone of the repository
(any branch; the command works in a temporary worktree).

```sh
mise run release 0.0.1
```

This opens a pull request titled "Release 0.0.1" that sets the version in
every workspace package and `bun.lock` and adds the `0.0.1` section to
`CHANGELOG.md`: the pull requests merged since the previous stable release,
grouped by label. Read the section in the pull request; edit it on the
branch if an entry needs rewording or regrouping. Then **merge the pull
request**. That is the release: once `CI OK` passes on the merged commit,
the `Publish` jobs

1. build the image natively for amd64 and arm64 and push it by digest,
2. merge them into one index tagged `sha-<short>`, scan it with Grype
   (a fixable high or critical vulnerability stops the release) and attest
   its build provenance,
3. tag it `0.0.1`, `0.0` and `latest` (and `edge`),
4. create the `v0.0.1` tag and GitHub release, with the changelog section
   as its notes and the SPDX SBOMs attached.

Follow it under Actions → CI for the merge commit. The release page shows
the image digest.

Options:

- `mise run release 0.0.2 --dry-run` prints the changelog section without
  opening anything.
- A version with a hyphen is a pre-release: `mise run release 0.1.0-rc.1`
  publishes `0.1.0-rc.1` only (no `0.1`, no `latest`) and a GitHub
  pre-release. The stable `0.1.0` later covers everything since the last
  stable release and replaces the candidates' changelog sections.
- Pre-1.0, bump the minor for anything breaking (label its pull request
  `breaking`, and add upgrade notes at the top of the section) and the
  patch otherwise.

## If something fails

- **CI fails on the release pull request:** fix it in another pull
  request, close the release pull request, delete its branch and run
  `mise run release` again.
- **Publish fails after the merge** (for example the image scan): nothing
  was tagged or released. Fix the cause in a normal pull request. The next
  merge to `main` still carries the untagged version, so it publishes the
  release from that commit. To retry without a change, re-run the failed
  jobs of that CI run.
- **The scan blocks on an upstream vulnerability:** a Renovate digest pull
  request usually fixes the base image. If no fix exists yet in the image
  but one is listed upstream, decide in the pull request whether to wait
  or add a dated, reasoned ignore to `.grype.yaml`.

Releases are immutable once published: a tag and its assets cannot change.
A bad release is fixed by the next patch release, never by moving a tag.

## Labels for the changelog

| Label           | Section          |
| --------------- | ---------------- |
| `breaking`      | Breaking changes |
| `security`      | Security         |
| `enhancement`   | New features     |
| `bug`           | Fixes            |
| `documentation` | Documentation    |
| `dependencies`  | Dependencies     |
| `ci`            | CI and tooling   |
| anything else   | Other changes    |

`release` and `skip-changelog` leave a pull request out. The mapping lives
in `.github/release.yml`.

## Verify an image

Each published index has a GitHub artifact attestation: SLSA build
provenance signed with Sigstore by the `publish.yml` workflow of this
repository. With the [GitHub CLI](https://cli.github.com):

```sh
gh attestation verify oci://ghcr.io/lukepoo101/wakewright:0.0.1 \
  --repo lukepoo101/wakewright \
  --signer-workflow lukepoo101/wakewright/.github/workflows/publish.yml
```

It prints the digest it verified and the commit and workflow run that built
it. Pin that digest in Compose or Kubernetes
(`ghcr.io/lukepoo101/wakewright@sha256:...`) so the image cannot change
under you. Each platform's SPDX SBOM is in the registry
(`docker buildx imagetools inspect ghcr.io/lukepoo101/wakewright:0.0.1 --format '{{ json .SBOM }}'`)
and attached to the GitHub release.
