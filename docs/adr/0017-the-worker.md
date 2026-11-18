# 0017 The worker: Python with uv, three downloaded judges, a second image

- Status: accepted
- Date: 2026-11-18
- Amends: [0006](0006-tooling.md) (Python tooling), [0009](0009-ci-checks-and-fork-safety.md)
  (path filters), [0010](0010-releases-changelog-and-images.md) (two images)

## Context

[ADR 0002](0002-parent-and-workers.md) gives ML work to stateless workers;
[ADR 0016](0016-judging-queue-and-agreement.md) defines how they claim clips
and report verdicts. This is Wakewright's own worker. It must judge 3.00 s,
16 kHz mono clips with openWakeWord, microWakeWord and a CPU speech-to-text
model; ship as a second image released with the parent; and stay a
headless core that a Windows desktop application can wrap later, so no
Docker-only assumptions. Wakewright is Apache-2.0, and the openWakeWord
pretrained models are CC BY-NC-SA 4.0, so no model may be in the repository
or an image.

## Decision

### Toolchain

| Need            | Choice                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Language        | Python 3.13 (the ML libraries' language), pinned in `mise.toml` with uv                                                                |
| Project         | uv, `apps/worker` with a src layout, `uv.lock` committed, exact pins, `uv_build` backend                                               |
| Format and lint | ruff                                                                                                                                   |
| Types           | pyright, strict, from PyPI with its own Node (`pyright[nodejs]`). ty is still 0.0.x (beta) in November 2026                            |
| Tests           | pytest; the real-model tests are marked `models` and opt in                                                                            |
| Supply chain    | `[tool.uv] exclude-newer = "3 days"` (as `bunfig.toml`), checked offline against `uv.lock`'s upload times; the same licence allow list |

`mise run check` runs `check:repo`, `check:bun` and `check:worker`, so one
command checks both languages. HTTP is httpx; configuration is
`WAKEWRIGHT_WORKER__*` environment variables, the cache directory defaults
to the platform's per-user cache (`%LOCALAPPDATA%` on Windows), and the
entry point is a console script, so `uv run wakewright-worker` works on any
machine.

### Judges

A judge is a small protocol: `name`, `version`, `wake_words`,
`model_files()`, `prepare()` and `judge(clip)`. Each version names its
model pin and a logic number (`v0.5.1+1`), so a change re-judges every clip.

- **openWakeWord**: the v0.5.1 release models (melspectrogram, embedding,
  alexa, hey jarvis, hey mycroft, hey rhasspy) run with onnxruntime only.
  The `openwakeword` package is not used: 0.6.0 (February 2024) is its
  latest release and needs `tflite-runtime` on Linux, which has no Python
  3.13 wheels. Its streaming pipeline is reproduced exactly (80 ms chunks
  with 480 samples of context, 1 s of silence each side, as
  `predict_clip`), which matches openwakeword 0.6.0 to the third decimal on
  real clips. Computing the melspectrogram over the whole clip instead moved
  scores by up to 0.3. Yes at 0.5.
- **microWakeWord**: models from `esphome/micro-wake-word-models` at a
  pinned commit, run with OHF-Voice's `pymicro-wakeword` (Apache-2.0,
  wheels for Linux x86_64 and aarch64, macOS and Windows), which uses the
  same TFLite micro frontend the models were trained with. The manifest's
  `probability_cutoff` and `sliding_window_size` are honoured as ESPHome
  does. 0.5 s of silence follows the clip: without it, six of ten real
  activations ended before the sliding window filled and were missed. The
  wheel's own bundled models are deleted from the image.
- **Speech to text**: NVIDIA Parakeet TDT 0.6B v2 (CC-BY-4.0), ONNX export
  `istupakov/parakeet-tdt-0.6b-v2-onnx`, run by `onnx-asr` (MIT). Compared:
  Whisper base (int8) through onnx-asr (MIT) heard the wake word in
  eight of ten activations and heard other words in the other two; Moonshine
  has no onnx-asr support and adds its own tokenizer stack; faster-whisper
  is CTranslate2, not ONNX. Full precision, not int8: on ten real
  activations int8 missed the wake word three times, full precision none,
  at about the same speed on CPU. It is the large download (2.5 GB) and
  about 3 GB of memory; `WAKEWRIGHT_WORKER__JUDGES` can leave it out on a
  small machine.

