from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path

import pytest
from fakes import TOKEN, FakeJob, FakeJudge, FakeParent

from wakewright_worker import cli


def test_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        cli.main(["--version"])
    assert exit_info.value.code == 0
    assert capsys.readouterr().out.startswith("wakewright-worker ")


def test_missing_configuration_exits_2(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for key in list(os.environ):
        if key.startswith("WAKEWRIGHT_WORKER__"):
            monkeypatch.delenv(key)
    assert cli.main(["run"]) == 2
    assert "PARENT_URL is required" in capsys.readouterr().err


def test_healthcheck(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    beat = tmp_path / "alive"
    monkeypatch.setattr(cli, "HEARTBEAT", beat)
    assert cli.main(["healthcheck"]) == 1
    beat.touch()
    assert cli.main(["healthcheck"]) == 0
    old = time.time() - cli.HEARTBEAT_MAX_AGE - 10
    os.utime(beat, (old, old))
    assert cli.main(["healthcheck"]) == 1


def test_run_once_against_the_fake_parent(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    parent = FakeParent().serve()
    try:
        parent.add(FakeJob("j1", "c1"))
        monkeypatch.setattr(cli, "HEARTBEAT", tmp_path / "alive")
        monkeypatch.setattr(cli, "build_judges", lambda cfg, names=None: [FakeJudge()])
        for key, value in {
            "PARENT_URL": parent.url,
            "TOKEN": TOKEN,
            "CACHE_DIR": str(tmp_path),
            "WAIT_SECONDS": "1",
        }.items():
            monkeypatch.setenv(f"WAKEWRIGHT_WORKER__{key}", value)
        assert cli.main(["run", "--once"]) == 0
        assert parent.results["j1"][0]["judge"] == "fake"
    finally:
        parent.shutdown()


def test_run_once_with_a_pairing_argument(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    parent = FakeParent().serve()
    try:
        parent.add(FakeJob("j1", "c1"))
        monkeypatch.setattr(cli, "HEARTBEAT", tmp_path / "alive")
        monkeypatch.setattr(cli, "build_judges", lambda cfg, names=None: [FakeJudge()])
        for key in list(os.environ):
            if key.startswith("WAKEWRIGHT_WORKER__"):
                monkeypatch.delenv(key)
        monkeypatch.setenv("WAKEWRIGHT_WORKER__CACHE_DIR", str(tmp_path))
        monkeypatch.setenv("WAKEWRIGHT_WORKER__WAIT_SECONDS", "1")
        data = json.dumps({"url": parent.url, "token": TOKEN}).encode()
        pairing = "wakewright-pair:1:" + base64.urlsafe_b64encode(data).decode().rstrip("=")
        assert cli.main(["run", "--once", "--pairing", pairing]) == 0
        assert parent.results["j1"][0]["judge"] == "fake"
    finally:
        parent.shutdown()


def test_self_test_with_fake_judges(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from wakewright_worker.judges import JudgeResult

    monkeypatch.setattr(cli, "build_judges", lambda cfg, names=None: [FakeJudge()])
    assert cli.main(["self-test"]) == 0
    assert "self-test passed" in capsys.readouterr().out
    monkeypatch.setattr(
        cli,
        "build_judges",
        lambda cfg, names=None: [FakeJudge(answer=JudgeResult("yes"))],
    )
    assert cli.main(["self-test"]) == 1
