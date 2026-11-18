# Security policy

Wakewright is pre-alpha. Fixes go into `main` and the next release; only
the newest release (and the `edge` image built from `main`) gets them.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private
vulnerability reporting:
[Security → Report a vulnerability](https://github.com/lukepoo101/wakewright/security/advisories/new).
Do not open a public issue for a vulnerability.

Include the affected commit, the impact, and a minimal reproduction. Never
include real household audio, device passwords or tokens. This is a
volunteer project: we aim to acknowledge a report within 7 days, but cannot
promise it. There is no bug bounty.

Fixes are published as GitHub Security Advisories.

## What counts

Anything that could expose clips or device credentials, let someone reach
the API without logging in, make the parent write to a device, or run code
in the parent or a worker is security-sensitive.

## Verifying what you run

Every published image has a signed build provenance attestation and an
SBOM. [docs/RELEASING.md](docs/RELEASING.md#verify-an-image) shows how to
verify an image with `gh attestation verify` and pin it by digest.
