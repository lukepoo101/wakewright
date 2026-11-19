"""The cloud speech-to-text types against a local fake HTTP service: the
request they send, the verdict from the transcript, and how each failure
becomes a paused judge or an abstention. Nothing reaches the network and no
real key is used."""

from __future__ import annotations

import logging
from typing import Any

import pytest
from fakes import FakeService, Reply

from wakewright_worker.audio import Clip, noise
from wakewright_worker.judges import JudgeType, TemporaryFailure
from wakewright_worker.judges.elevenlabs import ElevenLabsJudge, spoken_text
from wakewright_worker.judges.openai_compatible import OpenAICompatibleJudge

KEY = "sk-test-not-a-real-key-0123456789"
CLIP = Clip("hey_jarvis", noise(3.0))


def openai(service: FakeService, **extra: Any) -> tuple[JudgeType, dict[str, Any]]:
    settings = {"base_url": f"{service.url}/v1", "api_key": KEY, "model": "whisper-1"} | extra
    return OpenAICompatibleJudge(), settings


def eleven(service: FakeService, **extra: Any) -> tuple[JudgeType, dict[str, Any]]:
    settings = {"api_key": KEY, "model": "scribe_v3"} | extra
    return ElevenLabsJudge(url=f"{service.url}/v1/speech-to-text"), settings


def form(request: dict[str, Any]) -> dict[str, str]:
    """The multipart fields of a request, except the file."""
    out: dict[str, str] = {}
    for part in request["body"].split(b"--")[1:]:
        head, _, value = part.partition(b"\r\n\r\n")
        name = head.split(b'name="')[1].split(b'"')[0].decode() if b'name="' in head else ""
        if name and b"filename=" not in head:
            out[name] = value.rstrip(b"\r\n").decode()
    return out


def test_openai_compatible_request_and_verdict(service: FakeService) -> None:
    judge, settings = openai(service, language="en", prompt="")
    result = judge.judge(CLIP, settings)
    assert result.verdict == "yes"
    assert result.transcript == "Hey Jarvis, lights on."
    [req] = service.requests
    assert req["path"] == "/v1/audio/transcriptions"
    assert req["headers"]["authorization"] == f"Bearer {KEY}"
    assert form(req) == {"model": "whisper-1", "response_format": "json", "language": "en"}
    assert b'filename="clip.wav"' in req["body"]
    assert b"RIFF" in req["body"]

    service.replies = [Reply(body={"text": "a lexicon"})]
    assert judge.judge(CLIP, settings).verdict == "no"


def test_openai_compatible_needs_no_key_for_a_server_without_one(service: FakeService) -> None:
    judge, settings = openai(service, api_key="")
    assert judge.judge(CLIP, settings).verdict == "yes"
    assert "authorization" not in service.requests[0]["headers"]


@pytest.mark.parametrize(
    ("reply", "reason", "retry_after", "words"),
    [
        (
            Reply(401, {"error": {"message": f"Incorrect API key provided: {KEY[:8]}***"}}),
            "auth",
            None,
            "invalid API key",
        ),
        (
            Reply(429, {"error": {"message": "Rate limit reached"}}, {"retry-after": "7"}),
            "rate_limit",
            7.0,
            "rate limited",
        ),
        (
            Reply(429, {"error": {"message": "You exceeded your current quota"}}),
            "quota",
            None,
            "quota used up",
        ),
        (Reply(503, {"error": "overloaded"}), "server", None, "HTTP 503"),
        (
            # A proxy passing on a provider's "no credit left", as LiteLLM does.
            Reply(
                402,
                {
                    "error": {
                        "message": "litellm.PaymentRequiredError: UpstreamException - "
                        '[{ "error": { "code": 402, "message": "Your prepayment credits are '
                        'depleted. Manage your project and billing.", "status": '
                        '"RESOURCE_EXHAUSTED" } }]',
                        "code": "402",
                    }
                },
            ),
            "quota",
            None,
            "quota used up (HTTP 402)",
        ),
        (Reply(402, {"error": "Payment Required"}), "quota", None, "quota used up"),
        (Reply(402, ""), "quota", None, "quota used up"),
        (
            Reply(
                400, {"error": {"message": "Account out of funds", "code": "insufficient_quota"}}
            ),
            "quota",
            None,
            "quota used up (HTTP 400)",
        ),
        (
            Reply(403, {"error": {"message": "Billing is not enabled for this project"}}),
            "quota",
            None,
            "quota used up (HTTP 403)",
        ),
        (
            Reply(400, {"error": {"status": "RESOURCE_EXHAUSTED"}}),
            "quota",
            None,
            "quota used up",
        ),
        (Reply(408, {"error": "request timeout"}), "network", None, "in time (HTTP 408)"),
        (Reply(425, {"error": "too early"}), "network", None, "in time (HTTP 425)"),
        (Reply(409, {"error": "conflict"}), "other", None, "refused the request (HTTP 409)"),
        (Reply(410, {"error": "gone"}), "other", None, "refused the request (HTTP 410)"),
        (Reply(415, {"error": "unsupported"}), "other", None, "refused the request (HTTP 415)"),
        (
            Reply(404, {"error": {"message": "The model `whisper-9` does not exist"}}),
            "other",
            None,
            "check the address and the model",
        ),
        (
            Reply(400, {"error": {"message": "Invalid language 'xx'"}}),
            "other",
            None,
            "refused a setting",
        ),
        (Reply(200, "not json"), "server", None, "not a JSON object"),
        (Reply(200, {"nope": 1}), "server", None, "no transcript"),
    ],
)
def test_openai_compatible_failures_pause_the_judge(
    service: FakeService, reply: Reply, reason: str, retry_after: float | None, words: str
) -> None:
    judge, settings = openai(service)
    service.replies = [reply]
    with pytest.raises(TemporaryFailure) as caught:
        judge.judge(CLIP, settings)
    assert caught.value.reason == reason
    assert caught.value.retry_after == retry_after
    assert words in caught.value.message
    assert KEY not in caught.value.message
    assert KEY[:8] not in caught.value.message


