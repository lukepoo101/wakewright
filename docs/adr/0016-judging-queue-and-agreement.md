# 0016 Judging: a derived queue with leases, a shared token, unweighted agreement

- Status: accepted; the shared token is superseded by
  [ADR 0018](0018-workers-with-their-own-tokens.md) (a token per worker),
  and unweighted agreement and the judges' wire shape by
  [ADR 0019](0019-configurable-weighted-judges.md) (weighted outcome,
  protocol 2)
- Date: 2026-11-18

## Context

Workers ([ADR 0002](0002-parent-and-workers.md)) now judge clips: each runs
judges (openWakeWord, microWakeWord, speech to text) that answer "does this
clip contain its wake word?" with yes, no or abstain. The parent must hand
out work, take results, and show where the judges disagree with each other
and with the device. The aim is to find the interesting clips, not to
produce labels: no weighting, no label fusion, no human labelling yet.

## Decision

- **No stored job queue.** A clip needs judging while it lacks a result for
  a (judge, version) that the claiming worker offers for the clip's wake
  word. A claim finds such clips newest first, so new clips and the backlog
  are both judged, and a new judge version re-judges everything without a
  migration or a backfill job. Results are kept per (clip, judge, version).
- **Leases.** A claim leases each clip it hands out for two minutes
  (`judge_leases`); other claims skip leased clips, results after expiry
  answer `409`, and the clip goes to whoever claims next. A judge that fails
  on a clip reports `abstain` with a reason, so it is not retried forever.
  There are no heartbeats: two minutes covers a batch of 3-second clips.
- **Long poll.** A claim with nothing to do waits up to `waitSeconds`; it
  wakes when the collector stores a clip or a lease expires, and ends at
  once when the worker disconnects or the parent stops.
- **One shared bearer token** (`WAKEWRIGHT__WORKER__TOKEN`), compared in
  constant time, independent of user sign-in and of the auth mode. While it
  is unset the worker API answers `404` and the UI says judging is not set
  up. Per-worker tokens, enrolment and revocation can come later; a shared
  token is enough for a household's one or two workers.
- **Versioned protocol.** The path is `/api/worker/v1` and every claim
  carries `protocol: 1`; a parent answers `426` with the range it speaks.
  The committed `docs/api/worker-v1.openapi.json` is the wire format's source
  of truth; a parent test fails when it drifts from the routes.
- **Unweighted agreement.** Each judge's latest result counts once and
  abstentions are not votes: no results is _waiting_, fewer than two votes
  _inconclusive_, all the same _agree yes_ or _agree no_, otherwise
  _disagree_. It is computed in SQL at query time, so it is never stale.
  When the judges agree against the device (it fired and they say no, or a
  near miss they say yes to) the clip is a likely false wake or a likely
  missed wake word.

### Changes to the milestone contract

- A judge is offered only clips whose wake word it lists (`wakeWords`, or
  null for any). The contract had judges without a model abstain; the
  parent instead does not ask them, and the clip page says no worker has a
  model for that wake word. Agreement is the same, since abstentions do
  not vote, and the worker does no wasted work.
- "Latest version" means the judge's most recent result for the clip,
  because version strings have no order.
- A results request naming a judge or version the job did not ask for is
  refused with `400`; `max` is at most 32 and `waitSeconds` at most 60.

## Consequences

Two workers offering different versions of one judge each re-judge the
other's clips; run one version at a time. Agreement is computed over every
result on each list query, which is fine for tens of thousands of clips;
a stored summary column can replace it if that grows. The fake worker in
`devtools/fake-worker` speaks the same protocol, so the whole loop is tested
in CI without Python.
