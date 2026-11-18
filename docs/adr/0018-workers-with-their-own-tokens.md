# 0018 Workers as records with their own tokens, created in the UI or declared

- Status: accepted
- Date: 2026-11-18
- Supersedes: the shared token in [ADR 0016](0016-judging-queue-and-agreement.md)

## Context

ADR 0016 gave every worker one shared bearer token, `WAKEWRIGHT__WORKER__TOKEN`,
and identified a worker by the name it reported. That cannot revoke one
worker, cannot send some judges to some workers, and leaves a desktop app
with nothing to pair against. Owners want both: workers set in a GitOps
deployment, and workers they create, edit, pause and delete in the UI, for
example for a Windows app that needs one value pasted into it.

Self-hosted projects that offer both usually follow Grafana's provisioning:
resources declared in configuration are applied on every start, shown in
the UI marked as provisioned and read-only there, and removed when removed
from configuration; everything else is edited in the UI. Home Assistant
does the same for YAML-defined entities ("managed in configuration"), and
Traefik and Gitea express named maps as `PREFIX__<NAME>__KEY` environment
variables. Wakewright's own configured admin password
([ADR 0013](0013-admin-account-and-sessions.md)) already works this way.

## Decision

- **A worker is a record the parent owns**: a name (unique, ignoring case),
  notes, an enabled switch and the judges it may run (all, by default,
  including judges it offers later). What the worker reports in its claims
  (host name, version, judges offered, last seen) is kept beside it and
  shown, but the **token identifies the worker**; the claim's
  `worker.name` is informational.
- **Each worker has its own token.** The database keeps only its SHA-256,
  as for sessions. A presented token is hashed and compared with every
  worker's hash in constant time, without stopping at a match. Generated
  tokens are `wwk_` and 43 base62 characters (256 bits), so secret
  scanners can recognise them; the UI shows the token once.
- **Declared workers** are environment variables:
  `WAKEWRIGHT__WORKERS__<NAME>__TOKEN` or `__TOKEN_FILE` (required),
  `__JUDGES` (comma-separated, or `all`), `__NOTES`, `__ENABLED`. `<NAME>`
  is letters and digits joined by single underscores and becomes the
  worker's name in lower case with dashes (`CLUSTER_WORKER` is
  `cluster-worker`). This keeps the existing `WAKEWRIGHT__SECTION__KEY`
  convention and the `_FILE` secrets that Docker and Kubernetes provide; a
  provisioning file would add a second configuration format for a list
  that is a handful of entries long. Declared tokens are accepted as given
  (at least 16 characters), so an existing secret can be reused.
  Configuration is the source of truth: on every start declared workers
  are created or updated, a changed token ends the old one, and a declared
  worker no longer configured is deleted. The UI lists them as "Set by
  configuration" and refuses to change them.
- **Name clashes**: the UI refuses a name a declared worker has. If
  configuration declares the name of a worker created in the UI, the UI
  worker is renamed `<name>-created-here`, keeps its token and keeps
  working, and the start-up log says so; configuration gets its name. Two
  workers may not share a token; the server refuses to start rather than
  merge them.
- **Routing is a filter at claim time**, since the queue is derived
  (ADR 0016): a claim is offered only the judges the worker offers _and_
  may run, and nothing while it is paused. No priorities, weights,
  schedules or limits.
- **Changes take effect at once**: pausing, deleting, giving a new token or
  changing the allowed judges releases the worker's leases, so its clips
  go to the next claim and its late results answer `409`; a waiting claim
  wakes and re-checks, and a deleted or replaced token answers `401` from
  the next request. A lease belongs to the worker that claimed it. Past
  results keep the worker name they were recorded with.
- **Pairing string**: creating a worker or giving it a new token also shows
  `wakewright-pair:1:<base64url of {"url": ..., "token": ...}>`: a format
  version and the parent's address with the token, so one paste sets a
  worker up. The address defaults to `WAKEWRIGHT__SERVER__PUBLIC_URL` (or
  the browser's address) and can be edited, since a worker may reach the
  parent at another address. The worker reads it from
  `WAKEWRIGHT_WORKER__PAIRING`, `__PAIRING_FILE` or `run --pairing`;
  `WAKEWRIGHT_WORKER__PARENT_URL` still overrides its address. It holds the
  token, so it is never logged.
- **The shared token is removed**, not kept beside the new tokens:
  `WAKEWRIGHT__WORKER__TOKEN(_FILE)` stops the server at start with a
  message naming the replacement. The worker API no longer answers `404`
  when nothing is set up; with no workers every token is `401`.
- **The wire protocol stays at 1.** The request and response shapes are
  unchanged; only which token is accepted changed. A 0.1 worker keeps
  working when its old token is declared as a worker's token, and
  otherwise fails with `401`, which it already reports as a refused token.
- **Management** is `/api/v1/workers`, user-authenticated like the rest of
  `/api/v1` in both auth modes; a worker token never opens it.

## Consequences

Upgrading from 0.1 needs one configuration change: rename
`WAKEWRIGHT__WORKER__TOKEN(_FILE)` to `WAKEWRIGHT__WORKERS__<NAME>__TOKEN(_FILE)`,
keeping the same secret, and running workers carry on. The old `workers`
table, which held only reported names, is dropped by migration 0004; past
verdicts keep their worker names. Self-registration with approval,
per-worker schedules or limits, and exposing the worker API beyond the
owner's network remain out of scope.
