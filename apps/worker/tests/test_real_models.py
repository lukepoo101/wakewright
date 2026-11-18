"""The real models: download (or reuse) them and check they behave.

Opt-in: about 2.5 GB to download the first time. Run with
`mise run worker-models-test`; CI runs it from the worker-models workflow
with a cached model directory. Unit tests never come here.

With no recordings in the repository, the meaningful checks are that every
model loads, runs on 3 s of generated audio with no speech in it, answers
`no` and does so within a time budget. The wake word judges are also fed a
clip with no model, which must abstain.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from wakewright_worker.audio import Clip, noise, silence, tone
from wakewright_worker.config import default_cache_dir
from wakewright_worker.judges import JudgeType as Judge
from wakewright_worker.judges.registry import builtin_types
from wakewright_worker.models import ModelCache

pytestmark = pytest.mark.models

# Per 3 s clip, on a 4-vCPU CI runner. Parakeet is the slow one (~1 s there).
BUDGET_MS = {"openwakeword": 2_000, "microwakeword": 1_000, "stt": 10_000}


@pytest.fixture(scope="module")
def judges() -> dict[str, Judge]:
    root = Path(os.environ.get("WAKEWRIGHT_WORKER__CACHE_DIR") or default_cache_dir())
    cache = ModelCache(root)
    out: dict[str, Judge] = {}
    for name, make in builtin_types().items():
        judge = make(cache)
        if judge.external:
            continue
        judge.prepare()
        out[name] = judge
    return out


CLIPS = {
    "silence": silence(),
    "white noise": noise(level=0.1),
    "quiet noise": noise(level=0.005, seed=1),
    "440 Hz tone": tone(),
}


@pytest.mark.parametrize("name", ["openwakeword", "microwakeword", "stt"])
@pytest.mark.parametrize("audio", list(CLIPS))
def test_no_wake_word_in_audio_without_speech(
    judges: dict[str, Judge], name: str, audio: str
) -> None:
    judge = judges[name]
    judge.judge(Clip("alexa", silence(1.0)), {})  # warm up
    t0 = time.perf_counter()
    result = judge.judge(Clip("alexa", CLIPS[audio]), {})
    ms = 1000 * (time.perf_counter() - t0)
    assert result.verdict == "no", result
    assert ms < BUDGET_MS[name], f"{name} took {ms:.0f} ms"
    if name == "stt":
        assert result.transcript is not None
    else:
        assert result.score is not None
        assert result.threshold is not None
        assert result.score < result.threshold


@pytest.mark.parametrize("name", ["openwakeword", "microwakeword"])
def test_every_pinned_wake_word_model_runs(judges: dict[str, Judge], name: str) -> None:
    judge = judges[name]
    assert judge.wake_words is not None
    for word in judge.wake_words:
        assert judge.judge(Clip(word, noise()), {}).verdict == "no"
    assert judge.judge(Clip("computer", noise()), {}).verdict == "abstain"
