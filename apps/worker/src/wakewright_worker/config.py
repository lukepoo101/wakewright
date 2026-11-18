"""Worker configuration from `WAKEWRIGHT_WORKER__*` environment variables.

Everything has a default except the parent's address and the token, so the
same code runs in the container, under `uv run` on a laptop and, later,
behind a desktop wrapper that fills the same fields from a settings file.
"""

from __future__ import annotations

import os
import socket
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

PREFIX = "WAKEWRIGHT_WORKER__"
JUDGE_NAMES = ("openwakeword", "microwakeword", "stt")


class ConfigError(ValueError):
    """A setting is missing or invalid; the message names the variable."""


@dataclass(frozen=True)
class Config:
    parent_url: str
    token: str
    cache_dir: Path
    name: str
    judges: tuple[str, ...] = JUDGE_NAMES
    batch: int = 8
    wait_seconds: int = 25
    log_format: str = "json"
    log_level: str = "INFO"

    def __repr__(self) -> str:  # never print the token
        return (
            f"Config(parent_url={self.parent_url!r}, cache_dir={str(self.cache_dir)!r}, "
            f"name={self.name!r}, judges={self.judges!r}, batch={self.batch})"
        )


def default_cache_dir(env: Mapping[str, str] = os.environ) -> Path:
    """The per-user cache directory for downloaded models on this platform."""
    if sys.platform == "win32":
        base = env.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Wakewright" / "worker" / "cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "wakewright-worker"
    base = env.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "wakewright-worker"


def _get(env: Mapping[str, str], key: str) -> str | None:
    value = env.get(PREFIX + key)
    return value.strip() if value is not None and value.strip() != "" else None


def _int(env: Mapping[str, str], key: str, default: int, low: int, high: int) -> int:
    raw = _get(env, key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{PREFIX}{key} must be a whole number, got {raw!r}") from None
    if not low <= value <= high:
        raise ConfigError(f"{PREFIX}{key} must be between {low} and {high}, got {value}")
    return value


def read_token(env: Mapping[str, str]) -> str:
    token = _get(env, "TOKEN")
    token_file = _get(env, "TOKEN_FILE")
    if token and token_file:
        raise ConfigError(f"set {PREFIX}TOKEN or {PREFIX}TOKEN_FILE, not both")
    if token_file:
        try:
            token = Path(token_file).read_text(encoding="utf-8").strip()
        except OSError as e:
            raise ConfigError(f"{PREFIX}TOKEN_FILE: cannot read {token_file}: {e}") from None
        if not token:
            raise ConfigError(f"{PREFIX}TOKEN_FILE: {token_file} is empty")
    if not token:
        raise ConfigError(
            f"{PREFIX}TOKEN or {PREFIX}TOKEN_FILE is required: the parent's "
            "WAKEWRIGHT__WORKER__TOKEN (see docs/worker.md)"
        )
    return token


def parse_judges(raw: str | None) -> tuple[str, ...]:
    if raw is None:
        return JUDGE_NAMES
    names = tuple(dict.fromkeys(n.strip() for n in raw.split(",") if n.strip()))
    unknown = [n for n in names if n not in JUDGE_NAMES]
    if unknown or not names:
        raise ConfigError(f"{PREFIX}JUDGES must list some of {', '.join(JUDGE_NAMES)}, got {raw!r}")
    return names


def load(env: Mapping[str, str] = os.environ, *, need_parent: bool = True) -> Config:
    """Read the configuration. `need_parent=False` is for commands that never
    talk to the parent (downloading models, the self-test)."""
    parent_url = _get(env, "PARENT_URL")
    if need_parent:
        if not parent_url:
            raise ConfigError(f"{PREFIX}PARENT_URL is required, e.g. http://wakewright:8080")
        if not parent_url.startswith(("http://", "https://")):
            raise ConfigError(f"{PREFIX}PARENT_URL must start with http:// or https://")
        token = read_token(env)
    else:
        token = ""
    cache = _get(env, "CACHE_DIR")
    log_format = (_get(env, "LOG_FORMAT") or "json").lower()
    if log_format not in ("json", "text"):
        raise ConfigError(f"{PREFIX}LOG_FORMAT must be json or text, got {log_format!r}")
    log_level = (_get(env, "LOG_LEVEL") or "INFO").upper()
    if log_level not in ("DEBUG", "INFO", "WARNING", "ERROR"):
        raise ConfigError(f"{PREFIX}LOG_LEVEL must be DEBUG, INFO, WARNING or ERROR")
    return Config(
        parent_url=(parent_url or "").rstrip("/"),
        token=token,
        cache_dir=Path(cache).expanduser() if cache else default_cache_dir(env),
        name=_get(env, "NAME") or socket.gethostname(),
        judges=parse_judges(_get(env, "JUDGES")),
        batch=_int(env, "BATCH", 8, 1, 32),
        wait_seconds=_int(env, "WAIT_SECONDS", 25, 0, 60),
        log_format=log_format,
        log_level=log_level,
    )
