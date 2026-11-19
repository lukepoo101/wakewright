"""The listening type against a local fake chat completions service: the
request it sends, the answer contract (yes, no, unsure, a fenced or wrapped
answer, garbage), structured output being refused, and how failures become
a paused judge or an abstention. Nothing reaches the network and no real
key is used."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

import pytest
from fakes import FakeService, Reply
from test_cloud import KEY

from wakewright_worker.audio import Clip, noise, read_wav
from wakewright_worker.judges import TemporaryFailure
from wakewright_worker.judges.audio_question import AudioQuestionJudge
from wakewright_worker.judges.listening import (
    DEFAULT_PROMPT,
    UNPARSEABLE_LIMIT,
    Unparseable,
    build_prompt,
    parse_answer,
    spoken,
)

CLIP = Clip("okay_nabu", noise(3.0))


def chat(content: Any) -> Reply:
    return Reply(body={"choices": [{"message": {"role": "assistant", "content": content}}]})


def answer(heard: str, said: str = "someone talking") -> Reply:
    return chat(json.dumps({"said": said, "heard": heard}))


def make(service: FakeService, **extra: Any) -> tuple[AudioQuestionJudge, dict[str, Any]]:
    settings = {
        "base_url": f"{service.url}/v1",
        "api_key": KEY,
        "model": "gemini/test-model",
        "prompt": "",
        "reasoning_effort": "model_default",
    } | extra
    return AudioQuestionJudge(), settings


def sent(service: FakeService, i: int = 0) -> dict[str, Any]:
    return json.loads(service.requests[i]["body"])


def test_the_request_and_a_yes(service: FakeService) -> None:
    judge, settings = make(service)
    service.replies = [answer("yes", "someone says okay nabu")]
    result = judge.judge(CLIP, settings)
    assert result.verdict == "yes"
    assert result.transcript == "someone says okay nabu"
    [req] = service.requests
    assert req["path"] == "/v1/chat/completions"
    assert req["headers"]["authorization"] == f"Bearer {KEY}"
    body = sent(service)
    assert body["model"] == "gemini/test-model"
    assert "temperature" not in body
    assert "reasoning_effort" not in body
    [message] = body["messages"]
    assert message["role"] == "user"
    audio, text = message["content"]
    assert audio["type"] == "input_audio"
    assert audio["input_audio"]["format"] == "wav"
    assert (read_wav(base64.b64decode(audio["input_audio"]["data"])) == CLIP.samples).all()
    assert text == {"type": "text", "text": build_prompt("", "okay_nabu")}
    assert '"Okay Nabu"' in text["text"]
    schema = body["response_format"]
    assert schema["type"] == "json_schema"
    assert schema["json_schema"]["schema"]["properties"]["heard"]["enum"] == [
        "yes",
        "no",
        "unsure",
    ]


def test_no_unsure_and_the_reasoning_effort(service: FakeService) -> None:
    judge, settings = make(service, reasoning_effort="low", prompt="Is it {wake_word}? JSON.")
    service.replies = [answer("no", "a similar word"), answer("unsure", "too quiet")]
    no = judge.judge(CLIP, settings)
    assert (no.verdict, no.transcript) == ("no", "a similar word")
    assert sent(service)["reasoning_effort"] == "low"
    assert sent(service)["messages"][0]["content"][1]["text"] == "Is it Okay Nabu? JSON."
    unsure = judge.judge(CLIP, settings)
    assert unsure.verdict == "abstain"
    assert unsure.transcript == "too quiet"
    assert unsure.detail is not None
    assert "unsure" in unsure.detail


def test_needs_no_key_for_a_server_without_one(service: FakeService) -> None:
    judge, settings = make(service, api_key="")
    service.replies = [answer("yes")]
    assert judge.judge(CLIP, settings).verdict == "yes"
    assert "authorization" not in service.requests[0]["headers"]


@pytest.mark.parametrize(
    ("text", "heard", "said"),
    [
        ('{"heard": "yes", "said": "Alexa, lights"}', "yes", "Alexa, lights"),
        ('```json\n{"said": "nothing clear", "heard": "No"}\n```', "no", "nothing clear"),
        (
            'Here you go: {"heard": " UNSURE ", "said": "mumbling"} Hope that helps.',
            "unsure",
            "mumbling",
        ),
        ('{"heard": "yes"}', "yes", ""),
        ('{"note": {"x": 1}} then {"heard": "no", "said": "music"}', "no", "music"),
    ],
)
def test_lenient_parsing(text: str, heard: str, said: str) -> None:
    a = parse_answer(text)
    assert (a.heard, a.said) == (heard, said)


@pytest.mark.parametrize(
    "text", ["", "Yes, I hear it.", '{"heard": "maybe"}', '{"heard": true}', "```\nnot json\n```"]
)
def test_garbage_is_unparseable(text: str) -> None:
    with pytest.raises(Unparseable):
        parse_answer(text)


def test_a_fenced_answer_from_the_service_and_text_parts(service: FakeService) -> None:
    judge, settings = make(service)
    service.replies = [
        chat('```json\n{"said": "okay nabu", "heard": "yes"}\n```'),
        chat([{"type": "text", "text": '{"said": "a TV", "heard": "no"}'}]),
    ]
    assert judge.judge(CLIP, settings).verdict == "yes"
    assert judge.judge(CLIP, settings).verdict == "no"


def test_garbage_abstains_then_pauses_when_it_never_parses(service: FakeService) -> None:
    judge, settings = make(service)
    service.replies = [chat("I think so!") for _ in range(UNPARSEABLE_LIMIT)]
    for _ in range(UNPARSEABLE_LIMIT):
        r = judge.judge(CLIP, settings)
        assert r.verdict == "abstain"
        assert r.detail is not None
        assert "could not be read" in r.detail
        assert "I think so!" in r.detail
    service.replies = [chat("still not JSON")]
    with pytest.raises(TemporaryFailure, match="not the JSON asked for") as caught:
        judge.judge(CLIP, settings)
    assert caught.value.reason == "other"
    # One good answer resets the count.
    service.replies = [answer("yes"), chat("nope")]
    assert judge.judge(CLIP, settings).verdict == "yes"
    assert judge.judge(CLIP, settings).verdict == "abstain"


def test_an_endpoint_without_structured_output_is_asked_without_it(service: FakeService) -> None:
    judge, settings = make(service)
    refused = Reply(400, {"error": {"message": "response_format json_schema is not supported"}})
    service.replies = [refused, answer("yes"), answer("no")]
    assert judge.judge(CLIP, settings).verdict == "yes"
    assert "response_format" in sent(service, 0)
    assert "response_format" not in sent(service, 1)
    # Remembered for that endpoint and model.
    assert judge.judge(CLIP, settings).verdict == "no"
    assert "response_format" not in sent(service, 2)
    assert len(service.requests) == 3


@pytest.mark.parametrize(
    ("reply", "reason", "words"),
    [
        (
            Reply(402, {"error": {"message": "litellm.PaymentRequiredError: credits depleted"}}),
            "quota",
            "quota used up (HTTP 402)",
        ),
        (
            Reply(404, {"error": {"message": "The model `gemini/nope` does not exist"}}),
            "other",
            "check the address and the model",
        ),
        (Reply(401, {"error": {"message": f"bad key {KEY}"}}), "auth", "invalid API key"),
        (Reply(429, {"error": "slow down"}, {"retry-after": "3"}), "rate_limit", "rate limited"),
        (
            Reply(400, {"error": {"message": "Invalid `reasoning_effort`: 'minimal'."}}),
            "other",
            "refused a setting",
        ),
        (
            Reply(400, {"error": {"message": "This model does not support audio input"}}),
            "other",
            "refused a setting",
        ),
        (Reply(503, {"error": "overloaded"}), "server", "HTTP 503"),
        (Reply(200, "not json"), "server", "not a JSON object"),
        (Reply(200, {"choices": []}), "server", "no choices"),
    ],
)
def test_failures_pause_the_judge(
    service: FakeService, reply: Reply, reason: str, words: str
) -> None:
    judge, settings = make(service)
    service.replies = [reply]
    with pytest.raises(TemporaryFailure) as caught:
        judge.judge(CLIP, settings)
    assert caught.value.reason == reason
    assert words in caught.value.message
    assert KEY not in caught.value.message


def test_a_clip_the_service_refuses_is_an_abstention(service: FakeService) -> None:
    judge, settings = make(service)
    service.replies = [Reply(400, {"error": {"message": "Audio is too short"}})]
    result = judge.judge(CLIP, settings)
    assert result.verdict == "abstain"
    assert result.detail is not None
    assert "too short" in result.detail


def test_the_default_prompt_is_neutral_and_in_the_version() -> None:
    assert spoken("okay_nabu") == "Okay Nabu"
    assert spoken("alexa") == "Alexa"
    prompt = build_prompt("", "alexa")
    assert "{wake_word}" not in prompt
    assert '"Alexa"' in prompt
    for idea in ("as likely to be absent as present", "similar-sounding", "TV", '"unsure"'):
        assert idea in DEFAULT_PROMPT
    # Changing the built-in prompt changes the version (test_judges.py pins it).
    assert AudioQuestionJudge.version.endswith(
        hashlib.sha256(DEFAULT_PROMPT.encode()).hexdigest()[:8]
    )
