"""The job loop against the in-process fake parent, with fake judges."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from typing import Any

import pytest
from fakes import TOKEN, FakeJob, FakeJudge, FakeParent

from wakewright_worker import loop
from wakewright_worker.client import ParentClient
from wakewright_worker.judges import JudgeResult, TemporaryFailure
from wakewright_worker.loop import Worker


@pytest.fixture
def parent() -> Iterator[FakeParent]:
    p = FakeParent().serve()
    yield p
    p.shutdown()


@pytest.fixture(autouse=True)
def fast_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(loop, "backoff", lambda attempt, start=0, cap=0: 0.05)
    monkeypatch.setattr(loop, "BACKOFF_MAX", 0.05)


def make_worker(parent: FakeParent, judges: list[Any], **kwargs: Any) -> Worker:
    client = ParentClient(parent.url, TOKEN, "test-worker")
    return Worker(client, judges, wait_seconds=1, **kwargs)


def start(worker: Worker) -> threading.Thread:
    t = threading.Thread(target=worker.run, daemon=True)
    t.start()
    return t


def stop(worker: Worker, thread: threading.Thread) -> None:
    worker.stop.set()
    thread.join(10)
    assert not thread.is_alive()


def test_judges_a_job_and_posts_every_result(parent: FakeParent) -> None:
    yes = FakeJudge("a", "a1", frozenset({"alexa"}), answer=JudgeResult("yes", 0.9, 0.5))
    no = FakeJudge("b", "b1", answer=JudgeResult("no", transcript="hello there"))
    parent.add(FakeJob("j1", "c1", "Alexa", ["a", "b"]))
    w = make_worker(parent, [yes, no])
    t = start(w)
    assert parent.wait_for(lambda p: "j1" in p.results)
    stop(w, t)

    claim = parent.claims[0]
    assert claim["protocol"] == 3
    assert claim["worker"]["name"] == "test-worker"
    assert [(t["id"], t["version"], t["wakeWords"], t["kind"]) for t in claim["types"]] == [
        ("a", "a1", ["alexa"], "wake_word_model"),
        ("b", "b1", None, "speech_to_text"),
    ]
    assert claim["max"] == 8
    results = {r["instance"]: r for r in parent.results["j1"]}
    assert results["a-1"] | {"durationMs": 0} == {
        "instance": "a-1",
        "type": "a",
        "version": "a1",
        "verdict": "yes",
        "score": 0.9,
        "threshold": 0.5,
        "transcript": None,
        "detail": None,
        "failure": None,
        "durationMs": 0,
    }
    assert results["b-1"]["transcript"] == "hello there"
    assert isinstance(results["b-1"]["durationMs"], int)
    # The judge saw the clip's wake word and its 3 s of audio.
    assert yes.seen[0][0].wake_word == "Alexa"
    assert len(yes.seen[0][0].samples) == 48_000


def test_runs_each_judge_with_its_own_settings(parent: FakeParent) -> None:
    stt = FakeJudge("cloud", answer=JudgeResult("yes", transcript="alexa"))
    parent.add(
        FakeJob(
            "j1",
            "c1",
            judges=[
                {"instance": "x", "type": "cloud", "settings": {"model": "big"}},
                {"instance": "y", "type": "cloud", "settings": {"model": "small"}},
            ],
        )
    )
    w = make_worker(parent, [stt])
    t = start(w)
    assert parent.wait_for(lambda p: "j1" in p.results)
    stop(w, t)
    assert [s for _, s in stt.seen] == [{"model": "big"}, {"model": "small"}]
    assert [r["instance"] for r in parent.results["j1"]] == ["x", "y"]


def test_a_temporary_failure_is_reported_and_skips_the_judge_for_the_claim(
    parent: FakeParent, caplog: pytest.LogCaptureFixture
) -> None:
    secret = "sk-very-secret-key-123456"
    cloud = FakeJudge(
        "cloud", fail=TemporaryFailure("rate limited", reason="rate_limit", retry_after=30)
    )
    local = FakeJudge("local")
    judges: list[str | dict[str, Any]] = [
        {"instance": "c", "type": "cloud", "settings": {"api_key": secret}},
        "local",
    ]
    parent.add(FakeJob("j1", "c1", judges=judges))
    parent.add(FakeJob("j2", "c2", judges=judges))
    w = make_worker(parent, [cloud, local], batch=2)
    with caplog.at_level("DEBUG"):
        t = start(w)
        assert parent.wait_for(lambda p: "j2" in p.results)
        stop(w, t)
    first = {r["instance"]: r for r in parent.results["j1"]}
    assert first["c"]["verdict"] == "failed"
    assert first["c"]["failure"] == {"reason": "rate_limit", "retryAfterSeconds": 30}
    assert first["c"]["detail"] == "rate limited"
    assert first["local-1"]["verdict"] == "no"
    # The failing judge is not tried again within the same claim.
    assert [r["instance"] for r in parent.results["j2"]] == ["local-1"]
    assert len(cloud.seen) == 1
    assert w.stats.failed == 1
    # Its settings, and so its key, are never logged.
    assert secret not in caplog.text
    assert secret not in repr(w)


def test_runs_only_the_judges_the_job_asks_for(parent: FakeParent) -> None:
    a, b = FakeJudge("a"), FakeJudge("b")
    parent.add(FakeJob("j1", "c1", judges=["b"]))
    w = make_worker(parent, [a, b])
    t = start(w)
    assert parent.wait_for(lambda p: "j1" in p.results)
    stop(w, t)
    assert [r["type"] for r in parent.results["j1"]] == ["b"]
    assert not a.seen


def test_a_crashing_judge_abstains_with_the_error(parent: FakeParent) -> None:
    bad = FakeJudge("bad", crash=ValueError("boom"))
    good = FakeJudge("good")
    parent.add(FakeJob("j1", "c1", judges=["bad", "good"]))
    w = make_worker(parent, [bad, good])
    t = start(w)
    assert parent.wait_for(lambda p: "j1" in p.results)
    stop(w, t)
    results = {r["type"]: r for r in parent.results["j1"]}
    assert results["bad"]["verdict"] == "abstain"
    assert results["bad"]["detail"] == "judge error: ValueError: boom"
    assert results["good"]["verdict"] == "no"


def test_invalid_audio_makes_every_judge_abstain(parent: FakeParent) -> None:
    parent.add(FakeJob("j1", "c1", judges=["fake"]), audio=b"not a wav")
    w = make_worker(parent, [FakeJudge()])
    t = start(w)
    assert parent.wait_for(lambda p: "j1" in p.results)
    stop(w, t)
    [result] = parent.results["j1"]
    assert result["verdict"] == "abstain"
    assert result["detail"].startswith("invalid audio:")


def test_reconnects_when_the_parent_comes_back() -> None:
    # Reserve a port, then start nothing on it: the parent is down.
    probe = FakeParent().serve()
    url = probe.url
    port = int(url.rsplit(":", 1)[1])
    probe.shutdown()
    client = ParentClient(url, TOKEN, "test-worker")
    w = Worker(client, [FakeJudge()], wait_seconds=1)
    t = start(w)
    assert w.stop.wait(0.3) is False
    assert w.stats.errors, "the worker should have failed to claim"

    parent = FakeParent()
    parent.add(FakeJob("j1", "c1"))
    parent.serve(port)
    try:
        assert parent.wait_for(lambda p: "j1" in p.results)
    finally:
        stop(w, t)
        parent.shutdown()


@pytest.mark.parametrize("status", [401, 404, 426, 500])
def test_backs_off_and_retries_when_the_parent_refuses(parent: FakeParent, status: int) -> None:
    parent.claim_status = [status, status]
    parent.add(FakeJob("j1", "c1"))
    w = make_worker(parent, [FakeJudge()])
    t = start(w)
    assert parent.wait_for(lambda p: "j1" in p.results)
    stop(w, t)
    assert len(parent.claims) >= 3
    assert len(w.stats.errors) == 2


def test_a_lost_lease_is_not_fatal(parent: FakeParent) -> None:
    parent.results_status = [409]
    parent.add(FakeJob("j1", "c1"))
    parent.add(FakeJob("j2", "c2"))
    w = make_worker(parent, [FakeJudge()])
    t = start(w)
    assert parent.wait_for(lambda p: "j2" in p.results)
    stop(w, t)
    assert w.stats.lease_lost == 1


def test_posting_retries_when_the_parent_blips(parent: FakeParent) -> None:
    parent.results_status = [503, 502]
    parent.add(FakeJob("j1", "c1"))
    w = make_worker(parent, [FakeJudge()])
    t = start(w)
    assert parent.wait_for(lambda p: "j1" in p.results)
    stop(w, t)


def test_skips_a_job_whose_lease_already_expired(parent: FakeParent) -> None:
    parent.add(FakeJob("old", "c1", lease_seconds=-1))
    parent.add(FakeJob("new", "c2"))
    judge = FakeJudge()
    w = make_worker(parent, [judge])
    t = start(w)
    assert parent.wait_for(lambda p: "new" in p.results)
    stop(w, t)
    assert len(judge.seen) == 1


def test_missing_audio_skips_the_job(parent: FakeParent) -> None:
    parent.audio_status = [404]
    parent.add(FakeJob("j1", "c1"))
    parent.add(FakeJob("j2", "c2"))
    w = make_worker(parent, [FakeJudge()])
    t = start(w)
    assert parent.wait_for(lambda p: "j2" in p.results)
    stop(w, t)
    assert "j1" not in parent.results


def test_offers_only_prepared_judges_and_retries_the_rest(parent: FakeParent) -> None:
    flaky = FakeJudge("flaky", prepare_failures=1)
    steady = FakeJudge("steady")
    w = make_worker(parent, [flaky, steady])
    w.prepare_due()
    assert list(w.ready) == ["steady"]
    assert [o.id for o in w.offers()] == ["steady"]
    w.pending["flaky"].next_try = 0
    w.prepare_due()
    assert sorted(w.ready) == ["flaky", "steady"]


def test_stops_promptly_and_finishes_the_job_in_hand(parent: FakeParent) -> None:
    started = threading.Event()
    release = threading.Event()

    class Slow(FakeJudge):
        def judge(self, clip: Any, settings: Any) -> JudgeResult:
            started.set()
            release.wait(5)
            return super().judge(clip, settings)

    parent.add(FakeJob("j1", "c1"))
    parent.add(FakeJob("j2", "c2"))
    w = make_worker(parent, [Slow()], batch=2)
    t = start(w)
    assert started.wait(5)
    w.stop.set()
    release.set()
    t.join(5)
    assert not t.is_alive()
    # The job in hand was posted; the second was left to its lease.
    assert list(parent.results) == ["j1"]


def test_once_mode_exit_codes(parent: FakeParent) -> None:
    parent.add(FakeJob("j1", "c1"))
    assert make_worker(parent, [FakeJudge()]).run(once=True) == 0
    assert "j1" in parent.results
    parent.claim_status = [401]
    assert make_worker(parent, [FakeJudge()]).run(once=True) == 1
    assert make_worker(parent, [FakeJudge(prepare_failures=1)]).run(once=True) == 1


def test_heartbeat_file(parent: FakeParent, tmp_path: Any) -> None:
    beat = tmp_path / "alive"
    parent.add(FakeJob("j1", "c1"))
    w = make_worker(parent, [FakeJudge()], heartbeat=beat)
    assert w.run(once=True) == 0
    assert beat.exists()


def test_two_word_wake_words_are_offered_in_both_spellings() -> None:
    assert loop.spellings(None) is None
    assert loop.spellings(frozenset({"alexa", "hey jarvis"})) == [
        "alexa",
        "hey jarvis",
        "hey_jarvis",
    ]
