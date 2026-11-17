# 0007 No telemetry

- Status: accepted
- Date: 2026-11-17

## Context

Wakewright handles recordings from people's homes, including guests and
children.

## Decision

No usage pings, analytics or crash reporting, ever. Audio and labels stay on
the user's hardware; the project runs no servers. The only outbound
connections are ones the user configures (devices, Home Assistant, a
speech-to-text service), container pulls and, later, licensed asset
downloads. An update check, if one is added, is opt-in and reads only the
GitHub releases API.

## Consequences

We learn about problems only from issues. Changing this needs a new ADR and
a prominent release note.
