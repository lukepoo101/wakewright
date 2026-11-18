"""What every speech-to-text judge shares: a transcript, then one rule.

A speech-to-text type implements only `transcribe(clip, settings)`; this
base class turns the transcript into the verdict, the same way for every
backend: yes when the transcript, lowercased with punctuation removed,
contains the wake word as whole words. So a local model and a cloud API
are compared on the same terms, and a new provider is a client call and a
settings schema (docs/judges.md).
"""

from __future__ import annotations

import re
from abc import abstractmethod

from wakewright_worker.audio import Clip
from wakewright_worker.judges import JudgeResult, JudgeType, Kind, Settings, normalise_wake_word

# Changing `words` or `contains` can change verdicts: bump the version of
# every speech-to-text type with it (test_judges.py lists them).


def words(text: str) -> list[str]:
    """Lowercase words with punctuation removed ("Alexa's" -> "alexas")."""
    return re.sub(r"[^a-z0-9\s]", "", text.lower().replace("-", " ")).split()


def contains(transcript: str, wake_word: str) -> bool:
    heard = words(transcript)
    wanted = normalise_wake_word(wake_word).split()
    if not wanted:
        return False
    n = len(wanted)
    return any(heard[i : i + n] == wanted for i in range(len(heard) - n + 1))


def verdict_from_transcript(transcript: str, wake_word: str) -> JudgeResult:
    text = transcript.strip()
    return JudgeResult("yes" if contains(text, wake_word) else "no", transcript=text)


class SpeechToTextJudge(JudgeType):
    """A judge that hears any wake word: subclass it and implement `transcribe`."""

    kind: Kind = "speech_to_text"
    wake_words: frozenset[str] | None = None

    @abstractmethod
    def transcribe(self, clip: Clip, settings: Settings) -> str:
        """What was said in the clip. Raise TemporaryFailure when the
        backend cannot answer now."""

    def judge(self, clip: Clip, settings: Settings) -> JudgeResult:
        return verdict_from_transcript(self.transcribe(clip, settings), clip.wake_word)
