"""Fake judges for tests: `wakewright-worker run --fake-judges`.

They have the real judges' names and wake words but load no model and
answer from a hash of the audio, so the same clip always gets the same
verdicts and a handful of clips covers agreement and disagreement. They let
the real job loop run against a real parent (`mise run integration`, CI)
without downloading anything. Their version is `fake+1`, so their results
are never mistaken for a real judge's.
"""

from __future__ import annotations

import hashlib

from wakewright_worker.audio import Clip
from wakewright_worker.judges import Judge, JudgeResult
from wakewright_worker.models import ModelFile

VERSION = "fake+1"


class FakeJudge:
    version = VERSION

    def __init__(self, name: str, salt: int, wake_words: frozenset[str] | None) -> None:
        self.name = name
        self._salt = salt
        self.wake_words = wake_words

    def model_files(self) -> list[ModelFile]:
        return []

    def prepare(self) -> None:
        return

    def judge(self, clip: Clip) -> JudgeResult:
        digest = hashlib.sha256(clip.pcm).digest()
        score = round(digest[self._salt] / 255, 4)
        verdict = "yes" if score >= 0.5 else "no"
        if self.wake_words is None:
            heard = clip.wake_word if verdict == "yes" else "something else"
            return JudgeResult(verdict, transcript=heard)
        return JudgeResult(verdict, score=score, threshold=0.5)


def fake_judges() -> list[Judge]:
    words = frozenset({"alexa", "hey jarvis", "okay nabu"})
    return [
        FakeJudge("openwakeword", 0, words),
        FakeJudge("microwakeword", 1, words),
        FakeJudge("stt", 2, None),
    ]
