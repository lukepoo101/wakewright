"""What every listening judge shares: one question, then one answer contract.

A *listening* judge does not transcribe. It gives the clip to a model that
accepts audio and asks it directly whether someone says the wake word, so
a model that hears the wake word but would spell the transcript wrongly
can still say yes. The model must answer with JSON:

    {"said": "<a short note of what it heard>", "heard": "yes" | "no" | "unsure"}

- `heard` yes or no is the verdict; "unsure" is an abstention.
- `said` is kept where a speech-to-text judge keeps its transcript, and
  the UI labels it as the model's note, not a transcript.
- The answer is parsed leniently: a code fence, text around the object or
  `heard` in another case are fine (`parse_answer`).
- An answer that cannot be parsed is an abstention for that clip, with the
  reason. If `UNPARSEABLE_LIMIT` answers in a row from one judge's settings
  cannot be parsed, the model is not following the contract at all (a
  wrong model, or a custom prompt that asks for something else), so the
  next one raises `TemporaryFailure` and pauses the judge instead of
  writing off every clip (`AnswerTracker`).

The built-in prompt (`DEFAULT_PROMPT`) is written to be neutral: models
asked "does this contain X?" tend to agree, so it says the wake word is as
likely to be absent as present, that a similar or partial word is "no",
and that "unsure" is better than a guess. Speech from a TV or speaker still
counts as said. A type's version includes a hash of it, so changing the
built-in prompt judges every clip again with the judges that use it.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from collections.abc import Hashable
from dataclasses import dataclass
from typing import Any, Literal, cast

from wakewright_worker.judges import (
    JudgeResult,
    JudgeType,
    Kind,
    TemporaryFailure,
    normalise_wake_word,
)

PLACEHOLDER = "{wake_word}"

DEFAULT_PROMPT = """\
Listen to this audio clip and decide whether a person in it clearly says \
the wake word "{wake_word}".

- The wake word is as likely to be absent as present. Do not assume it is there.
- Answer "yes" only if you clearly hear the whole wake word "{wake_word}" spoken.
- A similar-sounding word, part of the word, or the word only implied is "no".
- Speech from a TV, radio or speaker counts the same as a person in the room.
- If you truly cannot tell, answer "unsure" rather than guess.

Reply with JSON only, in this form:
{"said": "<a few words on what you heard>", "heard": "yes" or "no" or "unsure"}"""

DEFAULT_PROMPT_HASH = hashlib.sha256(DEFAULT_PROMPT.encode()).hexdigest()[:8]

# The JSON Schema of the answer, for endpoints that take structured output.
# "said" comes first, so a model that writes in order describes what it
# heard before it decides.
ANSWER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "said": {"type": "string", "description": "A few words on what was heard."},
        "heard": {"type": "string", "enum": ["yes", "no", "unsure"]},
    },
    "required": ["said", "heard"],
    "additionalProperties": False,
}

NOTE_MAX = 300
UNPARSEABLE_LIMIT = 3

Heard = Literal["yes", "no", "unsure"]


def spoken(wake_word: str) -> str:
    """The wake word as said: "okay_nabu" -> "Okay Nabu", "alexa" -> "Alexa"."""
    return " ".join(w.capitalize() for w in normalise_wake_word(wake_word).split())


def build_prompt(prompt: str, wake_word: str) -> str:
    """The prompt for one clip: the built-in one when `prompt` is empty, with
    every `{wake_word}` replaced by the wake word as said."""
    return (prompt.strip() or DEFAULT_PROMPT).replace(PLACEHOLDER, spoken(wake_word))


@dataclass(frozen=True)
class Answer:
    heard: Heard
    said: str


class Unparseable(ValueError):
    """The model's answer is not the JSON asked for."""


_FENCE = re.compile(r"```[a-zA-Z]*\s*(.*?)```", re.DOTALL)


def parse_answer(text: str) -> Answer:
    """The answer in `text`: a JSON object with `heard` (yes, no or unsure,
    any case) and optionally `said`, alone, in a code fence or with text
    around it. Raises `Unparseable` otherwise."""
    candidates = [m.group(1) for m in _FENCE.finditer(text)] + [text]
    decoder = json.JSONDecoder()
    for candidate in candidates:
        for start in (i for i, ch in enumerate(candidate) if ch == "{"):
            try:
                value, _ = decoder.raw_decode(candidate, start)
            except ValueError:
                continue
            if isinstance(value, dict) and "heard" in value:
                return _answer(cast(dict[str, object], value))
    raise Unparseable(f'no JSON object with "heard" in the answer: {_snippet(text)}')


def _answer(value: dict[str, object]) -> Answer:
    heard = value.get("heard")
    word = heard.strip().lower() if isinstance(heard, str) else ""
    if word not in ("yes", "no", "unsure"):
        raise Unparseable(f'"heard" is {_snippet(json.dumps(heard))}, not yes, no or unsure')
    said = value.get("said")
    note = " ".join(said.split())[:NOTE_MAX] if isinstance(said, str) else ""
    return Answer(word, note)


def _snippet(text: str) -> str:
    flat = " ".join(text.split())
    return repr(flat[:120] + ("…" if len(flat) > 120 else "")) if flat else "an empty answer"


def to_result(answer: Answer) -> JudgeResult:
    if answer.heard == "unsure":
        return JudgeResult("abstain", transcript=answer.said, detail="the model said it is unsure")
    return JudgeResult(answer.heard, transcript=answer.said)


class AnswerTracker:
    """Counts unparseable answers in a row for each judge's settings, so a
    model that never follows the contract pauses its judge (module docstring)."""

    def __init__(self, limit: int = UNPARSEABLE_LIMIT) -> None:
        self._limit = limit
        self._lock = threading.Lock()
        self._in_a_row: dict[Hashable, int] = {}

    def parsed(self, key: Hashable) -> None:
        with self._lock:
            self._in_a_row.pop(key, None)

    def unparseable(self, key: Hashable, error: Unparseable) -> JudgeResult:
        """An abstention for this clip, or a `TemporaryFailure` once the
        model has failed the contract `limit` times in a row."""
        with self._lock:
            n = self._in_a_row.get(key, 0) + 1
            self._in_a_row[key] = n
        if n > self._limit:
            raise TemporaryFailure(
                f"the model's last {n - 1} answers were not the JSON asked for; check the model "
                f"and the prompt ({error})"
            )
        return JudgeResult("abstain", detail=f"the model's answer could not be read: {error}")


class ListeningJudge(JudgeType):
    """A judge that asks an audio model directly; any wake word."""

    kind: Kind = "listening"
    wake_words: frozenset[str] | None = None
