"""The model cache: pinned downloads, verification and offline errors.

Served from an in-process HTTP server; nothing here reaches the network.
"""

from __future__ import annotations

import hashlib
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from wakewright_worker.models import ModelCache, ModelFile, ModelUnavailable

PAYLOAD = b"model bytes " * 1000


class Server:
    def __init__(self) -> None:
        self.files: dict[str, bytes] = {"/m.onnx": PAYLOAD, "/redirect": b""}
        self.requests = 0
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                pass

            def do_GET(self) -> None:
                server.requests += 1
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("location", "/m.onnx")
                    self.end_headers()
                    return
                data = server.files.get(self.path)
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, args=(0.01,), daemon=True).start()

    def url(self, path: str) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host!s}:{port}{path}"


@pytest.fixture
def server() -> Iterator[Server]:
    s = Server()
    yield s
    s.httpd.shutdown()


def spec(url: str, data: bytes = PAYLOAD, **overrides: Any) -> ModelFile:
    fields: dict[str, Any] = {
        "source": "src",
        "revision": "rev1",
        "name": "m.onnx",
        "url": url,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
    } | overrides
    return ModelFile(**fields)


def test_downloads_once_into_source_and_revision(server: Server, tmp_path: Path) -> None:
    cache = ModelCache(tmp_path)
    s = spec(server.url("/m.onnx"))
    path = cache.ensure(s)
    assert path == tmp_path / "models" / "src" / "rev1" / "m.onnx"
    assert path.read_bytes() == PAYLOAD
    assert cache.ensure(s) == path
    assert server.requests == 1
    assert list(path.parent.iterdir()) == [path]


def test_follows_redirects(server: Server, tmp_path: Path) -> None:
    assert ModelCache(tmp_path).ensure(spec(server.url("/redirect"))).read_bytes() == PAYLOAD


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"sha256": "0" * 64}, "has SHA-256"),
        ({"size": len(PAYLOAD) + 1}, "expected"),
        ({"size": 10}, "larger than the pinned"),
    ],
)
def test_a_changed_upstream_file_is_refused(
    server: Server, tmp_path: Path, overrides: dict[str, Any], message: str
) -> None:
    cache = ModelCache(tmp_path)
    s = spec(server.url("/m.onnx"), **overrides)
    with pytest.raises(ModelUnavailable, match=message):
        cache.ensure(s)
    # Nothing half-written is left behind, so the next start tries again.
    assert list((tmp_path / "models" / "src" / "rev1").iterdir()) == []


def test_http_errors_are_reported(server: Server, tmp_path: Path) -> None:
    with pytest.raises(ModelUnavailable, match="HTTP 404"):
        ModelCache(tmp_path).ensure(spec(server.url("/missing")))


def test_offline_gives_a_clear_error(tmp_path: Path) -> None:
    # Port 9 on localhost: nothing listens, the connection is refused.
    with pytest.raises(ModelUnavailable, match="needs network access the first time"):
        ModelCache(tmp_path).ensure(spec("http://127.0.0.1:9/m.onnx"))


def test_verify_removes_a_corrupted_file(server: Server, tmp_path: Path) -> None:
    cache = ModelCache(tmp_path)
    s = spec(server.url("/m.onnx"))
    path = cache.ensure(s)
    assert cache.verify(s)
    path.write_bytes(b"x" * len(PAYLOAD))
    assert cache.is_cached(s)  # same size: only a hash notices
    assert not cache.verify(s)
    assert not path.exists()
    assert cache.ensure(s).read_bytes() == PAYLOAD


def test_unwritable_cache_dir(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("")
    with pytest.raises(ModelUnavailable, match="CACHE_DIR"):
        ModelCache(blocker).ensure(spec("http://127.0.0.1:9/m.onnx"))


def test_pinned_specs_are_well_formed() -> None:
    """Every built-in model is pinned to a revision with a full SHA-256."""
    from wakewright_worker.judges.microwakeword import MicroWakeWordJudge
    from wakewright_worker.judges.openwakeword import OpenWakeWordJudge
    from wakewright_worker.judges.stt import SpeechToTextJudge

    cache = ModelCache(Path("unused"))
    for judge in (OpenWakeWordJudge(cache), MicroWakeWordJudge(cache), SpeechToTextJudge(cache)):
        files = judge.model_files()
        assert files
        for f in files:
            assert len(f.sha256) == 64
            assert int(f.sha256, 16) >= 0
            assert f.size > 0
            assert f.url.startswith("https://")
            assert f.revision in f.url or f.revision[:7] in f.url
