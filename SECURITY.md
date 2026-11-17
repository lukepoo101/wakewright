# Security policy

Wakewright is pre-alpha. Only the `main` branch is maintained; there are no
releases yet, so there is no supported-versions table.

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
