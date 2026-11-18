"""The judge types this worker can offer, by id.

Each entry is a factory, so a type's native libraries load only when it is
enabled (`WAKEWRIGHT_WORKER__JUDGES`). To add a built-in type, write its
module and add one line here; docs/judges.md has the steps. The registry
is a plain mapping on purpose: a later release can extend it from Python
entry points (a `wakewright_worker.judge_types` group) so another package
can add types without changing this one.
"""

from __future__ import annotations

from collections.abc import Callable

from wakewright_worker.judges import JudgeType
from wakewright_worker.models import ModelCache

TypeFactory = Callable[[ModelCache], JudgeType]


def _openwakeword(cache: ModelCache) -> JudgeType:
    from wakewright_worker.judges.openwakeword import OpenWakeWordJudge  # noqa: PLC0415

    return OpenWakeWordJudge(cache)


def _microwakeword(cache: ModelCache) -> JudgeType:
    from wakewright_worker.judges.microwakeword import MicroWakeWordJudge  # noqa: PLC0415

    return MicroWakeWordJudge(cache)


def _parakeet(cache: ModelCache) -> JudgeType:
    from wakewright_worker.judges.stt import ParakeetJudge  # noqa: PLC0415

    return ParakeetJudge(cache)


def _openai_compatible(_cache: ModelCache) -> JudgeType:
    from wakewright_worker.judges.openai_compatible import OpenAICompatibleJudge  # noqa: PLC0415

    return OpenAICompatibleJudge()


def _elevenlabs(_cache: ModelCache) -> JudgeType:
    from wakewright_worker.judges.elevenlabs import ElevenLabsJudge  # noqa: PLC0415

    return ElevenLabsJudge()


BUILTIN: dict[str, TypeFactory] = {
    "openwakeword": _openwakeword,
    "microwakeword": _microwakeword,
    "stt": _parakeet,
    "openai-compatible": _openai_compatible,
    "elevenlabs": _elevenlabs,
}


def builtin_types() -> dict[str, TypeFactory]:
    """The built-in types by id, in the order they are offered."""
    return dict(BUILTIN)


def build(ids: tuple[str, ...] | list[str], cache: ModelCache) -> list[JudgeType]:
    available = builtin_types()
    types = [available[i](cache) for i in ids]
    for t, i in zip(types, ids, strict=True):
        if t.id != i:
            raise RuntimeError(f"the type registered as {i!r} calls itself {t.id!r}")
    return types
