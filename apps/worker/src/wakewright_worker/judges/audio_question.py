"""A listening judge through any OpenAI-compatible chat completions API.

`POST {base_url}/chat/completions` with one user message: the clip as an
`input_audio` content part (base64 WAV, `"format": "wav"`) and the prompt
as a text part. OpenAI's audio models take this shape, and a LiteLLM proxy
turns it into inline audio for Gemini and other providers. The answer
contract and the built-in prompt are in listening.py.

- Structured output: the request asks for the answer's JSON Schema with
  `response_format` (`json_schema`). An endpoint that refuses it (a 400 or
  422 that names `response_format`, a JSON schema or structured output) is
  asked again once without it, and that endpoint and model are then always
  asked without it; the answer is parsed leniently either way.
- `reasoning_effort` is sent only when the judge sets it. A service that
  refuses the value answers a 400 that names it, which pauses the judge
  ("refused a setting") rather than writing off clips.
- No temperature is sent: each model's default is used.

This sends the clip to whatever `base_url` names, so the type is marked
`external`. Other errors are handled as for every cloud type (http.py);
the API key never appears in a message.
"""

from __future__ import annotations

import base64
import re
import threading
from typing import Any, cast

import httpx

from wakewright_worker.audio import Clip, write_wav
from wakewright_worker.judges import (
    JudgeResult,
    Option,
    Setting,
    Settings,
    TemporaryFailure,
    number_setting,
    text_setting,
)
from wakewright_worker.judges.http import CannotTranscribe, fail, json_object, message, post_json
from wakewright_worker.judges.listening import (
    ANSWER_SCHEMA,
    DEFAULT_PROMPT,
    DEFAULT_PROMPT_HASH,
    PLACEHOLDER,
    AnswerTracker,
    ListeningJudge,
    Unparseable,
    build_prompt,
    parse_answer,
    to_result,
)

# Bump when the request or the parsing changes in a way that can change an
# answer. The built-in prompt's hash is part of the version too.
LOGIC = 1
DEFAULT_TIMEOUT = 60.0
MODEL_DEFAULT = "model_default"
EFFORTS = ("none", "minimal", "low", "medium", "high")

# A refused request that names one of these is about a setting (pause).
_SETTING_WORDS = re.compile(
    r"\bmodel|reasoning|response_format|json_schema|response.?schema|modalit", re.IGNORECASE
)
# A refused request that names one of these is about structured output.
_STRUCTURED_WORDS = re.compile(
    r"response_format|json_schema|response.?schema|structured output", re.IGNORECASE
)


class AudioQuestionJudge(ListeningJudge):
    id = "audio-question"
    name = "Audio question (OpenAI-compatible chat)"
    description = (
        "Sends each clip to a model that accepts audio, through an OpenAI-compatible "
        "/chat/completions endpoint (OpenAI's audio models, or Gemini and others behind a "
        "LiteLLM proxy), and asks it whether someone says the wake word."
    )
    version = f"audio-question+{LOGIC}.{DEFAULT_PROMPT_HASH}"
    external = True
    settings = (
        Setting(
            "base_url",
            "API base URL",
            help="The address up to /v1, without /chat/completions. For example "
            "https://api.openai.com/v1 or your LiteLLM proxy.",
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
            help="A model that accepts audio input, by the service's name for it, for example "
            "gpt-4o-audio-preview or, through LiteLLM, gemini/gemini-2.5-flash.",
            required=True,
            placeholder="gpt-4o-audio-preview",
        ),
        Setting(
            "prompt",
            "Prompt",
            type="long_text",
            help=f"Leave empty to use the built-in prompt, shown here. {PLACEHOLDER} is replaced "
            'with the wake word as said ("Alexa", "Okay Nabu"). A custom prompt must still ask '
            'for JSON with "heard" (yes, no or unsure) and "said". Asking leading questions '
            "makes a model hear the wake word that is not there.",
            placeholder=DEFAULT_PROMPT,
        ),
        Setting(
            "reasoning_effort",
            "Reasoning effort",
            type="select",
            default=MODEL_DEFAULT,
            required=True,
            options=(
                Option(MODEL_DEFAULT, "Leave to the model"),
                *(Option(e, e.capitalize()) for e in EFFORTS),
            ),
            help="Sent as reasoning_effort, for models that think before answering. A model "
            "that does not take the value pauses the judge with the service's message.",
        ),
        Setting(
            "timeout",
            "Timeout (seconds)",
            type="number",
            default=DEFAULT_TIMEOUT,
            minimum=1,
            maximum=300,
            help="How long to wait for an answer before trying the clip again later.",
            affects_verdict=False,
        ),
    )

    def __init__(self, *, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport
        self._tracker = AnswerTracker()
        self._lock = threading.Lock()
        # (base URL, model) that refused structured output.
        self._plain: set[tuple[str, str]] = set()

    def judge(self, clip: Clip, settings: Settings) -> JudgeResult:
        base = text_setting(settings, "base_url").rstrip("/")
        if not base.startswith(("http://", "https://")):
            raise TemporaryFailure("the API base URL must start with http:// or https://")
        key = text_setting(settings, "api_key")
        model = text_setting(settings, "model")
        prompt = text_setting(settings, "prompt")
        effort = text_setting(settings, "reasoning_effort", MODEL_DEFAULT)
        body: dict[str, Any] = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": base64.b64encode(write_wav(clip.samples)).decode(),
                                "format": "wav",
                            },
                        },
                        {"type": "text", "text": build_prompt(prompt, clip.wake_word)},
                    ],
                }
            ],
        }
        if effort and effort != MODEL_DEFAULT:
            body["reasoning_effort"] = effort
        endpoint = (base, model)
        with self._lock:
            structured = endpoint not in self._plain
        if structured:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "wake_word_answer",
                    "strict": True,
                    "schema": ANSWER_SCHEMA,
                },
            }
        r = self._post(f"{base}/chat/completions", body, key, settings)
        if structured and r.status_code in (400, 422) and _STRUCTURED_WORDS.search(message(r, key)):
            with self._lock:
                self._plain.add(endpoint)
            del body["response_format"]
            r = self._post(f"{base}/chat/completions", body, key, settings)
        if r.status_code >= 300:
            try:
                fail(r, key, setting_words=_SETTING_WORDS)
            except CannotTranscribe as e:
                return JudgeResult("abstain", detail=e.detail)
        text = answer_text(json_object(r))
        tracked = (base, model, prompt, effort)
        try:
            answer = parse_answer(text)
        except Unparseable as e:
            return self._tracker.unparseable(tracked, e)
        self._tracker.parsed(tracked)
        return to_result(answer)

    def _post(self, url: str, body: dict[str, Any], key: str, settings: Settings) -> httpx.Response:
        return post_json(
            url,
            body,
            headers={"authorization": f"Bearer {key}"} if key else {},
            timeout=number_setting(settings, "timeout", DEFAULT_TIMEOUT),
            transport=self._transport,
        )


def answer_text(body: dict[str, Any]) -> str:
    """The first choice's message text (a string, or a list of text parts)."""
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices:
        raise TemporaryFailure("the service's answer has no choices", reason="server")
    first = cast(list[object], choices)[0]
    msg = cast(dict[str, Any], first).get("message") if isinstance(first, dict) else None
    content = cast(dict[str, Any], msg).get("content") if isinstance(msg, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(cast(dict[str, Any], p).get("text") or "")
            for p in cast(list[object], content)
            if isinstance(p, dict)
        )
    return ""
