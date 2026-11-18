# Running the worker

The worker judges your clips: it offers judge types, and for each clip
runs the judges you set up on the parent's Judges page, which say whether
the clip contains its wake word, and sends their verdicts to the parent,
which weighs them into an outcome ([judges.md](judges.md)). It is a separate program from the parent,
so it can run on a bigger machine than the one that collects clips. It
needs no open port: it connects to the parent, never the other way round.
The protocol is in [workers.md](workers.md); the decisions behind this
worker are in [ADR 0017](adr/0017-the-worker.md).

| Judge type          | What it does                                                           | Says yes when                                        |
| ------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `openwakeword`      | runs openWakeWord's pretrained model for the clip's wake word          | its highest score in the clip is 0.5 or more         |
| `microwakeword`     | runs the ESPHome microWakeWord model for the clip's wake word          | it fires, by the model's own cutoff and window       |
| `stt`               | transcribes the clip with NVIDIA Parakeet TDT 0.6B v2 (English) on CPU | the transcript contains the wake word as whole words |
| `openai-compatible` | sends the clip to an OpenAI-compatible transcription API you configure | the same, from the service's transcript              |
| `elevenlabs`        | sends the clip to ElevenLabs Scribe with your API key                  | the same, from the service's transcript              |

The last two run only for judges you add on the Judges page, with their
own settings and API keys, and send clips to that service; they need
outbound HTTPS from the worker.

Wake words with models today: alexa, hey jarvis, hey mycroft and hey
rhasspy (openWakeWord), alexa, hey jarvis, hey mycroft and okay nabu
(microWakeWord). Speech to text judges any wake word. The parent only asks
a judge about clips whose wake word it has a model for.

**Models are downloaded on first start**, about 2.5 GB in all (almost all
of it Parakeet), into the cache directory, and reused after that. See
[models.md](models.md) for each model's source and licence. Plan for about
4 GB of memory with the three local judges; on a CPU from the last few years a
3 s clip takes about half a second.

## Add the worker to the parent

