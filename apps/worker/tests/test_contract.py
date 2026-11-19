"""The worker's requests and the fake parent's answers, checked against the
parent's committed OpenAPI document, docs/api/worker-v1.openapi.json (the
wire format's source of truth). When the parent changes the protocol and
regenerates that file, these tests say what the worker must change."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fakes import TOKEN, FakeJob, FakeParent
from jsonschema import Draft202012Validator

from wakewright_worker.client import API, Failure, ParentClient, Result
from wakewright_worker.judges import JudgeResult
from wakewright_worker.judges.fake import fake_judges
from wakewright_worker.judges.openai_compatible import OpenAICompatibleJudge
from wakewright_worker.loop import offer

DOCUMENT = Path(__file__).resolve().parents[3] / "docs" / "api" / "worker-v1.openapi.json"
SPEC: dict[str, Any] = json.loads(DOCUMENT.read_text(encoding="utf-8"))


def validator(schema: dict[str, Any]) -> Draft202012Validator:
    return Draft202012Validator(schema | {"components": SPEC["components"]})


def request_schema(path: str, method: str) -> dict[str, Any]:
    op = SPEC["paths"][API + path][method]
    return op["requestBody"]["content"]["application/json"]["schema"]


def response_schema(path: str, method: str, status: str) -> dict[str, Any]:
    return SPEC["paths"][API + path][method]["responses"][status]["content"]["application/json"][
        "schema"
    ]


class Recorder(httpx.BaseTransport):
    """Forwards to the fake parent and keeps every request."""

    def __init__(self) -> None:
        self.inner = httpx.HTTPTransport()
        self.requests: list[httpx.Request] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        request.read()
        self.requests.append(request)
        return self.inner.handle_request(request)


@pytest.fixture
def parent() -> Iterator[FakeParent]:
    p = FakeParent().serve()
    yield p
    p.shutdown()


def test_the_paths_the_worker_uses_exist() -> None:
    assert SPEC["openapi"].startswith("3.1")
    assert "post" in SPEC["paths"][f"{API}/jobs/claim"]
    assert "get" in SPEC["paths"][f"{API}/clips/{{clipId}}/audio"]
    assert "post" in SPEC["paths"][f"{API}/jobs/{{id}}/results"]
    # The statuses the client turns into its errors are all documented. (It
    # also handles 404, which a parent before 0.2.0 sent with no token set.)
    claim = SPEC["paths"][f"{API}/jobs/claim"]["post"]["responses"]
    assert {"200", "401", "426"} <= set(claim)
    assert "409" in SPEC["paths"][f"{API}/jobs/{{id}}/results"]["post"]["responses"]


def test_claim_and_results_requests_match_the_schema(parent: FakeParent) -> None:
    parent.add(FakeJob("j1", "c1", judges=["openwakeword", "stt"]))
    recorder = Recorder()
    client = ParentClient(parent.url, TOKEN, "worker-1", transport=recorder)
    offers = [offer(j) for j in [*fake_judges(), OpenAICompatibleJudge()]]
    jobs = client.claim(offers, max_jobs=32, wait_seconds=60)
    client.audio(jobs[0].clip_id)
    long = "x" * 5000
    client.post_results(
        jobs[0].id,
        [
            Result("oww-1", "openwakeword", "fake+1", JudgeResult("yes", 0.9, 0.5), 12),
            Result(
                "stt-1", "stt", "fake+1", JudgeResult("abstain", transcript=long, detail=long), 0
            ),
            Result("c-1", "openai-compatible", "1", Failure(long, "quota", 1e9), 3),
        ],
    )
    claim, _audio, results = recorder.requests
    validator(request_schema("/jobs/claim", "post")).validate(json.loads(claim.content))
    validator(request_schema("/jobs/{id}/results", "post")).validate(json.loads(results.content))
    assert claim.headers["authorization"] == f"Bearer {TOKEN}"


def test_the_fake_parent_answers_as_the_parent_does(parent: FakeParent) -> None:
    parent.add(FakeJob("j1", "c1", wake_word="Alexa"))
    r = httpx.post(
        f"{parent.url}{API}/jobs/claim",
        headers={"authorization": f"Bearer {TOKEN}"},
        json={
            "protocol": 3,
            "worker": {"name": "w", "version": "1"},
            "types": [
                {
                    "id": "fake",
                    "version": "1",
                    "name": "Fake",
                    "kind": "speech_to_text",
                    "wakeWords": None,
                }
            ],
            "max": 8,
            "waitSeconds": 0,
        },
    )
    assert r.status_code == 200
    validator(response_schema("/jobs/claim", "post", "200")).validate(r.json())


def test_limits_the_worker_respects() -> None:
    claim = SPEC["components"]["schemas"]["ClaimRequest"]["properties"]
    assert claim["max"]["maximum"] >= 32  # WAKEWRIGHT_WORKER__BATCH is at most 32
    assert claim["waitSeconds"]["maximum"] >= 60
    result = SPEC["components"]["schemas"]["JudgeResult"]["properties"]
    assert result["transcript"]["maxLength"] == 2000
    assert result["detail"]["maxLength"] >= 500
    assert SPEC["components"]["schemas"]["ClaimRequest"]["properties"]["types"]["maxItems"] >= 4
    for judge in [*fake_judges(), OpenAICompatibleJudge()]:
        assert len(judge.version) <= 100
        assert len(judge.settings) <= 30
