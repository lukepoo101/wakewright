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

Each worker has its own token: create the worker on the parent's Workers
page, which shows its token once, or declare it in the parent's
configuration ([configuration](configuration.md#workers)). Every request
sends `Authorization: Bearer <token>`. A missing token, a wrong one, or one
that was replaced or whose worker was deleted answers `401`. User sign-in
has nothing to do with it. Tokens the parent makes start with `wwk_`; treat
them as secrets and never log them.

The token decides which worker you are: the parent shows what your claims
report (`worker.name`, usually the host name, and `worker.version`) beside
the name the owner gave the worker. The owner can pause a worker, which
then gets no jobs, and limit the judges it may run; the parent only asks
for judges you offer and may run.

### The pairing string

The Workers page also shows a pairing string, so a worker needs one value:

```
wakewright-pair:1:eyJ1cmwiOiJodHRwOi8vd2FrZXdyaWdodDo4MDgwIiwidG9rZW4iOiJ3d2tfZXhhbXBsZSJ9
```

It is `wakewright-pair:`, the format version (`1`), `:`, and the
base64url encoding (no padding) of a UTF-8 JSON object with the parent's
address and the token: `{"url":"http://wakewright:8080","token":"wwk_example"}`.
A worker should accept it in place of an address and a token, refuse a
version it does not know by name, and let a separately configured address
override the one inside. It holds the token: never log it.

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
   shows. A paused worker's claim waits and answers an empty list.

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

| Status | Meaning                                                                                     | What to do                         |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `400`  | The request does not match the schema, or names an unasked judge                            | Fix the worker; the body says what |
| `401`  | Missing or wrong token, replaced, or its worker was deleted                                 | Report it; retry after a while     |
| `404`  | No such clip                                                                                | Drop the job                       |
| `409`  | The lease expired or was released (the worker was paused or changed), or the job is unknown | Drop the job and claim again       |
| `426`  | The parent does not speak this `protocol`; the body has its range                           | Upgrade the parent or the worker   |

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
