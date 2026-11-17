# 0002 A parent and stateless workers

- Status: accepted
- Date: 2026-11-17

## Context

Collecting and storing clips needs an always-on service with a small
footprint. Judging and training need ML libraries and sometimes a GPU that
may be on another machine, behind NAT.

## Decision

Two kinds of process. The **parent** is always on and owns all state
(clips, labels, datasets, the model registry, the job queue and the UI). It
contains no ML libraries and runs as one replica, because SQLite has one
writer. **Workers** are stateless, run anywhere, and pull jobs from the
parent over HTTPS (long-poll claims, leases, heartbeats), so a worker needs
no inbound port.

## Consequences

The parent collects and shows clips with no worker connected; v0.0.1 is the
parent alone. Anything that needs ML runs as a worker job. The parent image
is checked in CI to contain no Python and no native addons.
