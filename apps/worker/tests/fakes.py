"""Test doubles: an in-process fake parent and fake judges.

The fake parent implements `/api/worker/v1` as docs/worker-protocol.md
describes it, with leases, so the job loop can be tested end to end without
the real parent, the network or any model.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from wakewright_worker.audio import Clip, noise, write_wav
from wakewright_worker.judges import JudgeResult, JudgeType, Kind, Settings, TemporaryFailure

TOKEN = "test-token"


@dataclass
class FakeJob:
    id: str
    clip_id: str
    wake_word: str = "alexa"
    # The judge types to run, each as one judge named "<type>-1"; or full
    # judges as {"instance", "type", "settings"}.
    judges: list[str | dict[str, Any]] = field(default_factory=lambda: ["fake"])
    lease_seconds: float = 120.0


@dataclass
class FakeParent:
    """State and behaviour of the fake parent; `serve()` starts it."""

    clips: dict[str, bytes] = field(default_factory=dict[str, bytes])
    queue: list[FakeJob] = field(default_factory=list[FakeJob])
    leases: dict[str, datetime] = field(default_factory=dict[str, datetime])
    claims: list[dict[str, Any]] = field(default_factory=list[dict[str, Any]])
    results: dict[str, list[dict[str, Any]]] = field(
        default_factory=dict[str, list[dict[str, Any]]]
    )
    # Forced answers: the status for the next N claims, results posts, audio.
    claim_status: list[int] = field(default_factory=list[int])
    results_status: list[int] = field(default_factory=list[int])
    audio_status: list[int] = field(default_factory=list[int])
    lock: threading.Lock = field(default_factory=threading.Lock)
    changed: threading.Condition = field(init=False)
    server: ThreadingHTTPServer | None = None

    def __post_init__(self) -> None:
        self.changed = threading.Condition(self.lock)

    def add(self, job: FakeJob, audio: bytes | None = None) -> None:
        with self.lock:
            self.clips.setdefault(
                job.clip_id, audio if audio is not None else write_wav(noise(3.0))
            )
            self.queue.append(job)
            self.changed.notify_all()

    def wait_for(self, predicate: Any, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        with self.lock:
            while not predicate(self):
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self.changed.wait(left)
            return True

    @property
    def url(self) -> str:
        assert self.server is not None
        host, port = self.server.server_address[:2]
        return f"http://{host!s}:{port}"

    def serve(self, port: int = 0) -> FakeParent:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                pass

            def _reply(
                self, status: int, body: Any = None, ctype: str = "application/json"
            ) -> None:
                data = (
                    b""
                    if body is None
                    else body
                    if isinstance(body, bytes)
                    else json.dumps(body).encode()
                )
                self.send_response(status)
                if data:
                    self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _authorised(self) -> bool:
                if self.headers.get("authorization") != f"Bearer {TOKEN}":
                    self._reply(401, {"error": "unauthorised"})
                    return False
                return True

            def _json(self) -> Any:
                n = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(n) or b"null")

            def do_GET(self) -> None:
                if not self._authorised():
                    return None
                prefix, suffix = "/api/worker/v1/clips/", "/audio"
                if not (self.path.startswith(prefix) and self.path.endswith(suffix)):
                    return self._reply(404)
                clip_id = self.path[len(prefix) : -len(suffix)]
                with parent.lock:
                    forced = parent.audio_status.pop(0) if parent.audio_status else None
                    audio = parent.clips.get(clip_id)
                if forced:
                    return self._reply(forced, {"error": "forced"})
                if audio is None:
                    return self._reply(404, {"error": "no such clip"})
                return self._reply(200, audio, "audio/wav")

            def do_POST(self) -> None:
                if not self._authorised():
                    return None
                body = self._json()
                if self.path == "/api/worker/v1/jobs/claim":
                    return self._claim(body)
                prefix, suffix = "/api/worker/v1/jobs/", "/results"
                if self.path.startswith(prefix) and self.path.endswith(suffix):
                    return self._results(self.path[len(prefix) : -len(suffix)], body)
                return self._reply(404)

            def _claim(self, body: dict[str, Any]) -> None:
                with parent.lock:
                    parent.claims.append(body)
                    parent.changed.notify_all()
                    forced = parent.claim_status.pop(0) if parent.claim_status else None
                if forced:
                    detail = {"error": "forced", "supported": {"min": 1, "max": 1}}
                    return self._reply(forced, detail)
                if body.get("protocol") != 2:
                    return self._reply(426, {"supported": {"min": 2, "max": 2}})
                offered = {t["id"] for t in body["types"]}
                deadline = time.monotonic() + min(float(body["waitSeconds"]), 0.3)
                with parent.lock:
                    while True:
                        now = datetime.now(UTC)
                        ready = [
                            j
                            for j in parent.queue
                            if j.id not in parent.results
                            and (j.id not in parent.leases or parent.leases[j.id] <= now)
                            and offered & {_judge(x)["type"] for x in j.judges}
                        ][: int(body["max"])]
                        left = deadline - time.monotonic()
                        if ready or left <= 0:
                            break
                        parent.changed.wait(left)
                    jobs: list[dict[str, Any]] = []
                    for j in ready:
                        expires = now + timedelta(seconds=j.lease_seconds)
                        parent.leases[j.id] = expires
                        jobs.append(
                            {
                                "id": j.id,
                                "clipId": j.clip_id,
                                "wakeWord": j.wake_word,
                                "judges": [
                                    _judge(x) for x in j.judges if _judge(x)["type"] in offered
                                ],
                                "leaseExpiresAt": expires.isoformat().replace("+00:00", "Z"),
                            }
                        )
                self._reply(200, {"jobs": jobs})

            def _results(self, job_id: str, body: dict[str, Any]) -> None:
                with parent.lock:
                    forced = parent.results_status.pop(0) if parent.results_status else None
                    lease = parent.leases.get(job_id)
                    if forced:
                        return self._reply(forced, {"error": "forced"})
                    if lease is None or lease <= datetime.now(UTC):
                        return self._reply(409, {"error": "lease expired"})
                    parent.results[job_id] = body["results"]
                    del parent.leases[job_id]
                    parent.changed.notify_all()
                self._reply(204)

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()
        return self

    def shutdown(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.server = None


def _judge(x: str | dict[str, Any]) -> dict[str, Any]:
    return x if isinstance(x, dict) else {"instance": f"{x}-1", "type": x, "settings": {}}


class FakeJudge(JudgeType):
    """A judge type with no model: answers from a function of the clip."""

    def __init__(
        self,
        name: str = "fake",
        version: str = "1",
        wake_words: frozenset[str] | None = None,
        *,
        answer: JudgeResult | None = None,
        crash: Exception | None = None,
        fail: TemporaryFailure | None = None,
        prepare_failures: int = 0,
    ) -> None:
        self.id = name
        self.name = f"{name} judge"
        self.kind: Kind = "wake_word_model" if wake_words is not None else "speech_to_text"
        self.version = version
        self.wake_words = wake_words
        self.answer = answer or JudgeResult("no", score=0.1, threshold=0.5)
        self.crash = crash
        self.fail = fail
        self.prepare_failures = prepare_failures
        self.prepared = 0
        self.seen: list[tuple[Clip, dict[str, Any]]] = []

    def prepare(self) -> None:
        if self.prepare_failures > 0:
            self.prepare_failures -= 1
            raise RuntimeError("model download failed")
        self.prepared += 1

    def judge(self, clip: Clip, settings: Settings) -> JudgeResult:
        self.seen.append((clip, dict(settings)))
        if self.crash is not None:
            raise self.crash
        if self.fail is not None:
            raise self.fail
        return self.answer
