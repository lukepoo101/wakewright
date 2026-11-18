# 0008 Read-only device access

- Status: accepted, amended by [0020](0020-collection-sessions.md)
- Date: 2026-11-17

## Context

A bad change to a voice satellite can break voice control or leak room
audio. Kiosk Satellite's API can change settings and upload models as well
as read them.

## Decision

Wakewright only reads from devices: log in, read health and settings, list
wake word activations and fetch their clips. It never calls a command that
changes a device. Recommendations (sensitivity, models) are applied by the
user by hand. The fake device rejects every other call, so a test catches
an accidental write.

Amended by [0020](0020-collection-sessions.md): a collection session the
user starts may change the wake word engine, sensitivity and fine-tune for
a time limit, and always puts them back and confirms them.

## Consequences

No automatic deployment, canary or rollback for now. A future "Deployer"
would need a new ADR.
