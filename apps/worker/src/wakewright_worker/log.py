"""Structured logs on stderr: JSON lines by default (like the parent), or
plain text for a terminal. Extra fields come from `extra={...}`."""

from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any, TextIO

_STANDARD = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {"message", "asctime"}


def _fields(record: logging.LogRecord) -> dict[str, Any]:
    return {k: v for k, v in record.__dict__.items() if k not in _STANDARD}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
            **_fields(record),
        }
        if record.exc_info:
            entry["error"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        fields = " ".join(f"{k}={v}" for k, v in _fields(record).items())
        clock = time.strftime("%H:%M:%S", time.localtime(record.created))
        line = f"{clock} {record.levelname:<7} {record.getMessage()}"
        if fields:
            line += f"  {fields}"
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def setup(log_format: str = "json", level: str = "INFO", stream: TextIO | None = None) -> None:
    handler = logging.StreamHandler(stream or sys.stderr)
    handler.setFormatter(JsonFormatter() if log_format == "json" else TextFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # Libraries log every request at INFO; the worker logs what matters itself.
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