@pytest.mark.parametrize("status", [400, 413, 422])
@pytest.mark.parametrize("make", [openai, eleven])
def test_a_clip_the_service_refuses_is_an_abstention(
    service: FakeService, make: Any, status: int
) -> None:
    judge, settings = make(service)
    service.replies = [Reply(status, {"error": {"message": f"Audio file is too short ({KEY})"}})]
    result = judge.judge(CLIP, settings)
    assert result.verdict == "abstain"
    assert result.detail is not None
    assert "too short" in result.detail
    assert KEY not in result.detail


def test_network_failures_and_timeouts_pause_the_judge(service: FakeService) -> None:
    judge, settings = openai(service, timeout=0.2)
    service.replies = [Reply(delay=1.0)]
    with pytest.raises(TemporaryFailure, match=r"no answer within 0.2 s") as caught:
        judge.judge(CLIP, settings)
    assert caught.value.reason == "network"
    port = service.url.rsplit(":", 1)[1]
    service.stop()
    with pytest.raises(TemporaryFailure, match="cannot reach") as gone:
        judge.judge(CLIP, settings | {"base_url": f"http://127.0.0.1:{port}/v1"})
    assert gone.value.reason == "network"
    with pytest.raises(TemporaryFailure, match="must start with http"):
        judge.judge(CLIP, settings | {"base_url": "ftp://x"})


def test_elevenlabs_request_and_verdict(service: FakeService) -> None:
    judge, settings = eleven(service, language="en")
    result = judge.judge(CLIP, settings)
    assert result.verdict == "yes"
    [req] = service.requests
    assert req["path"] == "/v1/speech-to-text"
    assert req["headers"]["xi-api-key"] == KEY
    assert "authorization" not in req["headers"]
    # Events are not tagged, and no keyterm biases it towards the wake word.
    assert form(req) == {
        "model_id": "scribe_v3",
        "tag_audio_events": "false",
        "language_code": "en",
    }


def test_elevenlabs_audio_events_never_match_and_stay_in_the_transcript(
    service: FakeService,
) -> None:
    judge, settings = eleven(service)
    body = {
        "text": "(hey jarvis) [music] Hello there.",
        "words": [
            {"text": "(hey jarvis)", "type": "audio_event"},
            {"text": " ", "type": "spacing"},
            {"text": "[music]", "type": "audio_event"},
            {"text": " ", "type": "spacing"},
            {"text": "Hello", "type": "word"},
            {"text": " ", "type": "spacing"},
            {"text": "there.", "type": "word"},
        ],
    }
    service.replies = [Reply(body=body)]
    result = judge.judge(CLIP, settings)
    assert result.verdict == "no"
    assert result.transcript == "(hey jarvis) [music] Hello there."
    assert spoken_text(body) == "Hello there."
    # Without words, bracketed spans are removed from the text.
    assert spoken_text({"text": "[laughter] Hey Jarvis (applause)"}) == "Hey Jarvis"
    assert spoken_text({"text": "(hey jarvis)"}) == ""


@pytest.mark.parametrize(
    ("reply", "reason"),
    [
        (
            Reply(401, {"detail": {"status": "invalid_api_key", "message": "Invalid API key"}}),
            "auth",
        ),
        (
            Reply(401, {"detail": {"status": "quota_exceeded", "message": "You have 0 credits"}}),
            "quota",
        ),
        (Reply(429, {"detail": {"status": "too_many_concurrent_requests"}}), "rate_limit"),
        (
            # The status alone names it; the message has no quota wording.
            Reply(400, {"detail": {"status": "quota_exceeded", "message": "Request refused"}}),
            "quota",
        ),
        (Reply(402, {"detail": {"message": "Payment required"}}), "quota"),
        (
            Reply(422, {"detail": [{"loc": ["body", "model_id"], "msg": "invalid model_id"}]}),
            "other",
        ),
    ],
)
def test_elevenlabs_failures(service: FakeService, reply: Reply, reason: str) -> None:
    judge, settings = eleven(service)
    service.replies = [reply]
    with pytest.raises(TemporaryFailure) as caught:
        judge.judge(CLIP, settings)
    assert caught.value.reason == reason
    assert KEY not in caught.value.message


def test_elevenlabs_without_a_key_sends_nothing(service: FakeService) -> None:
    judge, settings = eleven(service, api_key="")
    with pytest.raises(TemporaryFailure, match="no API key") as caught:
        judge.judge(CLIP, settings)
    assert caught.value.reason == "auth"
    assert service.requests == []


def test_no_key_in_logs(service: FakeService, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.DEBUG):
        for make in (openai, eleven):
            judge, settings = make(service)
            service.replies = [Reply(401, {"error": f"bad key {KEY}"})]
            with pytest.raises(TemporaryFailure):
                judge.judge(CLIP, settings)
    assert KEY not in caplog.text
