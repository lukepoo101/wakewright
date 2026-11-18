from __future__ import annotations

from pathlib import Path

import pytest

from wakewright_worker import config
from wakewright_worker.config import ConfigError, load

BASE = {"WAKEWRIGHT_WORKER__PARENT_URL": "http://parent:8080/", "WAKEWRIGHT_WORKER__TOKEN": "t"}


def test_defaults() -> None:
    cfg = load(BASE | {"XDG_CACHE_HOME": "/xdg"})
    assert cfg.parent_url == "http://parent:8080"
    assert cfg.token == "t"
    assert cfg.judges == ("openwakeword", "microwakeword", "stt")
    assert cfg.batch == 8
    assert cfg.wait_seconds == 25
    assert cfg.name  # the hostname


def test_everything_set(tmp_path: Path) -> None:
    token = tmp_path / "token"
    token.write_text("from-file\n")
    cfg = load(
        {
            "WAKEWRIGHT_WORKER__PARENT_URL": "https://p",
            "WAKEWRIGHT_WORKER__TOKEN_FILE": str(token),
            "WAKEWRIGHT_WORKER__CACHE_DIR": str(tmp_path / "cache"),
            "WAKEWRIGHT_WORKER__NAME": "laptop",
            "WAKEWRIGHT_WORKER__JUDGES": "stt, openwakeword",
            "WAKEWRIGHT_WORKER__BATCH": "2",
            "WAKEWRIGHT_WORKER__LOG_FORMAT": "text",
        }
    )
    assert cfg.token == "from-file"
    assert cfg.cache_dir == tmp_path / "cache"
    assert cfg.name == "laptop"
    assert cfg.judges == ("stt", "openwakeword")
    assert cfg.batch == 2
    assert cfg.log_format == "text"


@pytest.mark.parametrize(
    ("env", "message"),
    [
        ({}, "PARENT_URL is required"),
        ({"WAKEWRIGHT_WORKER__PARENT_URL": "parent:8080"}, "must start with http"),
        ({"WAKEWRIGHT_WORKER__PARENT_URL": "http://p"}, "TOKEN or"),
        (BASE | {"WAKEWRIGHT_WORKER__TOKEN_FILE": "/x"}, "not both"),
        (BASE | {"WAKEWRIGHT_WORKER__JUDGES": "whisper"}, "JUDGES must list"),
        (BASE | {"WAKEWRIGHT_WORKER__BATCH": "0"}, "between 1 and 32"),
        (BASE | {"WAKEWRIGHT_WORKER__BATCH": "many"}, "whole number"),
        (BASE | {"WAKEWRIGHT_WORKER__LOG_FORMAT": "xml"}, "LOG_FORMAT"),
    ],
)
def test_invalid(env: dict[str, str], message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load(env)


def test_token_file_problems(tmp_path: Path) -> None:
    env = {"WAKEWRIGHT_WORKER__PARENT_URL": "http://p"}
    with pytest.raises(ConfigError, match="cannot read"):
        load(env | {"WAKEWRIGHT_WORKER__TOKEN_FILE": str(tmp_path / "missing")})
    (tmp_path / "empty").write_text("\n")
    with pytest.raises(ConfigError, match="is empty"):
        load(env | {"WAKEWRIGHT_WORKER__TOKEN_FILE": str(tmp_path / "empty")})


def test_commands_without_a_parent_need_no_token() -> None:
    cfg = load({}, need_parent=False)
    assert cfg.token == ""


def test_the_token_never_appears_in_repr() -> None:
    assert "s3cret" not in repr(load(BASE | {"WAKEWRIGHT_WORKER__TOKEN": "s3cret"}))


def test_default_cache_dir_per_platform(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(config.sys, "platform", "linux")
    assert config.default_cache_dir({"XDG_CACHE_HOME": "/xdg"}) == Path("/xdg/wakewright-worker")
    monkeypatch.setattr(config.sys, "platform", "win32")
    assert config.default_cache_dir({"LOCALAPPDATA": "C:/Users/u/AppData/Local"}) == Path(
        "C:/Users/u/AppData/Local/Wakewright/worker/cache"
    )
