"""Speech to text through any OpenAI-compatible transcription API.

`POST {base_url}/audio/transcriptions` with the clip as a multipart WAV
upload and `model`, as OpenAI, Groq, a LiteLLM proxy and self-hosted
Whisper servers (faster-whisper-server, speaches, LocalAI and others)
accept it. The answer's `text` is the transcript; the verdict comes from
it as for every speech-to-text type (speech.py).

This sends the clip to whatever `base_url` names, so the type is marked
`external`: the parent warns before such a judge is turned on.

Errors become a paused judge or an abstention as for every cloud type
(http.py); the API key never appears in a message.
"""

from __future__ import annotations

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
from wakewright_worker.judges.speech import SpeechToTextJudge, verdict_from_transcript

# Bump when the request or the parsing below changes in a way that can
# change a transcript.
LOGIC = 1
DEFAULT_TIMEOUT = 30.0


class OpenAICompatibleJudge(SpeechToTextJudge):
    id = "openai-compatible"
    name = "OpenAI-compatible transcription"
    description = (
        "Sends each clip to a speech-to-text service with an OpenAI-compatible "
        "/audio/transcriptions endpoint: OpenAI, Groq, a LiteLLM proxy, or a Whisper server "
        "you run yourself."
    )
    version = f"openai-compatible+{LOGIC}"
    external = True
    settings = (
        Setting(
            "base_url",
            "API base URL",
            help="The address up to /v1, without /audio/transcriptions. For example "
            "https://api.openai.com/v1, https://api.groq.com/openai/v1, or your own server.",
            required=True,
            placeholder="https://api.openai.com/v1",
        ),
        Setting(
            "api_key",
            "API key",
            type="secret",
            help="Sent as a bearer token. Leave empty for a server that needs none.",
        ),
        Setting(
            "model",
            "Model",
            help="The service's model name, for example whisper-1, gpt-4o-mini-transcribe or "
            "whisper-large-v3-turbo.",
            required=True,
            placeholder="whisper-1",
        ),
        Setting(
            "language",
            "Language",
            help="Optional ISO 639-1 code, such as en. Leave empty to let the model decide.",
            placeholder="en",
        ),
        Setting(
            "prompt",
            "Prompt",
            help="Optional text to steer the model, such as the wake word's spelling. It can "
            "make the model hear the wake word that is not there, so use it with care.",
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

    def __init__(self, *, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport

    def judge(self, clip: Clip, settings: Settings) -> JudgeResult:
        try:
            return verdict_from_transcript(self.transcribe(clip, settings), clip.wake_word)
        except CannotTranscribe as e:
            return JudgeResult("abstain", detail=e.detail)

    def transcribe(self, clip: Clip, settings: Settings) -> str:
        base = text_setting(settings, "base_url").rstrip("/")
        if not base.startswith(("http://", "https://")):
            raise TemporaryFailure("the API base URL must start with http:// or https://")
        key = text_setting(settings, "api_key")
        data = {"model": text_setting(settings, "model"), "response_format": "json"}
        for optional in ("language", "prompt"):
            value = text_setting(settings, optional)
            if value:
                data[optional] = value
        body = upload(
            f"{base}/audio/transcriptions",
            clip,
            key=key,
            headers={"authorization": f"Bearer {key}"} if key else {},
            data=data,
            timeout=number_setting(settings, "timeout", DEFAULT_TIMEOUT),
            transport=self._transport,
        )
        text = body.get("text")
        if not isinstance(text, str):
            raise TemporaryFailure("the service's answer has no transcript", reason="server")
        return text