Each worker has its own token. On the parent's **Workers** page choose
**Add worker**, give it a name and create it. Wakewright shows its token
once, with a **pairing string**: the parent's address and the token in one
value, which is all the worker needs. Check the address it suggests is one
the worker can reach. For GitOps, declare the worker in the parent's
configuration instead ([configuration](configuration.md#workers)) and give
the worker the same token with `WAKEWRIGHT_WORKER__PARENT_URL`.

## With Docker

The image is `ghcr.io/lukepoo101/wakewright-worker`, for amd64 and arm64,
with the same tags as the parent's image. Use the same release for both.

```sh
docker volume create wakewright-worker-cache
docker run -d --name wakewright-worker --restart unless-stopped \
  -v wakewright-worker-cache:/cache \
  -e WAKEWRIGHT_WORKER__PAIRING='the pairing string from the Workers page' \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/lukepoo101/wakewright-worker:0.3.0
```

[`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml)
runs the parent and the worker together, the worker declared with a token
in a shared secret.

| What         | Value                                                                          |
| ------------ | ------------------------------------------------------------------------------ |
| Ports        | none                                                                           |
| Volume       | `/cache`: downloaded models. Keep it, or every start downloads 2.5 GB again    |
| Health check | built in (`wakewright-worker healthcheck`): the job loop ran in the last 5 min |
| User         | uid 10001; works with a read-only root file system and `/tmp` as tmpfs         |
| Stop         | `SIGTERM`; the clip in hand is finished first, so allow 30 s                   |
| Replicas     | any number; each takes different clips                                         |

## Without Docker, on any machine

You need [uv](https://docs.astral.sh/uv/) (or [mise](https://mise.jdx.dev),
which installs the pinned Python and uv) and a clone of the repository.
Linux (x86_64, arm64), macOS and Windows (x64) all work: every library the
worker uses publishes wheels for them.

```sh
git clone https://github.com/lukepoo101/wakewright && cd wakewright/apps/worker
uv run --frozen wakewright-worker run --pairing 'the pairing string from the Workers page'
```

The same command works in Windows PowerShell. A command-line argument can
be seen by other users of the machine; on a shared one, set
`WAKEWRIGHT_WORKER__PAIRING` (`$env:WAKEWRIGHT_WORKER__PAIRING = '...'` in
PowerShell) or `WAKEWRIGHT_WORKER__PAIRING_FILE` instead.
Models go to the per-user cache directory: `~/.cache/wakewright-worker` on
Linux, `~/Library/Caches/wakewright-worker` on macOS,
`%LOCALAPPDATA%\Wakewright\worker\cache` on Windows. Ctrl+C stops it.

## Configuration

| Variable                          | Default            | Meaning                                                                                                              |
| --------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `WAKEWRIGHT_WORKER__PAIRING`      | none               | The pairing string from the Workers page (or `run --pairing`)                                                        |
| `WAKEWRIGHT_WORKER__PAIRING_FILE` | none               | A file holding the pairing string                                                                                    |
| `WAKEWRIGHT_WORKER__PARENT_URL`   | from the pairing   | The parent's address; replaces the one in a pairing string                                                           |
| `WAKEWRIGHT_WORKER__TOKEN`        | from the pairing   | This worker's token, instead of a pairing string                                                                     |
| `WAKEWRIGHT_WORKER__TOKEN_FILE`   | none               | A file holding the token, instead of `TOKEN`                                                                         |
| `WAKEWRIGHT_WORKER__CACHE_DIR`    | the per-user cache | Where models are downloaded (`/cache` in the image)                                                                  |
| `WAKEWRIGHT_WORKER__NAME`         | the host name      | What it reports itself as, shown beside the worker's name                                                            |
| `WAKEWRIGHT_WORKER__JUDGES`       | all five           | The judge types it offers: a comma-separated subset of `openwakeword,microwakeword,stt,openai-compatible,elevenlabs` |
| `WAKEWRIGHT_WORKER__BATCH`        | `8`                | Clips claimed at a time (1 to 32); lower it on a slow machine                                                        |
| `WAKEWRIGHT_WORKER__WAIT_SECONDS` | `25`               | How long a claim waits for new clips (0 to 60)                                                                       |
| `WAKEWRIGHT_WORKER__LOG_FORMAT`   | `json`             | `json` (one object per line) or `text`                                                                               |
| `WAKEWRIGHT_WORKER__LOG_LEVEL`    | `INFO`             | `DEBUG`, `INFO`, `WARNING` or `ERROR`                                                                                |

Leave `stt` out of `JUDGES` on a machine with little memory: the wake word
models need a few megabytes and the cloud types nothing. Leave a cloud
type out to make sure this worker never sends clips to that kind of
service (the Workers page can also limit the types a worker may run).

## Commands

| Command                                        | What it does                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `wakewright-worker` (or `run [--pairing S]`)   | judge clips until stopped                                                                   |
| `wakewright-worker run --once`                 | make one claim, judge what it returns and exit (0 when the parent was used)                 |
| `wakewright-worker download-models [--verify]` | download every enabled judge's models and exit; `--verify` re-hashes them                   |
| `wakewright-worker self-test`                  | load every local judge type and check it answers no for silence, noise and a tone           |
| `wakewright-worker judge FILE.wav... [--json]` | judge local WAV files with the local types, without a parent (`--wake-word`, default alexa) |
| `wakewright-worker healthcheck`                | exit 0 if a worker's loop on this machine ran in the last 5 minutes                         |

With Docker, put the command after the image name, for example
`docker run --rm -v wakewright-worker-cache:/cache ghcr.io/lukepoo101/wakewright-worker:0.3.0 self-test`.

## When something is wrong

The worker logs one line per event. The usual ones:

- `... refused this worker's token (401)`: the token was replaced, its
  worker was deleted on the Workers page, or it is mistyped.
- `cannot use the pairing string`: it was cut short when copied, or comes
  from a newer Wakewright than this worker.
- `no worker API at this address (404)`: the address is not a Wakewright
  parent, or the parent is older than the worker.
- `cannot claim jobs` with a connection error: the parent is down or the
  address is wrong; the worker retries every few seconds up to a minute.
- `judge could not be prepared`: a model could not be downloaded (the
  message names the URL); the other judges carry on and it is retried.
- A judge that fails on one clip sends `abstain` with the error, which the
  clip page shows, so that clip is not retried for ever.
- `judge cannot answer now; the parent retries it later`: a cloud judge
  was refused, rate limited, out of quota or unreachable. The parent pauses
  it and shows why on the Judges page; the other judges carry on.
- `the parent does not speak worker protocol 2`: the parent and the worker
  are from different releases; run both from the same one.
