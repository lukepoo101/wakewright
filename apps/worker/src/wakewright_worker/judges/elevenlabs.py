"""Speech to text with ElevenLabs Scribe, through its own API.

`POST https://api.elevenlabs.io/v1/speech-to-text`, multipart, with the key
in the `xi-api-key` header, the clip as `file` and `model_id` (Scribe v3 is
`scribe_v3`). The answer's `text` is the transcript, and its `words` mark
each token as a word, spacing or an audio event.

- `tag_audio_events` is sent as false, so Scribe does not write events such
  as "(laughter)" into the transcript. Any that still come back are left out
  of the wake word match (by their `audio_event` type, and anything in round
  or square brackets), so an event can never match; the transcript shown
  keeps them.
- Keyterm prompting (`keyterms`) is deliberately not offered: biasing
  Scribe towards the wake word would make it hear the wake word in clips
  without it, which is exactly what a judge must not do.

This sends the clip to ElevenLabs, so the type is `external`.
"""

from __future__ import annotations

import re
from typing import Any, cast

import httpx

from wakewright_worker.audio import Clip
from wakewright_worker.judges import (
    JudgeResult,
    Setting,
    Settings,
    TemporaryFailure,
    number_setting,
    text_setting,
)
from wakewright_worker.judges.http import CannotTranscribe, upload
from wakewright_worker.judges.speech import SpeechToTextJudge, contains

API = "https://api.elevenlabs.io/v1/speech-to-text"
# Bump when the request, the parsing or the event stripping changes.
LOGIC = 1
DEFAULT_TIMEOUT = 30.0
_BRACKETED = re.compile(r"\([^)]*\)|\[[^\]]*\]")


def spoken_text(body: dict[str, Any]) -> str:
    """The transcript without audio events: from `words` when present (every
    token but `audio_event`s), else `text`; bracketed spans removed either way."""
    words = body.get("words")
    if isinstance(words, list) and words:
        parts = [
            str(w.get("text") or "")
            for w in cast(list[dict[str, Any]], words)
            if isinstance(w, dict) and w.get("type") != "audio_event"  # pyright: ignore[reportUnnecessaryIsInstance]
        ]
        text = "".join(parts)
    else:
        text = str(body.get("text") or "")
    return " ".join(_BRACKETED.sub(" ", text).split())


class ElevenLabsJudge(SpeechToTextJudge):
    id = "elevenlabs"
    name = "ElevenLabs Scribe"
    description = (
        "Sends each clip to ElevenLabs' speech-to-text API (Scribe). Check your plan's data "
        "settings: ElevenLabs may use audio from some plans to train its models."
    )
    version = f"elevenlabs+{LOGIC}"
    external = True
    settings = (
        Setting(
            "api_key",
            "API key",
            type="secret",
            required=True,
            help="An ElevenLabs API key with speech-to-text access, sent as xi-api-key.",
        ),
        Setting(
            "model",
            "Model",
            default="scribe_v3",
            required=True,
            help="The model_id, such as scribe_v3 (Scribe v3) or scribe_v2.",
        ),
        Setting(
            "language",
            "Language",
            help="Optional ISO 639-1 or 639-3 code, such as en. Leave empty to let Scribe decide.",
            placeholder="en",
        ),
        Setting(
            "timeout",
            "Timeout (seconds)",
            type="number",
            default=DEFAULT_TIMEOUT,
            minimum=1,
            maximum=120,
            help="How long to wait for an answer before trying the clip again later.",
            affects_verdict=False,
        ),
    )

    def __init__(self, *, url: str = API, transport: httpx.BaseTransport | None = None) -> None:
        self._url = url
        self._transport = transport

    def judge(self, clip: Clip, settings: Settings) -> JudgeResult:
        try:
            body = self._request(clip, settings)
        except CannotTranscribe as e:
            return JudgeResult("abstain", detail=e.detail)
        raw = str(body.get("text") or "").strip()
        heard = contains(spoken_text(body), clip.wake_word)
        return JudgeResult("yes" if heard else "no", transcript=raw)

    def transcribe(self, clip: Clip, settings: Settings) -> str:
        return spoken_text(self._request(clip, settings))

    def _request(self, clip: Clip, settings: Settings) -> dict[str, Any]:
        key = text_setting(settings, "api_key")
        if not key:
            raise TemporaryFailure("no API key: add one on the Judges page", reason="auth")
        data = {
            "model_id": text_setting(settings, "model") or "scribe_v3",
            "tag_audio_events": "false",
        }
        language = text_setting(settings, "language")
        if language:
            data["language_code"] = language
        body = upload(
            self._url,
            clip,
            key=key,
            headers={"xi-api-key": key},
            data=data,
            timeout=number_setting(settings, "timeout", DEFAULT_TIMEOUT),
            transport=self._transport,
        )
        if not isinstance(body.get("text"), str):
            raise TemporaryFailure("the service's answer has no transcript", reason="server")
        return body
