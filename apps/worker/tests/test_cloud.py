"""The cloud speech-to-text types against a local fake HTTP service: the
request they send, the verdict from the transcript, and how each failure
becomes a paused judge or an abstention. Nothing reaches the network and no
real key is used."""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from wakewright_worker.audio import Clip, noise
from wakewright_worker.judges import JudgeType, TemporaryFailure
from wakewright_worker.judges.elevenlabs import ElevenLabsJudge, spoken_text
from wakewright_worker.judges.openai_compatible import OpenAICompatibleJudge

KEY = "sk-test-not-a-real-key-0123456789"
CLIP = Clip("hey_jarvis", noise(3.0))


@dataclass
class Reply:
    status: int = 200
    body: Any = field(default_factory=lambda: {"text": "Hey Jarvis, lights on."})
    headers: dict[str, str] = field(default_factory=dict[str, str])
    delay: float = 0.0


@dataclass
class FakeService:
    replies: list[Reply] = field(default_factory=list[Reply])
    requests: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    server: ThreadingHTTPServer | None = None

    @property
    def url(self) -> str:
        assert self.server is not None
        host, port = self.server.server_address[:2]
        return f"http://{host!s}:{port}"

    def start(self) -> FakeService:
        service = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                pass

            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                service.requests.append(
                    {"path": self.path, "headers": dict(self.headers.items()), "body": body}
                )
                reply = service.replies.pop(0) if service.replies else Reply()
                if reply.delay:
                    threading.Event().wait(reply.delay)
                data = (
                    reply.body.encode()
                    if isinstance(reply.body, str)
                    else json.dumps(reply.body).encode()
                )
                self.send_response(reply.status)
                self.send_header("content-type", "application/json")
                for k, v in reply.headers.items():
                    self.send_header(k, v)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()
        return self

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()


@pytest.fixture
def service() -> Iterator[FakeService]:
    s = FakeService().start()
    yield s
    s.stop()


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


def test_a_clip_the_service_refuses_is_an_abstention(service: FakeService) -> None:
    judge, settings = openai(service)
    service.replies = [Reply(400, {"error": {"message": f"Audio file is too short ({KEY})"}})]
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
