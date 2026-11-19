"""Worker configuration from `WAKEWRIGHT_WORKER__*` environment variables.

Everything has a default except the parent's address and this worker's
token, which can also come together as one pairing string, so the same code
runs in the container, under `uv run` on a laptop and, later, behind a
desktop wrapper that fills the same fields from a settings file.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import socket
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

PREFIX = "WAKEWRIGHT_WORKER__"
# The judge types this worker offers by default: judges/registry.py.
JUDGE_NAMES = (
    "openwakeword",
    "microwakeword",
    "stt",
    "openai-compatible",
    "elevenlabs",
    "audio-question",
)
# The pairing string the parent's Workers tab shows (docs/workers.md):
# "wakewright-pair:1:" and base64url (no padding) of {"url": ..., "token": ...}.
PAIRING_PREFIX = "wakewright-pair:"
PAIRING_VERSION = "1"


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

    def __repr__(self) -> str:  # never print the token or the pairing string
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


def parse_pairing(text: str) -> tuple[str, str]:
    """The parent's address and the token from a pairing string."""
    value = text.strip()
    if not value.startswith(PAIRING_PREFIX):
        raise ConfigError(f'a pairing string starts with "{PAIRING_PREFIX}"')
    version, _, data = value[len(PAIRING_PREFIX) :].partition(":")
    if version != PAIRING_VERSION:
        raise ConfigError(
            f"this pairing string is format {version or '?'}; this worker reads format "
            f"{PAIRING_VERSION}: upgrade the worker"
        )
    try:
        raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
        decoded: object = json.loads(raw.decode("utf-8"))
    except (binascii.Error, ValueError):
        raise ConfigError("the pairing string is damaged: copy it again") from None
    fields = decoded if isinstance(decoded, dict) else {}
    url: object = fields.get("url")  # pyright: ignore[reportUnknownMemberType]
    token: object = fields.get("token")  # pyright: ignore[reportUnknownMemberType]
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise ConfigError("the pairing string has no http:// or https:// address")
    if not isinstance(token, str) or not token:
        raise ConfigError("the pairing string has no token")
    return url.rstrip("/"), token


def read_pairing(env: Mapping[str, str], given: str | None = None) -> tuple[str, str] | None:
    """The pairing string from the command line, PAIRING or PAIRING_FILE, if any."""
    direct = given.strip() if given else _get(env, "PAIRING")
    path = _get(env, "PAIRING_FILE")
    if direct and path:
        raise ConfigError(f"set {PREFIX}PAIRING (or --pairing) or {PREFIX}PAIRING_FILE, not both")
    if path:
        try:
            direct = Path(path).read_text(encoding="utf-8").strip()
        except OSError as e:
            raise ConfigError(f"{PREFIX}PAIRING_FILE: cannot read {path}: {e}") from None
    if not direct:
        return None
    try:
        return parse_pairing(direct)
    except ConfigError as e:
        raise ConfigError(f"cannot use the pairing string: {e}") from None


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
            f"{PREFIX}PAIRING, or {PREFIX}TOKEN or {PREFIX}TOKEN_FILE, is required: this "
            "worker's pairing string or token, from the parent's Workers tab (see docs/worker.md)"
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


def load(
    env: Mapping[str, str] = os.environ, *, need_parent: bool = True, pairing: str | None = None
) -> Config:
    """Read the configuration. `need_parent=False` is for commands that never
    talk to the parent (downloading models, the self-test). `pairing` is a
    pairing string given on the command line; PARENT_URL, when set, replaces
    the address in a pairing string."""
    parent_url = _get(env, "PARENT_URL")
    token = ""
    if need_parent:
        paired = read_pairing(env, pairing)
        if paired is not None:
            if _get(env, "TOKEN") or _get(env, "TOKEN_FILE"):
                raise ConfigError(
                    f"give a pairing string or {PREFIX}TOKEN(_FILE), not both: the pairing "
                    "string holds the token"
                )
            parent_url = parent_url or paired[0]
            token = paired[1]
        if not parent_url:
            raise ConfigError(
                f"{PREFIX}PARENT_URL is required, e.g. http://wakewright:8080, unless a pairing "
                f"string ({PREFIX}PAIRING) gives it"
            )
        if not parent_url.startswith(("http://", "https://")):
            raise ConfigError(f"{PREFIX}PARENT_URL must start with http:// or https://")
        if paired is None:
            token = read_token(env)
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
