# Writing a worker

A worker judges clips for a Wakewright parent. It needs no inbound port: it
calls the parent over HTTP(S), claims clips, downloads their audio, runs its
judges and sends back their verdicts. Wakewright's own worker lives in
`apps/worker` ([running it](worker.md)); this page is for anyone writing
another. The exact wire
format is [`docs/api/worker-v1.openapi.json`](api/worker-v1.openapi.json)
(OpenAPI 3.1), which is the source of truth; the decisions behind it are in
[ADR 0016](adr/0016-judging-queue-and-agreement.md) and
[ADR 0019](adr/0019-configurable-weighted-judges.md). This is protocol 2
(Wakewright 0.3); the path is still `/api/worker/v1`.

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
then gets no jobs, and limit the judge types it may run; the parent only
asks for judges whose type you offer and may run.

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

## Judge types and judges

A worker offers **judge types**: kinds of judge it can run, each with an
id, a version, a name, a kind (`wake_word_model` or `speech_to_text`), the
wake words it has models for and a **settings schema**. The owner sets up
**judges** (instances) of those types on the parent's Judges page, filling
in the form the schema describes; a job names the judges to run on its
clip with their settings, secrets such as API keys included. Keep those
settings in memory for the job only and never log them.

## The loop

All paths are under `/api/worker/v1`.

1. **Claim** with `POST /jobs/claim`:

   ```json
   {
     "protocol": 2,
     "worker": { "name": "judge-laptop", "version": "0.3.0" },
     "types": [
       {
         "id": "openwakeword",
         "version": "v0.5.1+1",
         "name": "openWakeWord",
         "kind": "wake_word_model",
         "description": "",
         "external": false,
         "wakeWords": ["alexa"],
         "settings": []
       },
       {
         "id": "openai-compatible",
         "version": "openai-compatible+1",
         "name": "OpenAI-compatible transcription",
         "kind": "speech_to_text",
         "description": "Sends each clip to a speech-to-text service.",
         "external": true,
         "wakeWords": null,
         "settings": [
           { "key": "base_url", "label": "API base URL", "type": "text", "required": true },
           { "key": "api_key", "label": "API key", "type": "secret" },
           { "key": "model", "label": "Model", "type": "text", "required": true },
           {
             "key": "timeout",
             "label": "Timeout (seconds)",
             "type": "number",
             "default": 30,
             "minimum": 1,
             "maximum": 120,
             "affectsVerdict": false
           }
         ]
       }
     ],
     "max": 8,
     "waitSeconds": 25
   }
   ```

   `wakeWords` lists the wake words a type has a model for, or `null` for
   any. A setting has a `key`, `label`, `type` (`text`, `secret`,
   `number`, `select`, `boolean`) and optionally `help`, `default`,
   `required`, `options` (for a select), `minimum`, `maximum`,
   `placeholder` and `affectsVerdict` (default true; a secret never does).
   `external` says the type sends clips off the worker, so the UI warns
   before such a judge is turned on.

   The answer is `{ "jobs": [...] }`, newest clips first; each job names
   its `id`, `clipId`, `wakeWord`, `leaseExpiresAt` and the `judges` to
   run:

   ```json
   {
     "id": "01a1...",
     "clipId": "01a0...",
     "wakeWord": "alexa",
     "judges": [
       { "instance": "openwakeword", "type": "openwakeword", "settings": {} },
       {
         "instance": "0198f6a2-...",
         "type": "openai-compatible",
         "settings": {
           "base_url": "https://api.example.com/v1",
           "api_key": "…",
           "model": "whisper-1",
           "timeout": 30
         }
       }
     ],
     "leaseExpiresAt": "2026-11-18T12:02:00.000Z"
   }
   ```

   A clip is offered while it lacks a current result from an enabled
   judge: at the version you offer and with the judge's current settings.
   So a new version, or a setting that can change a verdict, judges every
   clip again. A judge paused after a failure or at its daily limit is left
   out. With nothing to do the request waits up to `waitSeconds` (at most 60) and answers an empty list; claim again straight away. The claim also
   tells the parent the worker is connected. A paused worker's claim waits
   and answers an empty list.

2. **Download** `GET /clips/{clipId}/audio`: a WAV, 16 kHz mono 16-bit PCM,
   normally 3.00 s with the wake word near the end.

3. **Answer** with `POST /jobs/{id}/results`, at most one result per judge
   the job named:

   ```json
   {
     "results": [
       {
         "instance": "openwakeword",
         "type": "openwakeword",
         "version": "v0.5.1+1",
         "verdict": "yes",
         "score": 0.93,
         "threshold": 0.5,
         "transcript": null,
         "detail": null,
         "failure": null,
         "durationMs": 41
       },
       {
         "instance": "0198f6a2-...",
         "type": "openai-compatible",
         "version": "openai-compatible+1",
         "verdict": "failed",
         "score": null,
         "threshold": null,
         "transcript": null,
         "detail": "rate limited (HTTP 429)",
         "failure": { "reason": "rate_limit", "retryAfterSeconds": 20 },
         "durationMs": 180
       }
     ]
   }
   ```

   `verdict` is one of:
   - `yes` or `no`: the answer.
   - `abstain`, with a `detail`: the judge cannot say for this clip (no
     model for its wake word, unusable audio, a clip the service refuses).
     It is recorded, so the clip is not offered to that judge again.
   - `failed`, with a `detail` and `failure` (`reason`: `auth`,
     `rate_limit`, `quota`, `network`, `server` or `other`;
     `retryAfterSeconds` if the service said): the judge cannot answer now.
     Nothing is recorded; the parent pauses the judge and shows the detail
     on the Judges page. Do not run that judge again in the same claim.

   A judge left out is offered again later. `204` means stored.

## Errors to handle

| Status | Meaning                                                                                     | What to do                         |
| ------ | ------------------------------------------------------------------------------------------- | ---------------------------------- |
| `400`  | The request does not match the schema, or names a judge or version the job did not ask for  | Fix the worker; the body says what |
| `401`  | Missing or wrong token, replaced, or its worker was deleted                                 | Report it; retry after a while     |
| `404`  | No such clip                                                                                | Drop the job                       |
| `409`  | The lease expired or was released (the worker was paused or changed), or the job is unknown | Drop the job and claim again       |
| `426`  | The parent does not speak this `protocol`; the body has its range                           | Upgrade the parent or the worker   |

Each job is leased to your claim for about two minutes, so claim no more
than you can judge in that time. Retry network errors with a short backoff.

## Outcomes

The parent weighs each judge's latest yes or no by the weight the owner
gave it, and shows an outcome per clip: yes, no, uncertain, not enough
evidence or waiting ([judges.md](judges.md)). Type ids are free-form
(`a-z`, digits, `_ . -`); the name a type advertises is what the UI shows.

## Testing without the parent

The OpenAPI file is committed, so a worker's tests can check its requests
against it without running Wakewright. For an end-to-end run, the fake
worker in `devtools/fake-worker` is a small reference implementation in
TypeScript.
