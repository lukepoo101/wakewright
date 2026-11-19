"""The parent's worker API, `/api/worker/v1`, as the worker uses it.

Wire format: docs/workers.md (docs/api/worker-v1.openapi.json is the
source of truth). The worker only ever makes outbound requests.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, cast
from urllib.parse import quote

import httpx

from wakewright_worker import __version__
from wakewright_worker.judges import FailureReason, JudgeResult

PROTOCOL = 3
API = "/api/worker/v1"


class ParentError(RuntimeError):
    """The parent answered, but not with what the worker can use."""


class Unreachable(ParentError):
    """No answer: the parent is down, restarting or the network is."""


class NotEnabled(ParentError):
    """404: no worker API at this address (a parent before 0.2.0 without a token)."""


class Unauthorised(ParentError):
    """401 or 403: the token is not a worker's (replaced, deleted or mistyped)."""


class ProtocolMismatch(ParentError):
    """426: the parent speaks another protocol version."""


class Gone(ParentError):
    """404 for one clip or job: it was deleted or never existed."""


class LeaseLost(ParentError):
    """409: the job's lease expired or another claim holds it."""


@dataclass(frozen=True)
class TypeOffer:
    """A judge type as the claim advertises it, with its settings form."""

    id: str
    version: str
    name: str
    kind: str
    description: str
    external: bool
    wake_words: list[str] | None
    settings: list[dict[str, Any]]

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "version": self.version,
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "external": self.external,
            "wakeWords": self.wake_words,
            "settings": self.settings,
        }


@dataclass(frozen=True)
class JobJudge:
    """One judge (instance) to run on a job's clip. `settings` can hold an
    API key: it is left out of repr, and must never be logged."""

    instance: str
    type: str
    settings: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class Job:
    id: str
    clip_id: str
    wake_word: str
    judges: list[JobJudge]
    lease_expires_at: str


@dataclass(frozen=True)
class Failure:
    """A judge could not answer now: nothing is recorded for the clip."""

    message: str
    reason: FailureReason
    retry_after: float | None = None


@dataclass(frozen=True)
class Result:
    instance: str
    type: str
    version: str
    result: JudgeResult | Failure
    duration_ms: int

    def to_wire(self) -> dict[str, Any]:
        base: dict[str, Any] = {
            "instance": self.instance,
            "type": self.type,
            "version": self.version,
            "durationMs": self.duration_ms,
        }
        if isinstance(self.result, Failure):
            f = self.result
            return base | {
                "verdict": "failed",
                "score": None,
                "threshold": None,
                "transcript": None,
                "detail": f.message[:500],
                "failure": {
                    "reason": f.reason,
                    "retryAfterSeconds": None
                    if f.retry_after is None
                    else min(86_400.0, f.retry_after),
                },
            }
        r = asdict(self.result)
        return base | {
            "verdict": r["verdict"],
            "score": r["score"],
            "threshold": r["threshold"],
            # The parent stores at most 2000 characters of each.
            "transcript": None if r["transcript"] is None else r["transcript"][:2000],
            "detail": None if r["detail"] is None else r["detail"][:2000],
            "failure": None,
        }


class ParentClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        worker_name: str,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.worker_name = worker_name
        self._http = httpx.Client(
            base_url=base_url.rstrip("/") + API,
            headers={
                "authorization": f"Bearer {token}",
                "user-agent": f"wakewright-worker/{__version__}",
            },
            timeout=httpx.Timeout(15.0),
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> ParentClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _send(
        self, method: str, path: str, *, gone: str | None = None, **kwargs: Any
    ) -> httpx.Response:
        """One request. `gone` is the message for a 404 that means the
        resource went away rather than that the worker API is off."""
        try:
            r = self._http.request(method, path, **kwargs)
        except httpx.TransportError as e:
            raise Unreachable(f"{method} {path}: {e.__class__.__name__}: {e}") from None
        if r.status_code < 300:
            return r
        body = r.text[:500]
        if r.status_code == 404 and gone is not None:
            raise Gone(gone)
        if r.status_code == 404:
            raise NotEnabled(
                "no worker API at this address (404): check the parent's address, and that "
                "the parent is the same Wakewright release as this worker"
            )
        if r.status_code in (401, 403):
            raise Unauthorised(
                f"the parent refused this worker's token ({r.status_code}): it was replaced, its "
                "worker was deleted, or it is mistyped; check the worker in the parent's "
                "Workers tab"
            )
        if r.status_code == 426:
            raise ProtocolMismatch(
                f"the parent does not speak worker protocol {PROTOCOL}: {body}; upgrade the "
                "worker and the parent to the same release"
            )
        if r.status_code == 409:
            raise LeaseLost(f"{method} {path}: {body}")
        if r.status_code >= 500 or r.status_code == 429:
            raise Unreachable(f"{method} {path}: HTTP {r.status_code}")
        raise ParentError(f"{method} {path}: HTTP {r.status_code}: {body}")

    def claim(self, types: list[TypeOffer], max_jobs: int, wait_seconds: int) -> list[Job]:
        body = {
            "protocol": PROTOCOL,
            "worker": {"name": self.worker_name, "version": __version__},
            "types": [t.to_wire() for t in types],
            "max": max_jobs,
            "waitSeconds": wait_seconds,
        }
        # The parent holds the request for up to waitSeconds.
        r = self._send("POST", "/jobs/claim", json=body, timeout=wait_seconds + 15.0)
        try:
            data = cast(dict[str, Any], r.json())
            return [
                Job(
                    id=str(j["id"]),
                    clip_id=str(j["clipId"]),
                    wake_word=str(j["wakeWord"]),
                    judges=[
                        JobJudge(
                            instance=str(x["instance"]),
                            type=str(x["type"]),
                            settings=dict(cast(dict[str, Any], x.get("settings") or {})),
                        )
                        for x in j["judges"]
                    ],
                    lease_expires_at=str(j["leaseExpiresAt"]),
                )
                for j in data["jobs"]
            ]
        except (ValueError, KeyError, TypeError) as e:
            raise ParentError(f"unexpected claim response: {e!r}") from None

    def audio(self, clip_id: str) -> bytes:
        path = f"/clips/{quote(clip_id, safe='')}/audio"
        return self._send("GET", path, gone=f"clip {clip_id} has no audio", timeout=60.0).content

    def post_results(self, job_id: str, results: list[Result]) -> None:
        self._send(
            "POST",
            f"/jobs/{quote(job_id, safe='')}/results",
            gone=f"job {job_id} no longer exists",
            json={"results": [r.to_wire() for r in results]},
        )
