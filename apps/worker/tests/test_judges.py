"""Judge logic that needs no model: wake word names, transcript matching,
clips without a model, and the audio reader."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from wakewright_worker.audio import Clip, InvalidAudio, noise, read_wav, silence, tone, write_wav
from wakewright_worker.judges import normalise_wake_word
from wakewright_worker.judges.registry import builtin_types
from wakewright_worker.judges.speech import contains, words
from wakewright_worker.models import ModelCache


@pytest.mark.parametrize(
    ("raw", "normal"),
    [("Alexa", "alexa"), ("hey_jarvis", "hey jarvis"), ("Hey  Jarvis!", "hey jarvis"), ("", "")],
)
def test_normalise_wake_word(raw: str, normal: str) -> None:
    assert normalise_wake_word(raw) == normal


@pytest.mark.parametrize(
    ("transcript", "wake_word", "expected"),
    [
        ("Alexa.", "alexa", True),
        ("So, Alexa?", "Alexa", True),
        ("Turn it off, Alexa.", "alexa", True),
        ("Alexa Alexa.", "alexa", True),
        ("A lexicon.", "alexa", False),
        ("Alexander", "alexa", False),
        ("Alexa's timer", "alexa", False),
        ("Hey, Jarvis, lights", "hey_jarvis", True),
        ("hey there jarvis", "hey jarvis", False),
        ("Okay-Nabu", "okay nabu", True),
        ("", "alexa", False),
        ("alexa", "", False),
    ],
)
def test_transcript_contains_wake_word(transcript: str, wake_word: str, expected: bool) -> None:
    assert contains(transcript, wake_word) is expected


def test_words() -> None:
    assert words("It's OK. Fine!") == ["its", "ok", "fine"]


def test_wake_word_judges_abstain_without_a_model(monkeypatch: pytest.MonkeyPatch) -> None:
    cache = ModelCache(Path("unused"))
    for name in ("openwakeword", "microwakeword"):
        judge = builtin_types()[name](cache)
        # Pretend prepare() ran, without loading any model.
        monkeypatch.setattr(judge, "_models", {"alexa": object()})
        result = judge.judge(Clip("Computer", silence()), {})
        assert result.verdict == "abstain"
        assert result.detail is not None
        assert "'Computer'" in result.detail
        assert "alexa" in result.detail
        assert judge.wake_words is not None
        assert "alexa" in judge.wake_words


def test_every_judge_refuses_to_run_before_prepare() -> None:
    cache = ModelCache(Path("unused"))
    for make in builtin_types().values():
        judge = make(cache)
        if judge.external:
            continue
        with pytest.raises(RuntimeError, match="before prepare"):
            judge.judge(Clip("alexa", silence()), {})


def test_versions_name_the_model_and_logic() -> None:
    cache = ModelCache(Path("unused"))
    versions = {n: f(cache).version for n, f in builtin_types().items()}
    # Unchanged from 0.2, so nothing judged before is judged again.
    assert versions == {
        "openwakeword": "v0.5.1+1",
        "microwakeword": "v2@40ff33f+1",
        "stt": "parakeet-tdt-0.6b-v2@0bbb45a+1",
        "openai-compatible": "openai-compatible+1",
        "elevenlabs": "elevenlabs+1",
    }


def test_wav_round_trip() -> None:
    x = noise(3.0)
    assert np.array_equal(read_wav(write_wav(x)), x)
    clip = Clip("alexa", tone(3.0))
    assert clip.seconds == 3.0
    assert clip.float32().dtype == np.float32
    assert abs(float(clip.float32().max())) <= 1.0


def test_wav_rejects_other_formats() -> None:
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44_100)
        w.writeframes(b"\0" * 400)
    with pytest.raises(InvalidAudio, match="expected 16 kHz mono"):
        read_wav(buf.getvalue())
    with pytest.raises(InvalidAudio, match="not a readable WAV"):
        read_wav(b"RIFF....nope")
    with pytest.raises(InvalidAudio, match="no audio"):
        read_wav(write_wav(silence(0)))
