"""Model files: pinned upstream URLs, downloaded once into the cache directory.

No model is part of the repository or the image. Each file is named by its
source, a pinned revision and its SHA-256; it is downloaded on first use to
a temporary file next to its final path, checked against its size and hash,
then renamed into place. A file at its final path has therefore always been
verified. `wakewright-worker download-models` warms the cache ahead of time
and, with `--verify`, hashes every cached file again.

The licences differ per source and are listed in docs/models.md. The
openWakeWord models are CC BY-NC-SA 4.0: never redistribute them.
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

CHUNK = 1 << 20
USER_AGENT = "wakewright-worker (+https://github.com/lukepoo101/wakewright)"


class ModelUnavailable(RuntimeError):
    """A model file could not be downloaded or failed verification."""


@dataclass(frozen=True)
class ModelFile:
    """One pinned file. `source` and `revision` name its cache directory."""

    source: str
    revision: str
    name: str
    url: str
    sha256: str
    size: int

    @property
    def relative_path(self) -> Path:
        return Path(self.source) / self.revision / self.name


# Downloads fetch over the network with this client factory; tests replace it.
ClientFactory = Callable[[], httpx.Client]


def _default_client() -> httpx.Client:
    return httpx.Client(
        follow_redirects=True,
        timeout=httpx.Timeout(30.0, read=120.0),
        headers={"user-agent": USER_AGENT},
    )


class ModelCache:
    def __init__(self, root: Path, client_factory: ClientFactory = _default_client) -> None:
        self.root = root / "models"
        self._client_factory = client_factory

    def path(self, spec: ModelFile) -> Path:
        return self.root / spec.relative_path

    def is_cached(self, spec: ModelFile) -> bool:
        p = self.path(spec)
        return p.is_file() and p.stat().st_size == spec.size

    def ensure(self, spec: ModelFile) -> Path:
        """The verified local path of `spec`, downloading it if needed."""
        if self.is_cached(spec):
            return self.path(spec)
        return self._download(spec)

    def ensure_all(self, specs: Iterable[ModelFile]) -> list[Path]:
        return [self.ensure(s) for s in specs]

    def verify(self, spec: ModelFile) -> bool:
        """Hash a cached file again. A mismatch deletes it so it is fetched anew."""
        p = self.path(spec)
        if not p.is_file():
            return False
        if _sha256_file(p) == spec.sha256 and p.stat().st_size == spec.size:
            return True
        log.warning("cached model file failed verification, removing it", extra={"path": str(p)})
        p.unlink(missing_ok=True)
        return False

    def _download(self, spec: ModelFile) -> Path:
        final = self.path(spec)
        try:
            final.parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise ModelUnavailable(
                f"cannot create the model cache directory {final.parent}: {e}. "
                "Set WAKEWRIGHT_WORKER__CACHE_DIR to a writable directory."
            ) from None
        log.info(
            "downloading model file",
            extra={"model": f"{spec.source}/{spec.name}", "url": spec.url, "bytes": spec.size},
        )
        started = time.monotonic()
        fd, tmp_name = tempfile.mkstemp(prefix=f".{spec.name}.", suffix=".part", dir=final.parent)
        tmp = Path(tmp_name)
        try:
            digest = hashlib.sha256()
            written = 0
            next_report = 0.1
            with os.fdopen(fd, "wb") as out, self._client_factory() as client:
                with client.stream("GET", spec.url) as r:
                    if r.status_code != 200:
                        raise ModelUnavailable(
                            f"downloading {spec.url} failed: HTTP {r.status_code}"
                        )
                    for chunk in r.iter_bytes(CHUNK):
                        out.write(chunk)
                        digest.update(chunk)
                        written += len(chunk)
                        if written > spec.size:
                            raise ModelUnavailable(
                                f"{spec.url} is larger than the pinned {spec.size} bytes"
                            )
                        if spec.size > 50 * CHUNK and written >= next_report * spec.size:
                            log.info(
                                "download progress",
                                extra={"model": spec.name, "percent": round(100 * next_report)},
                            )
                            next_report += 0.1
                out.flush()
                os.fsync(out.fileno())
            if written != spec.size:
                raise ModelUnavailable(
                    f"{spec.url} was {written} bytes, expected {spec.size}; "
                    "the download was cut short or the upstream file changed"
                )
            actual = digest.hexdigest()
            if actual != spec.sha256:
                raise ModelUnavailable(
                    f"{spec.url} has SHA-256 {actual}, expected {spec.sha256}; "
                    "the upstream file changed, so it was not used"
                )
            # mkstemp makes the file private; models are not secrets, and
            # other users (a container's uid) may share the cache.
            tmp.chmod(0o644)
            tmp.replace(final)
        except httpx.HTTPError as e:
            raise ModelUnavailable(
                f"cannot download {spec.url}: {e.__class__.__name__}: {e}. "
                "The worker needs network access the first time each model is used, or a cache "
                "warmed with `wakewright-worker download-models` "
                "(set WAKEWRIGHT_WORKER__CACHE_DIR to reuse one)."
            ) from None
        finally:
            tmp.unlink(missing_ok=True)
        log.info(
            "model file ready",
            extra={
                "model": f"{spec.source}/{spec.name}",
                "seconds": round(time.monotonic() - started, 1),
            },
        )
        return final


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()
