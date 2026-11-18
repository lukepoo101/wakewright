"""Fake judge types for tests: `wakewright-worker run --fake-judges`.

They have the built-in types' ids and wake words but load no model and
answer from a hash of the audio, so the same clip always gets the same
verdicts and a handful of clips covers agreement and disagreement. They let
the real job loop run against a real parent (`mise run integration`, CI)
without downloading anything. Their version is `fake+1`, so their results
are never mistaken for a real judge's.
"""

from __future__ import annotations

import hashlib

from wakewright_worker.audio import Clip
from wakewright_worker.judges import JudgeResult, JudgeType, Kind, Settings

VERSION = "fake+1"


class FakeJudge(JudgeType):
    version = VERSION

    def __init__(
        self, type_id: str, name: str, salt: int, wake_words: frozenset[str] | None
    ) -> None:
        self.id = type_id
        self.name = f"{name} (fake)"
        self.kind: Kind = "speech_to_text" if wake_words is None else "wake_word_model"
        self.description = "Answers from a hash of the audio; for tests."
        self._salt = salt
        self.wake_words = wake_words

    def judge(self, clip: Clip, settings: Settings) -> JudgeResult:
        digest = hashlib.sha256(clip.pcm).digest()
        score = round(digest[self._salt] / 255, 4)
        verdict = "yes" if score >= 0.5 else "no"
        if self.wake_words is None:
            heard = clip.wake_word if verdict == "yes" else "something else"
            return JudgeResult(verdict, transcript=heard)
        return JudgeResult(verdict, score=score, threshold=0.5)


def fake_judges() -> list[JudgeType]:
    words = frozenset({"alexa", "hey jarvis", "okay nabu"})
    return [
        FakeJudge("openwakeword", "openWakeWord", 0, words),
        FakeJudge("microwakeword", "microWakeWord", 1, words),
        FakeJudge("stt", "Speech to text", 2, None),
    ]
