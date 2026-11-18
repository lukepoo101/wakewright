"""`wakewright-worker`: the console entry point.

    wakewright-worker [run] [--once]   pull and judge jobs from the parent
    wakewright-worker download-models  fill the model cache, then exit
    wakewright-worker self-test        run every judge on generated audio
    wakewright-worker judge FILE...    judge local WAV files (no parent)
    wakewright-worker healthcheck      exit 0 if a running worker is alive

Configuration is `WAKEWRIGHT_WORKER__*` environment variables (docs/worker.md).
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import tempfile
import threading
import time
from collections.abc import Sequence
from pathlib import Path
from types import FrameType

from wakewright_worker import __version__, config
from wakewright_worker import log as logsetup
from wakewright_worker.audio import Clip, InvalidAudio, noise, read_wav, silence, tone
from wakewright_worker.judges import Judge, factories
from wakewright_worker.judges.fake import fake_judges
from wakewright_worker.models import ModelCache, ModelUnavailable

log = logging.getLogger("wakewright_worker")

HEARTBEAT = Path(tempfile.gettempdir()) / "wakewright-worker.alive"
HEARTBEAT_MAX_AGE = 300
# Each judge must answer a 3 s clip within this on a CI runner (4 vCPUs).
SELF_TEST_BUDGET_MS = 10_000


def build_judges(cfg: config.Config, names: Sequence[str] | None = None) -> list[Judge]:
    cache = ModelCache(cfg.cache_dir)
    available = factories()
    return [available[n](cache) for n in (names or cfg.judges)]


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="wakewright-worker", description="Wakewright worker")
    p.add_argument("--version", action="version", version=f"wakewright-worker {__version__}")
    sub = p.add_subparsers(dest="command")
    run = sub.add_parser("run", help="pull and judge jobs from the parent (the default)")
    run.add_argument("--once", action="store_true", help="make one claim, judge it and exit")
    run.add_argument(
        "--pairing",
        metavar="STRING",
        help="the pairing string from the parent's Workers tab (or set WAKEWRIGHT_WORKER__PAIRING)",
    )
    run.add_argument(
        "--fake-judges",
        action="store_true",
        help="for tests: judges that load no model and answer from a hash of the audio",
    )
    dl = sub.add_parser("download-models", help="download every enabled judge's models")
    dl.add_argument("--verify", action="store_true", help="hash cached files again")
    st = sub.add_parser("self-test", help="run every enabled judge on generated audio")
    st.add_argument("--wake-word", default="alexa")
    jd = sub.add_parser("judge", help="judge local WAV files without a parent")
    jd.add_argument("files", nargs="+", type=Path)
    jd.add_argument("--wake-word", default="alexa")
    jd.add_argument("--json", action="store_true", help="one JSON object per file")
    sub.add_parser("healthcheck", help="exit 0 if a worker in this container is alive")
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    command = args.command or "run"
    if command == "healthcheck":
        return healthcheck()
    try:
        cfg = config.load(need_parent=command == "run", pairing=getattr(args, "pairing", None))
    except config.ConfigError as e:
        print(f"wakewright-worker: {e}", file=sys.stderr)
        return 2
    logsetup.setup(cfg.log_format, cfg.log_level)
    if command == "run":
        return run(cfg, once=getattr(args, "once", False), fake=getattr(args, "fake_judges", False))
    if command == "download-models":
        return download_models(cfg, verify=args.verify)
    if command == "self-test":
        return self_test(cfg, args.wake_word)
    return judge_files(cfg, args.files, args.wake_word, as_json=args.json)


def run(cfg: config.Config, *, once: bool = False, fake: bool = False) -> int:
    from wakewright_worker.client import ParentClient  # noqa: PLC0415
    from wakewright_worker.loop import Interrupted, Worker  # noqa: PLC0415

    log.info("configuration", extra={"config": repr(cfg), "version": __version__})
    stop = threading.Event()
    with ParentClient(cfg.parent_url, cfg.token, cfg.name) as client:
        worker = Worker(
            client,
            fake_judges() if fake else build_judges(cfg),
            batch=cfg.batch,
            wait_seconds=cfg.wait_seconds,
            stop=stop,
            heartbeat=HEARTBEAT,
        )

        def on_signal(signum: int, _frame: FrameType | None) -> None:
            if not stop.is_set():
                log.info("stop requested", extra={"signal": signal.Signals(signum).name})
            stop.set()
            # A long poll can take WAIT_SECONDS to return; break out of it
            # now. A job in progress is finished and posted first.
            if worker.idle:
                raise Interrupted

        for name in ("SIGTERM", "SIGINT", "SIGBREAK"):
            if hasattr(signal, name):
                signal.signal(getattr(signal, name), on_signal)
        try:
            return worker.run(once=once)
        except Interrupted:
            log.info("worker stopped")
            return 0
        finally:
            HEARTBEAT.unlink(missing_ok=True)


def healthcheck() -> int:
    try:
        age = time.time() - HEARTBEAT.stat().st_mtime
    except OSError:
        print("no running worker found", file=sys.stderr)
        return 1
    if age > HEARTBEAT_MAX_AGE:
        print(f"the worker loop last ran {age:.0f} s ago", file=sys.stderr)
        return 1
    return 0


def download_models(cfg: config.Config, *, verify: bool = False) -> int:
    cache = ModelCache(cfg.cache_dir)
    failed = 0
    for judge in build_judges(cfg):
        for spec in judge.model_files():
            try:
                if verify and cache.is_cached(spec) and not cache.verify(spec):
                    log.warning(
                        "re-downloading a file that failed verification", extra={"file": spec.name}
                    )
                path = cache.ensure(spec)
            except ModelUnavailable as e:
                failed += 1
                log.error("model download failed", extra={"judge": judge.name, "error": str(e)})
                continue
            log.info("model file cached", extra={"judge": judge.name, "path": str(path)})
    print(f"model cache: {cache.root}", file=sys.stderr)
    return 1 if failed else 0


def _prepare(judges: list[Judge]) -> bool:
    ok = True
    for j in judges:
        t0 = time.perf_counter()
        try:
            j.prepare()
        except Exception as e:  # noqa: BLE001
            log.error(
                "judge could not be prepared",
                extra={"judge": j.name, "error": f"{e.__class__.__name__}: {e}"},
            )
            ok = False
        else:
            log.info(
                "judge ready",
                extra={
                    "judge": j.name,
                    "version": j.version,
                    "seconds": round(time.perf_counter() - t0, 1),
                },
            )
    return ok


def self_test(cfg: config.Config, wake_word: str) -> int:
    """Every enabled judge must load and answer `no` for generated audio
    that contains no speech, within SELF_TEST_BUDGET_MS per clip."""
    judges = build_judges(cfg)
    if not _prepare(judges):
        return 1
    samples = {
        "silence": silence(),
        "white noise": noise(),
        "440 Hz tone": tone(),
    }
    failures = 0
    print(f"{'judge':14} {'audio':12} {'verdict':8} {'score':>7} {'ms':>6}")
    for j in judges:
        for label, x in samples.items():
            t0 = time.perf_counter()
            r = j.judge(Clip(wake_word, x))
            ms = round(1000 * (time.perf_counter() - t0))
            bad = r.verdict != "no" or ms > SELF_TEST_BUDGET_MS
            failures += bad
            score = "" if r.score is None else f"{r.score:.3f}"
            print(
                f"{j.name:14} {label:12} {r.verdict:8} {score:>7} {ms:>6}{'  FAIL' if bad else ''}"
            )
    print("self-test " + ("passed" if not failures else f"failed ({failures})"))
    return 1 if failures else 0


def judge_files(cfg: config.Config, files: list[Path], wake_word: str, *, as_json: bool) -> int:
    judges = build_judges(cfg)
    if not _prepare(judges):
        return 1
    for path in files:
        try:
            clip = Clip(wake_word, read_wav(path.read_bytes()))
        except (OSError, InvalidAudio) as e:
            print(f"{path}: {e}", file=sys.stderr)
            continue
        row: dict[str, object] = {"file": path.name}
        for j in judges:
            t0 = time.perf_counter()
            r = j.judge(clip)
            row[j.name] = {
                "verdict": r.verdict,
                "score": r.score,
                "transcript": r.transcript,
                "detail": r.detail,
                "ms": round(1000 * (time.perf_counter() - t0)),
            }
        if as_json:
            print(json.dumps(row), flush=True)
        else:
            print(
                path.name,
                *(f"{j.name}={_brief(row[j.name])}" for j in judges),
                flush=True,
            )
    return 0


def _brief(cell: object) -> str:
    assert isinstance(cell, dict)
    parts = [str(cell["verdict"])]
    if cell["score"] is not None:
        parts.append(f"{cell['score']:.3f}")
    if cell["transcript"] is not None:
        parts.append(repr(cell["transcript"]))
    parts.append(f"{cell['ms']}ms")
    return "/".join(parts)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
