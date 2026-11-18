"""Judges: each answers "does this clip contain its wake word?".

A judge is anything with the `Judge` shape. `prepare()` loads (and on first
use downloads) its models and may be slow; `judge()` must be safe to call
for any clip and should not raise for ordinary audio, but the job loop turns
an exception into an `abstain` result anyway, so one bad clip or judge never
stops the worker.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from wakewright_worker.audio import Clip
from wakewright_worker.models import ModelCache, ModelFile

Verdict = Literal["yes", "no", "abstain"]


@dataclass(frozen=True)
class JudgeResult:
    verdict: Verdict
    score: float | None = None
    threshold: float | None = None
    transcript: str | None = None
    detail: str | None = None


class Judge(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def version(self) -> str:
        """Changes whenever the judge's model or logic changes, so the parent
        can tell old results from new ones."""
        ...

    @property
    def wake_words(self) -> frozenset[str] | None:
        """Normalised wake words it has a model for, or None for any."""
        ...

    def model_files(self) -> list[ModelFile]:
        """Every file `prepare` will need, for `download-models`."""
        ...

    def prepare(self) -> None:
        """Load models, downloading them into the cache first if needed."""
        ...

    def judge(self, clip: Clip) -> JudgeResult: ...


def normalise_wake_word(name: str) -> str:
    """'Hey_Jarvis', 'hey jarvis' and 'Hey Jarvis!' all become 'hey jarvis'."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", name.lower()).split())


def no_model(judge: str, wake_word: str, known: frozenset[str]) -> JudgeResult:
    return JudgeResult(
        verdict="abstain",
        detail=f"{judge} has no model for the wake word {wake_word!r}; it has "
        + ", ".join(sorted(known)),
    )


JudgeFactory = Callable[[ModelCache], Judge]


def factories() -> dict[str, JudgeFactory]:
    """The built-in judges by name. Imports are deferred so that a judge's
    native libraries load only when it is enabled."""

    def oww(cache: ModelCache) -> Judge:
        from wakewright_worker.judges.openwakeword import OpenWakeWordJudge  # noqa: PLC0415

        return OpenWakeWordJudge(cache)

    def mww(cache: ModelCache) -> Judge:
        from wakewright_worker.judges.microwakeword import MicroWakeWordJudge  # noqa: PLC0415

        return MicroWakeWordJudge(cache)

    def stt(cache: ModelCache) -> Judge:
        from wakewright_worker.judges.stt import SpeechToTextJudge  # noqa: PLC0415

        return SpeechToTextJudge(cache)

    return {"openwakeword": oww, "microwakeword": mww, "stt": stt}
