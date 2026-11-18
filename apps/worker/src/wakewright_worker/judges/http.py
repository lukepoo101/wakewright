"""What cloud speech-to-text types share: one HTTP upload and its errors.

`upload()` posts the clip as a multipart WAV and turns every way it can
fail into the right outcome:

- `TemporaryFailure` when the failure says nothing about this clip: a
  refused key (auth), rate limits, a used-up quota, timeouts and network
  errors, a 5xx, a 404 (wrong address or model) or a setting the service
  refuses. The parent pauses the judge and tries the clip again later.
- `CannotTranscribe` (an abstention for this clip) for any other 4xx: the
  service would not take this clip.

Messages never hold the API key: for 401 and 403 the service's text is left
out (it can quote part of the key), and elsewhere it is cut short and
anything that looks like a key is removed.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any, cast

import httpx

from wakewright_worker import __version__
from wakewright_worker.audio import Clip, write_wav
from wakewright_worker.judges import TemporaryFailure

_KEYLIKE = re.compile(r"\b(?:sk|gsk|xi|key|api)[-_][A-Za-z0-9*._-]{6,}", re.IGNORECASE)
_QUOTA = re.compile(r"quota|billing|credit|exceeded your|insufficient", re.IGNORECASE)


class CannotTranscribe(Exception):
    """The service would not take this clip: an abstention, with `detail`."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def upload(
    url: str,
    clip: Clip,
    *,
    key: str,
    headers: Mapping[str, str],
    data: Mapping[str, str],
    timeout: float,
    transport: httpx.BaseTransport | None = None,
) -> dict[str, Any]:
    """POST the clip as `file` (clip.wav) with `data`; the JSON object answered."""
    try:
        with httpx.Client(timeout=timeout, transport=transport) as http:
            r = http.post(
                url,
                headers={"user-agent": f"wakewright-worker/{__version__}", **headers},
                data=dict(data),
                files={"file": ("clip.wav", write_wav(clip.samples), "audio/wav")},
            )
    except httpx.TimeoutException:
        raise TemporaryFailure(f"no answer within {timeout:g} s", reason="network") from None
    except httpx.TransportError as e:
        raise TemporaryFailure(
            f"cannot reach the service: {e.__class__.__name__}", reason="network"
        ) from None
    if r.status_code >= 300:
        fail(r, key)
    try:
        body: object = r.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise TemporaryFailure("the service's answer is not a JSON object", reason="server")
    return cast(dict[str, Any], body)


def message(r: httpx.Response, key: str) -> str:
    """The service's own error message, short and without anything key-like."""
    text = ""
    try:
        text = _text(r.json())
    except ValueError:
        text = r.text
    if key:
        text = text.replace(key, "[key]")
    return _KEYLIKE.sub("[key]", " ".join(text.split()))[:200]


def _text(body: object) -> str:
    """The message in the common error shapes: {"error": {"message"}},
    {"error": "..."}, {"detail": "..."}, {"detail": {"message"}} and
    {"detail": [{"msg"}]}."""
    if isinstance(body, str):
        return body
    if isinstance(body, list):
        return "; ".join(_text(x) for x in cast(list[object], body))
    if not isinstance(body, dict):
        return ""
    d = cast(dict[str, object], body)
    for k in ("error", "detail"):
        if d.get(k):
            return _text(d[k])
    for k in ("message", "msg", "status"):
        value = d.get(k)
        if isinstance(value, str) and value:
            return value
    return ""


def retry_after(r: httpx.Response) -> float | None:
    raw = r.headers.get("retry-after")
    try:
        return max(0.0, float(raw)) if raw is not None else None
    except ValueError:
        return None


def fail(r: httpx.Response, key: str) -> None:
    """Raise the outcome for an error answer (see the module docstring)."""
    status = r.status_code
    said = message(r, key)
    suffix = f": {said}" if said and status not in (401, 403) else ""
    if status in (401, 403, 429) and _QUOTA.search(said):
        raise TemporaryFailure(
            f"quota used up (HTTP {status})", reason="quota", retry_after=retry_after(r)
        )
    if status in (401, 403):
        raise TemporaryFailure(f"invalid API key (HTTP {status})", reason="auth")
    if status == 429:
        raise TemporaryFailure(
            f"rate limited (HTTP 429){suffix}", reason="rate_limit", retry_after=retry_after(r)
        )
    if status == 404:
        raise TemporaryFailure(f"not found (HTTP 404): check the address and the model{suffix}")
    if status >= 500:
        raise TemporaryFailure(
            f"the service failed (HTTP {status}){suffix}",
            reason="server",
            retry_after=retry_after(r),
        )
    if re.search(r"\bmodel|\blanguage", said, re.IGNORECASE):
        # A setting is wrong, not the clip: pause until the judge is fixed.
        raise TemporaryFailure(f"the service refused a setting (HTTP {status}){suffix}")
    raise CannotTranscribe(f"the service could not transcribe this clip (HTTP {status}){suffix}")