**Models are downloaded on first use**, never committed or baked in: each
file is pinned by URL at an immutable revision (release tag or commit),
size and SHA-256, downloaded to a temporary file, verified and renamed into
`<cache>/models/<source>/<revision>/`. [models.md](../models.md) lists each
model, its source and licence.

### The loop

Judges are prepared before they are offered and retried with backoff if
they fail, so one broken model does not stop the others. Claims long-poll;
an unreachable or refusing parent is retried with jittered exponential
backoff (to 60 s). A judge that raises is reported as `abstain` with the
error. SIGTERM (or Ctrl+C) interrupts an idle long poll at once and
otherwise lets the job in hand finish and post. `--once` makes one claim
and exits, `self-test` runs every judge on generated audio, and
`download-models` warms the cache. `run --fake-judges` swaps in judges that
load nothing, so `mise run integration` (and CI) runs the real loop against
the real parent without models.

### Image

`deploy/docker/worker.Dockerfile`: `python:3.13-slim-trixie` and the uv
image, both by digest; the locked virtual environment only, uid 10001,
read-only root file system, `/cache` as a volume, CPU only. amd64 and
arm64: every native wheel (onnxruntime, numpy, pymicro-wakeword,
pymicro-features) is published for both.

### CI and releases

- **Path filters** (amending ADR 0009, which had none): a `Changes` job
  lists the pull request's files. The Bun check runs unless every file is
  worker-only (the parent's image + E2E job, the slowest, runs on every
  change, since waiting for `Changes` lengthened every parent pull request); the worker jobs (check, image on both
  architectures) run when the worker, its Dockerfile, the protocol file,
  `mise.toml` or the workflows change. Repository-wide checks (versions,
  actionlint, zizmor, hadolint, Renovate) and the parent + worker
  integration run on every change; `CI OK` still gates everything, and
  pushes to `main` run every job. With two languages the full set no longer
  fits in a minute, which was ADR 0009's reason for having no filters.
- **Real models** run in `worker-models.yml` (weekly, by hand, and on pull
  requests that touch a judge or the pins) with the 2.5 GB cached.
- **Two images, one version** (amending ADR 0010), the pattern Immich uses
  for `immich-server` and `immich-machine-learning`: the worker's version
  is the product version (`pyproject.toml`, kept equal by
  `check-versions.ts` and set by `mise run release`), and `publish.yml`
  builds, scans, attests and tags `ghcr.io/lukepoo101/wakewright` and
  `ghcr.io/lukepoo101/wakewright-worker` identically, with both images and
  their SBOMs in one GitHub release. As with Immich's ML image, accelerated
  variants would be tag suffixes later (`-cuda`); the CPU image has none.
  Unlike Immich, `main` rebuilds both images on every push rather than
  retagging an unchanged one, so the publish path of each runs every time.

### Changes to the milestone contract

- One version string per judge, not per wake word (`v0.5.1+1`, not
  `alexa_v0.1+1`): a claim offers one version per judge, and every wake
  word's model is pinned in one release or commit anyway.
- Two-word wake words are offered in both spellings (`hey jarvis`,
  `hey_jarvis`), because the parent matches the clip's wake word exactly.
- `WAKEWRIGHT_WORKER__BATCH` (claim `max`, 1 to 32),
  `WAKEWRIGHT_WORKER__WAIT_SECONDS`, `WAKEWRIGHT_WORKER__JUDGES`,
  `WAKEWRIGHT_WORKER__LOG_FORMAT` and `WAKEWRIGHT_WORKER__LOG_LEVEL` were
  added to the contract's variables.

## Consequences

The first start of a full worker downloads about 2.5 GB, and Parakeet
needs about 3 GB of memory. Python enters the repository with its own
lockfile, Renovate rules and release-age check. Pull requests touching only
one side skip the other side's jobs. The parent image still holds no
Python, and the worker image holds no model.
