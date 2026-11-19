"""The judge type registry and the plugin interface: every built-in type is
well formed, offers itself as the parent expects, and a new type needs only
`judge` (or, for speech to text, `transcribe`)."""

from __future__ import annotations

from pathlib import Path

import pytest

from wakewright_worker.audio import Clip, silence
from wakewright_worker.config import JUDGE_NAMES
from wakewright_worker.judges import (
    TYPE_ID,
    JudgeResult,
    JudgeType,
    Setting,
    Settings,
    TemporaryFailure,
)
from wakewright_worker.judges.registry import build, builtin_types
from wakewright_worker.judges.speech import SpeechToTextJudge, verdict_from_transcript
from wakewright_worker.loop import offer
from wakewright_worker.models import ModelCache

CACHE = ModelCache(Path("unused"))


def test_the_registry_holds_the_configurable_types() -> None:
    assert tuple(builtin_types()) == JUDGE_NAMES
    for t in build(list(JUDGE_NAMES), CACHE):
        assert TYPE_ID.match(t.id)
        assert t.name
        assert t.kind in ("wake_word_model", "speech_to_text", "listening")
        assert t.version
        keys = [s.key for s in t.settings]
        assert len(keys) == len(set(keys))
        # Only the cloud types send audio away, and only they have settings.
        assert t.external == (t.id in ("openai-compatible", "elevenlabs", "audio-question"))
        assert bool(t.settings) == t.external


def test_an_offer_carries_the_settings_form_without_secret_defaults() -> None:
    o = offer(builtin_types()["openai-compatible"](CACHE)).to_wire()
    assert o["external"] is True
    assert o["kind"] == "speech_to_text"
    fields = {f["key"]: f for f in o["settings"]}
    assert fields["api_key"]["type"] == "secret"
    assert fields["api_key"]["affectsVerdict"] is False
    assert fields["model"]["affectsVerdict"] is True
    assert fields["timeout"]["affectsVerdict"] is False
    assert fields["timeout"]["default"] == 30.0


def test_a_setting_is_checked_when_declared() -> None:
    with pytest.raises(ValueError, match="key"):
        Setting("Bad Key", "x")
    with pytest.raises(ValueError, match="options"):
        Setting("choice", "x", type="select")
    secret = Setting("token", "Token", type="secret", default="leak")
    assert secret.to_wire()["default"] is None


class Echo(SpeechToTextJudge):
    """The smallest speech-to-text type: the docs/judges.md example's shape."""

    id = "echo"
    name = "Echo"
    version = "echo+1"
    settings = (Setting("heard", "What it hears"),)

    def transcribe(self, clip: Clip, settings: Settings) -> str:
        heard = settings.get("heard")
        if heard is None:
            raise TemporaryFailure("nothing to hear", reason="other")
        return str(heard)


def test_a_new_speech_type_is_one_method_on_shared_matching() -> None:
    echo = Echo()
    assert echo.judge(Clip("hey_jarvis", silence()), {"heard": "Hey, Jarvis!"}).verdict == "yes"
    assert echo.judge(Clip("alexa", silence()), {"heard": "Alexander"}).verdict == "no"
    with pytest.raises(TemporaryFailure):
        echo.judge(Clip("alexa", silence()), {})
    assert offer(echo).wake_words is None


def test_shared_matching_keeps_the_transcript_trimmed() -> None:
    assert verdict_from_transcript("  Alexa.  ", "alexa") == JudgeResult("yes", transcript="Alexa.")
    assert verdict_from_transcript("", "alexa").verdict == "no"


def test_a_type_must_implement_judge() -> None:
    class Nothing(JudgeType):
        id = "nothing"
        name = "Nothing"
        kind = "wake_word_model"
        version = "1"

    with pytest.raises(TypeError):
        Nothing()  # type: ignore[abstract]
