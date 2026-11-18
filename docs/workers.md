# Writing a worker

A worker judges clips for a Wakewright parent. It needs no inbound port: it
calls the parent over HTTP(S), claims clips, downloads their audio, runs its
judges and sends back their verdicts. Wakewright's own worker lives in
`apps/worker` ([running it](worker.md)); this page is for anyone writing
another. The exact wire
format is [`docs/api/worker-v1.openapi.json`](api/worker-v1.openapi.json)
(OpenAPI 3.1), which is the source of truth; the decisions behind it are in
[ADR 0016](adr/0016-judging-queue-and-agreement.md).

## Access

Set `WAKEWRIGHT__WORKER__TOKEN` (or `_FILE`) on the parent to a long random
value, for example `openssl rand -base64 32`, and give the worker the same
token. Every request sends `Authorization: Bearer <token>`. While the parent
has no token, every worker path answers `404`. A wrong or missing token
answers `401`. User sign-in has nothing to do with it.

## The loop

All paths are under `/api/worker/v1`.

1. **Claim** with `POST /jobs/claim`:

   ```json
   {
     "protocol": 1,
     "worker": { "name": "judge-laptop", "version": "0.0.3" },
     "judges": [
       { "name": "openwakeword", "version": "alexa_v0.1+1", "wakeWords": ["alexa"] },
       { "name": "stt", "version": "tiny+1", "wakeWords": null }
     ],
     "max": 8,
     "waitSeconds": 25
   }
   ```

   `wakeWords` lists the wake words a judge has a model for, or `null` for
   any. The answer is `{ "jobs": [...] }`, newest clips first; each job
   names its `id`, `clipId`, `wakeWord`, the `judges` to run and
   `leaseExpiresAt`. A clip is offered while it lacks a result from one of
   your judges at the version you offer, so changing a version re-judges
   every clip. With nothing to do the request waits up to `waitSeconds`
   (at most 60) and answers an empty list; claim again straight away.
   The claim also tells the parent the worker is connected, which the UI
   shows.

2. **Download** `GET /clips/{clipId}/audio`: a WAV, 16 kHz mono 16-bit PCM,
   normally 3.00 s with the wake word near the end.

3. **Answer** with `POST /jobs/{id}/results`, one result per judge the job
   named:

   ```json
   {
     "results": [
       {
         "judge": "openwakeword",
         "version": "alexa_v0.1+1",
         "verdict": "yes",
         "score": 0.93,
         "threshold": 0.5,
         "transcript": null,
         "detail": null,
         "durationMs": 41
       }
     ]
   }
   ```

   `verdict` is `yes`, `no` or `abstain`. A judge that cannot answer, or
   fails on this clip, sends `abstain` with a `detail` saying why, so the
   clip is not offered again. `204` means stored.

## Errors to handle

| Status | Meaning                                                           | What to do                         |
| ------ | ----------------------------------------------------------------- | ---------------------------------- |
| `400`  | The request does not match the schema, or names an unasked judge  | Fix the worker; the body says what |
| `401`  | Wrong or missing token                                            | Stop and report it                 |
| `404`  | Judging is not set up on the parent (no token), or no such clip   | Retry the claim after a while      |
| `409`  | The job's lease (about 2 minutes) expired, or the job is unknown  | Drop the job and claim again       |
| `426`  | The parent does not speak this `protocol`; the body has its range | Upgrade the parent or the worker   |

Each job is leased to your claim for about two minutes, so claim no more
than you can judge in that time. Retry network errors with a short backoff.

## Agreement

The parent counts each judge's latest result on a clip, ignoring
abstentions: two or more votes all the same is agreement, mixed votes are a
disagreement, fewer than two is inconclusive. Judge names are free-form
(`a-z`, digits, `_ . -`); the UI gives `openwakeword`, `microwakeword` and
`stt` their usual names and shows others as they are.

## Testing without the parent

The OpenAPI file is committed, so a worker's tests can check its requests
against it without running Wakewright. For an end-to-end run, the fake
worker in `devtools/fake-worker` is a small reference implementation in
TypeScript.
