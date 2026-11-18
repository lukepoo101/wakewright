# Running the worker

The worker judges your clips: for each one it asks three judges whether
the clip contains its wake word, and sends their verdicts to the parent,
which shows where they disagree. It is a separate program from the parent,
so it can run on a bigger machine than the one that collects clips. It
needs no open port: it connects to the parent, never the other way round.
The protocol is in [workers.md](workers.md); the decisions behind this
worker are in [ADR 0017](adr/0017-the-worker.md).

| Judge           | What it does                                                           | Says yes when                                        |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `openwakeword`  | runs openWakeWord's pretrained model for the clip's wake word          | its highest score in the clip is 0.5 or more         |
| `microwakeword` | runs the ESPHome microWakeWord model for the clip's wake word          | it fires, by the model's own cutoff and window       |
| `stt`           | transcribes the clip with NVIDIA Parakeet TDT 0.6B v2 (English) on CPU | the transcript contains the wake word as whole words |

Wake words with models today: alexa, hey jarvis, hey mycroft and hey
rhasspy (openWakeWord), alexa, hey jarvis, hey mycroft and okay nabu
(microWakeWord). Speech to text judges any wake word. The parent only asks
a judge about clips whose wake word it has a model for.

**Models are downloaded on first start**, about 2.5 GB in all (almost all
of it Parakeet), into the cache directory, and reused after that. See
[models.md](models.md) for each model's source and licence. Plan for about
4 GB of memory with all three judges; on a CPU from the last few years a
3 s clip takes about half a second.

## Set up the parent

Give the parent a worker token, for example with
`openssl rand -base64 32`, in `WAKEWRIGHT__WORKER__TOKEN` or
`WAKEWRIGHT__WORKER__TOKEN_FILE` ([configuration](configuration.md)), and
restart it. Home then says judging is set up and waits for a worker.

## With Docker

The image is `ghcr.io/lukepoo101/wakewright-worker`, for amd64 and arm64,
with the same tags as the parent's image. Use the same release for both.

```sh
docker volume create wakewright-worker-cache
docker run -d --name wakewright-worker --restart unless-stopped \
  -v wakewright-worker-cache:/cache \
  -e WAKEWRIGHT_WORKER__PARENT_URL=http://wakewright.local:8080 \
  -e WAKEWRIGHT_WORKER__TOKEN='the token you gave the parent' \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/lukepoo101/wakewright-worker:edge
```

[`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml)
runs the parent and the worker together with the token in a shared secret.

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
export WAKEWRIGHT_WORKER__PARENT_URL=http://wakewright.local:8080
export WAKEWRIGHT_WORKER__TOKEN='the token you gave the parent'
uv run --frozen wakewright-worker
```

On Windows PowerShell set the variables with
`$env:WAKEWRIGHT_WORKER__PARENT_URL = "http://wakewright.local:8080"`.
Models go to the per-user cache directory: `~/.cache/wakewright-worker` on
Linux, `~/Library/Caches/wakewright-worker` on macOS,
`%LOCALAPPDATA%\Wakewright\worker\cache` on Windows. Ctrl+C stops it.

## Configuration

| Variable                          | Default            | Meaning                                                       |
| --------------------------------- | ------------------ | ------------------------------------------------------------- |
| `WAKEWRIGHT_WORKER__PARENT_URL`   | required           | The parent's address, e.g. `http://wakewright:8080`           |
| `WAKEWRIGHT_WORKER__TOKEN`        | required           | The parent's `WAKEWRIGHT__WORKER__TOKEN`                      |
| `WAKEWRIGHT_WORKER__TOKEN_FILE`   | none               | A file holding the token, instead of `TOKEN`                  |
| `WAKEWRIGHT_WORKER__CACHE_DIR`    | the per-user cache | Where models are downloaded (`/cache` in the image)           |
| `WAKEWRIGHT_WORKER__NAME`         | the host name      | The name the parent shows for this worker                     |
| `WAKEWRIGHT_WORKER__JUDGES`       | all three          | A comma-separated subset of `openwakeword,microwakeword,stt`  |
| `WAKEWRIGHT_WORKER__BATCH`        | `8`                | Clips claimed at a time (1 to 32); lower it on a slow machine |
| `WAKEWRIGHT_WORKER__WAIT_SECONDS` | `25`               | How long a claim waits for new clips (0 to 60)                |
| `WAKEWRIGHT_WORKER__LOG_FORMAT`   | `json`             | `json` (one object per line) or `text`                        |
| `WAKEWRIGHT_WORKER__LOG_LEVEL`    | `INFO`             | `DEBUG`, `INFO`, `WARNING` or `ERROR`                         |

Leave `stt` out of `JUDGES` on a machine with little memory: the other two
need a few megabytes.

## Commands

| Command                                        | What it does                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `wakewright-worker` (or `run`)                 | judge clips until stopped                                                   |
| `wakewright-worker run --once`                 | make one claim, judge what it returns and exit (0 when the parent was used) |
| `wakewright-worker download-models [--verify]` | download every enabled judge's models and exit; `--verify` re-hashes them   |
| `wakewright-worker self-test`                  | load every judge and check it answers no for silence, noise and a tone      |
| `wakewright-worker judge FILE.wav... [--json]` | judge local WAV files without a parent (`--wake-word`, default alexa)       |
| `wakewright-worker healthcheck`                | exit 0 if a worker's loop on this machine ran in the last 5 minutes         |

With Docker, put the command after the image name, for example
`docker run --rm -v wakewright-worker-cache:/cache ghcr.io/lukepoo101/wakewright-worker:edge self-test`.

## When something is wrong

The worker logs one line per event. The usual ones:

- `cannot claim jobs ... not set up (404)`: the parent has no worker token.
- `... refused the worker token (401)`: the tokens differ.
- `cannot claim jobs` with a connection error: the parent is down or the
  address is wrong; the worker retries every few seconds up to a minute.
- `judge could not be prepared`: a model could not be downloaded (the
  message names the URL); the other judges carry on and it is retried.
- A judge that fails on one clip sends `abstain` with the error, which the
  clip page shows, so that clip is not retried for ever.
