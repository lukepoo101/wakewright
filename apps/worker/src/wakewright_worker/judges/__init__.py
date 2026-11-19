"""Judge types: the plugin interface every judge implements.

A *judge type* answers "does this clip contain its wake word?". The owner
turns a type into one or more *judges* (instances) on the parent's Judges
page, each with its own settings, weight and daily limit; the parent sends
each job with the instances to run and their settings. A type therefore
holds no per-instance state: `judge(clip, settings)` gets everything it
needs. Writing one is in docs/judges.md.

A type has:

- `id`: stable, `a-z0-9_.-`; the parent stores verdicts under it.
- `name`, `description`: shown on the Judges page.
- `kind`: `"wake_word_model"`, `"speech_to_text"` (transcribe, then look for
  the wake word in the transcript) or `"listening"` (ask an audio model
  directly whether someone says the wake word).
- `version`: changes whenever its model or logic changes in a way that can
  change a verdict, so the parent judges every clip again.
- `settings`: a declarative schema (`Setting`) the parent renders as a form.
- `external`: True when it sends audio to a service outside this worker.
- `wake_words`: the normalised wake words it has a model for, or None.
- `model_files()` and `prepare()`: downloads and loading, done once.
- `judge(clip, settings)`: a `JudgeResult` (yes, no or abstain), or raise
  `TemporaryFailure` when it cannot answer *now* (rate limited, quota used
  up, network, a refused key): the parent retries later with backoff and
  shows the failure on the judge. Any other exception is reported as an
  abstention for this clip, so one bad clip never stops the worker.

The built-in types are registered in `registry.py`.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from wakewright_worker.audio import Clip
from wakewright_worker.models import ModelFile

Verdict = Literal["yes", "no", "abstain"]
Kind = Literal["wake_word_model", "speech_to_text", "listening"]
SettingType = Literal["text", "long_text", "secret", "number", "select", "boolean"]
FailureReason = Literal["auth", "rate_limit", "quota", "network", "server", "other"]
SettingValue = str | float | bool | None
Settings = Mapping[str, SettingValue]

TYPE_ID = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
SETTING_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


@dataclass(frozen=True)
class JudgeResult:
    verdict: Verdict
    score: float | None = None
    threshold: float | None = None
    transcript: str | None = None
    detail: str | None = None


class TemporaryFailure(Exception):
    """The judge cannot answer now, but may later: nothing is recorded for
    the clip, the parent pauses the judge (for `retry_after` seconds, or
    with exponential backoff) and shows `message` on it. Never put a secret
    in the message."""

    def __init__(
        self, message: str, *, reason: FailureReason = "other", retry_after: float | None = None
    ) -> None:
        super().__init__(message)
        self.message = message
        self.reason: FailureReason = reason
        self.retry_after = retry_after


@dataclass(frozen=True)
class Option:
    value: str
    label: str


@dataclass(frozen=True)
class Setting:
    """One field of a type's settings form.

    `affects_verdict` (default: True, but always False for a secret) says
    whether changing the value can change a verdict. Changing such a value
    makes the parent judge every clip again with the judge; changing any
    other (an API key, a timeout) does not.
    """

    key: str
    label: str
    type: SettingType = "text"
    help: str = ""
    default: SettingValue = None
    required: bool = False
    options: tuple[Option, ...] = ()
    minimum: float | None = None
    maximum: float | None = None
    placeholder: str = ""
    affects_verdict: bool = True

    def __post_init__(self) -> None:
        if not SETTING_KEY.match(self.key):
            raise ValueError(f"setting key {self.key!r}: use a-z, digits and _")
        if self.type == "select" and not self.options:
            raise ValueError(f"setting {self.key!r}: a select needs options")

    def to_wire(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "help": self.help,
            "default": None if self.type == "secret" else self.default,
            "required": self.required,
            "options": [{"value": o.value, "label": o.label} for o in self.options],
            "minimum": self.minimum,
            "maximum": self.maximum,
            "placeholder": self.placeholder,
            "affectsVerdict": self.affects_verdict and self.type != "secret",
        }


class JudgeType(ABC):
    """Subclass this, set the class attributes and implement `judge`."""

    id: str
    name: str
    kind: Kind
    version: str
    description: str = ""
    external: bool = False
    settings: tuple[Setting, ...] = ()
    wake_words: frozenset[str] | None = None

    def model_files(self) -> list[ModelFile]:
        """Every file `prepare` will need, for `download-models`."""
        return []

    def prepare(self) -> None:  # noqa: B027 - most types need nothing
        """Load models, downloading them into the cache first if needed."""

    @abstractmethod
    def judge(self, clip: Clip, settings: Settings) -> JudgeResult: ...


def text_setting(settings: Settings, key: str, default: str = "") -> str:
    value = settings.get(key)
    return value.strip() if isinstance(value, str) else default


def number_setting(settings: Settings, key: str, default: float) -> float:
    value = settings.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        return default
    return float(value)


def normalise_wake_word(name: str) -> str:
    """'Hey_Jarvis', 'hey jarvis' and 'Hey Jarvis!' all become 'hey jarvis'."""
    return " ".join(re.sub(r"[^a-z0-9]+", " ", name.lower()).split())


def no_model(judge: str, wake_word: str, known: frozenset[str]) -> JudgeResult:
    return JudgeResult(
        verdict="abstain",
        detail=f"{judge} has no model for the wake word {wake_word!r}; it has "
        + ", ".join(sorted(known)),
    )
