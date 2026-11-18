# 0019 Configurable, weighted judges: types in the worker, instances in the parent

- Status: accepted; supersedes the unweighted agreement of
  [ADR 0016](0016-judging-queue-and-agreement.md) and the three hard-wired
  judges of [ADR 0017](0017-the-worker.md)
- Date: 2026-11-18

## Context

Three judges counted equally: "2 of 3 yes". openWakeWord and microWakeWord
are far weaker evidence than speech to text, so a clip both wake word
models misheard read as a disagreement as strong as any other. The owner
wants to weight judges, add cloud speech-to-text APIs with free tiers, and
configure all of it in the UI, with new providers easy to add.

## Decision

- **Judge types are plugins in the worker.** A type is a Python class
  (`judges/__init__.py`): id, name, kind (wake word model or speech to
  text), a version that changes with its logic, a declarative settings
  schema (key, label, help, type text/secret/number/select/boolean,
  default, options, required, range, whether it can change a verdict),
  whether it sends audio off the worker, and `judge(clip, settings)`. Types
  register in `judges/registry.py`, a plain mapping that a later release
  can extend from Python entry points. Every judge runs in the worker,
  cloud ones included: one plugin system, one language, and the parent
  holds no provider code. Speech-to-text types share the transcript rule
  (`judges/speech.py`) and the HTTP error mapping (`judges/http.py`), so a
  provider is a client call and a schema. The existing three keep their
  ids (`openwakeword`, `microwakeword`, `stt`) and versions.
- **Judges are instances configured in the parent.** An instance has a
  name, a type, settings, a weight (0 to 10; 0 is shown but not counted),
  an optional daily limit and an on/off switch; several of one type are
  allowed. Workers advertise their types with schemas in every claim and
  the parent keeps the latest (`judge_types`), so the UI renders a form and
  the parent validates settings for any type with no code per type.
  Secret settings are sealed together as one JSON value in `secrets` with
  the instance key ([ADR 0012](0012-device-password-encryption.md)), never
  returned (the API says only which are set), never logged, and sent only
  inside a job to a worker that may run the type.
- **Jobs carry instances.** A clip needs judging while it lacks a current
  result from an enabled instance: the same settings fingerprint (SHA-256
  of the canonical JSON of the settings that can change a verdict) and the
  type version the claiming worker offers. A new model re-judges; a new
  name, weight, limit, key or timeout does not. The per-worker "may run"
  list now names types; the ids did not change, so stored lists carry over.
  Deleting an instance keeps its row and results (shown, not counted) and
  removes its secrets.
- **Three outcomes from a run.** Yes or no; abstain (recorded, not
  retried: no model, unusable audio, a clip the service refuses); or
  `failed` with a reason and an optional retry-after (nothing recorded).
  A failure pauses the instance (`retry_at`) with backoff by reason, or as
  long as the service asked, and shows on the Judges page; further
  failures from the same claim do not extend the pause, and the worker
  skips a failed instance for the rest of its claim. A clip that fails
  five times on its own (not for auth, rate or quota reasons) is given up
  on with an abstention. A daily limit caps runs (failures included) in
  any rolling 24 hours, newest clips first, counting leases in flight.
- **Weighted outcome.** Each counted instance's latest yes or no votes ±1
  times its weight; score = sum / weight that voted. Yes at score ≥ margin,
  no at ≤ −margin, otherwise uncertain; not enough evidence when the
  weight that voted is below the minimum; waiting while a counted instance
  that can run now (a recent worker offers and may run its type, not
  paused, not at its limit) lacks a current result, with the provisional
  outcome kept. Defaults: margin 0.5, minimum 1.0 (one speech-to-text
  judge), weights 1.0 for speech to text and 0.3 for each wake word model.
  The rule lives in `outcome.ts`; SQL computes the same at read time (a
  test checks they agree), so changing a weight or the rule changes every
  outcome at once without judging again.
- **Test runs.** The Judges page can run an instance on one stored clip:
  the next claim from a worker that may run the type takes it, whatever the
  instance's switch, pause or limit, and the result is shown and kept.
- **Protocol 2.** Claims carry `types` instead of `judges`, jobs carry
  instances with settings, results name the instance and may be `failed`.
  The path stays `/api/worker/v1`, the committed document keeps its name
  and its `info.version` is 2; the parent speaks only 2, so a 0.2 worker
  gets `426` saying to run both from the same release, and a 0.3 worker
  gets the same from a 0.2 parent.

### Changes to the lead's design

- Fields that cannot change a verdict (secrets, a timeout) are left out of
  the fingerprint, so replacing a key judges nothing again.
- "Waiting" counts only instances that can run now, so a failing, limited
  or worker-less judge never freezes outcomes.
- The daily limit is a rolling 24 hours, which never exceeds a calendar-day
  quota whatever its time zone.
- ElevenLabs Scribe ships as a native type beside the generic
  OpenAI-compatible one. Neither offers keyword biasing.

## Consequences

Old judges' results became the migrated instances' results with an empty
settings fingerprint, so nothing already judged is judged again. The
outcome query scans every result on each list query, as before; fine for
tens of thousands of clips. Two workers offering different versions of one
type still re-judge each other's clips; run one version at a time. A cloud
judge sends clips off the household's machines: it starts off, turning it
on asks for confirmation, and docs/privacy.md says so.
