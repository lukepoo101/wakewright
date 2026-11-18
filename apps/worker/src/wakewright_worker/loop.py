"""The job loop: claim, fetch audio, judge, post results, repeat.

- Judges are prepared (models loaded, downloaded on first use) before the
  worker offers them. A judge that fails to prepare is left out of claims
  and retried with backoff, so one broken model does not stop the others.
- When the parent cannot be reached, or refuses the worker, the loop waits
  with exponential backoff and jitter (1 s doubling to 60 s), then retries.
- A judge that raises on a clip is reported as `abstain` with the error in
  `detail`, so the clip is not handed out again and again.
- `stop` (set by SIGTERM or Ctrl+C) ends the loop after the job in hand is
  posted; jobs claimed but not started are left to their leases.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from wakewright_worker.audio import Clip, InvalidAudio, read_wav
from wakewright_worker.client import (
    Gone,
    Job,
    JudgeOffer,
    LeaseLost,
    NotEnabled,
    ParentClient,
    ParentError,
    ProtocolMismatch,
    Result,
    Unauthorised,
    Unreachable,
)
from wakewright_worker.judges import Judge, JudgeResult

log = logging.getLogger(__name__)

BACKOFF_START = 1.0
BACKOFF_MAX = 60.0
PREPARE_RETRY_MAX = 600.0
POST_ATTEMPTS = 4


class Interrupted(BaseException):
    """Raised by the signal handler to break out of an idle long poll."""


def backoff(attempt: int, start: float = BACKOFF_START, cap: float = BACKOFF_MAX) -> float:
    """Full-jitter exponential backoff: a random wait up to start * 2^attempt."""
    ceiling = min(cap, start * 2 ** max(0, attempt))
    return random.uniform(ceiling / 2, ceiling)  # noqa: S311 - not for security


@dataclass
class _Pending:
    judge: Judge
    failures: int = 0
    next_try: float = 0.0


@dataclass
class Stats:
    claims: int = 0
    jobs: int = 0
    results: int = 0
    abstained: int = 0
    lease_lost: int = 0
    errors: list[str] = field(default_factory=list[str])


class Worker:
    def __init__(
        self,
        client: ParentClient,
        judges: Sequence[Judge],
        *,
        batch: int = 8,
        wait_seconds: int = 25,
        stop: threading.Event | None = None,
        heartbeat: Path | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.client = client
        self.batch = batch
        self.wait_seconds = wait_seconds
        self.stop = stop or threading.Event()
        self.heartbeat = heartbeat
        self.clock = clock
        self.ready: dict[str, Judge] = {}
        self.pending: dict[str, _Pending] = {j.name: _Pending(j) for j in judges}
        # True while the loop only waits (long poll or backoff), so a signal
        # may interrupt it; False while a job is being judged or posted.
        self.idle = False
        self.stats = Stats()
        self._failures = 0
        self._connected = False

    # -- judges ---------------------------------------------------------------

    def prepare_due(self) -> None:
        now = self.clock()
        for name, p in list(self.pending.items()):
            if self.stop.is_set() or p.next_try > now:
                continue
            started = time.monotonic()
            try:
                p.judge.prepare()
            except Exception as e:  # noqa: BLE001 - any failure means "not ready yet"
                p.failures += 1
                delay = backoff(p.failures, start=10.0, cap=PREPARE_RETRY_MAX)
                p.next_try = self.clock() + delay
                log.error(
                    "judge could not be prepared; retrying later",
                    extra={
                        "judge": name,
                        "error": f"{e.__class__.__name__}: {e}",
                        "retryIn": round(delay),
                    },
                )
                continue
            del self.pending[name]
            self.ready[name] = p.judge
            log.info(
                "judge ready",
                extra={
                    "judge": name,
                    "version": p.judge.version,
                    "seconds": round(time.monotonic() - started, 1),
                },
            )

    def offers(self) -> list[JudgeOffer]:
        return [JudgeOffer(j.name, j.version, spellings(j.wake_words)) for j in self.ready.values()]

    # -- loop -----------------------------------------------------------------

    def _wait(self, seconds: float) -> None:
        self.idle = True
        try:
            self.stop.wait(seconds)
        finally:
            self.idle = False

    def _beat(self) -> None:
        if self.heartbeat is not None:
            try:
                self.heartbeat.touch()
            except OSError:
                log.debug("cannot write the heartbeat file", extra={"path": str(self.heartbeat)})

    def run(self, *, once: bool = False) -> int:
        """Run until stopped. With `once`, make one claim, judge what it
        returns and exit: 0 on success, 1 if the parent could not be used."""
        log.info(
            "worker starting",
            extra={"judges": sorted(self.pending), "batch": self.batch, "once": once},
        )
        try:
            while not self.stop.is_set():
                self._beat()
                self.prepare_due()
                if not self.ready:
                    if once:
                        log.error("no judge could be prepared")
                        return 1
                    self._wait(
                        min((p.next_try for p in self.pending.values()), default=10.0)
                        - self.clock()
                    )
                    continue
                ok = self.cycle(once=once)
                if once:
                    return 0 if ok else 1
        except Interrupted:
            pass
        log.info("worker stopped", extra={"jobs": self.stats.jobs, "results": self.stats.results})
        return 0

    def cycle(self, *, once: bool = False) -> bool:
        """One claim and the jobs it returns. False when the parent could not
        be used (the backoff has already been waited unless `once`)."""
        try:
            self.idle = True
            try:
                jobs = self.client.claim(self.offers(), self.batch, self.wait_seconds)
            finally:
                self.idle = False
        except (Unreachable, NotEnabled, Unauthorised, ProtocolMismatch, ParentError) as e:
            self._failures += 1
            refused = not isinstance(e, Unreachable)
            delay = BACKOFF_MAX if refused else backoff(self._failures)
            level = logging.ERROR if refused or self._connected else logging.WARNING
            log.log(level, "cannot claim jobs", extra={"error": str(e), "retryIn": round(delay, 1)})
            self._connected = False
            self.stats.errors.append(str(e))
            if not once:
                self._wait(delay)
            return False
        if not self._connected:
            log.info("connected to the parent", extra={"judges": [o.name for o in self.offers()]})
            self._connected = True
        self._failures = 0
        self.stats.claims += 1
        for job in jobs:
            if self.stop.is_set():
                log.info(
                    "stopping; unstarted jobs return when their lease ends", extra={"job": job.id}
                )
                break
            self.process(job)
            self._beat()
        return True

    # -- one job --------------------------------------------------------------

    def process(self, job: Job) -> None:
        if _expired(job.lease_expires_at):
            log.warning("lease expired before the job started; skipping", extra={"job": job.id})
            return
        started = time.monotonic()
        try:
            audio = self.client.audio(job.clip_id)
        except Gone as e:
            log.warning("clip audio is gone; skipping", extra={"job": job.id, "error": str(e)})
            return
        except ParentError as e:
            log.warning(
                "cannot fetch clip audio; it returns when the lease ends",
                extra={"job": job.id, "error": str(e)},
            )
            return

        names = [n for n in job.judges if n in self.ready]
        skipped = sorted(set(job.judges) - set(names))
        if skipped:
            log.warning(
                "job asks for judges this worker does not have ready",
                extra={"job": job.id, "judges": skipped},
            )
        results: list[Result] = []
        try:
            clip = Clip(job.wake_word, read_wav(audio))
        except InvalidAudio as e:
            for name in names:
                j = self.ready[name]
                results.append(
                    Result(name, j.version, JudgeResult("abstain", detail=f"invalid audio: {e}"), 0)
                )
        else:
            for name in names:
                results.append(self.run_judge(self.ready[name], clip, job))

        if results:
            self.post(job, results)
        self.stats.jobs += 1
        log.info(
            "judged clip",
            extra={
                "job": job.id,
                "clip": job.clip_id,
                "wakeWord": job.wake_word,
                "verdicts": {r.judge: r.result.verdict for r in results},
                "ms": round(1000 * (time.monotonic() - started)),
            },
        )

    def run_judge(self, judge: Judge, clip: Clip, job: Job) -> Result:
        t0 = time.perf_counter()
        try:
            result = judge.judge(clip)
        except Exception as e:
            log.exception("judge crashed on a clip", extra={"judge": judge.name, "job": job.id})
            result = JudgeResult(
                "abstain", detail=f"judge error: {e.__class__.__name__}: {e}"[:500]
            )
        ms = round(1000 * (time.perf_counter() - t0))
        if result.verdict == "abstain":
            self.stats.abstained += 1
        return Result(judge.name, judge.version, result, ms)

    def post(self, job: Job, results: list[Result]) -> None:
        for attempt in range(POST_ATTEMPTS):
            try:
                self.client.post_results(job.id, results)
            except (LeaseLost, Gone) as e:
                self.stats.lease_lost += 1
                log.warning(
                    "results not accepted: the lease was lost",
                    extra={"job": job.id, "error": str(e)},
                )
                return
            except Unreachable as e:
                if attempt + 1 == POST_ATTEMPTS or self.stop.is_set():
                    log.error(
                        "could not post results; the clip returns when its lease ends",
                        extra={"job": job.id, "error": str(e)},
                    )
                    return
                self.stop.wait(backoff(attempt))
                continue
            except ParentError as e:
                log.error("results refused", extra={"job": job.id, "error": str(e)})
                return
            self.stats.results += len(results)
            return


def spellings(wake_words: frozenset[str] | None) -> list[str] | None:
    """The wake words to offer. The parent matches a clip's wake word,
    lowercased, exactly, and devices write two-word wake words with a space
    or an underscore ("hey jarvis", "hey_jarvis"), so offer both."""
    if wake_words is None:
        return None
    return sorted({form for w in wake_words for form in (w, w.replace(" ", "_"))})


def _expired(lease_expires_at: str) -> bool:
    try:
        expires = datetime.fromisoformat(lease_expires_at)
    except ValueError:
        return False
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    return expires <= datetime.now(UTC)
