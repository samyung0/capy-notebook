from __future__ import annotations

import io
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from botocore.exceptions import ClientError

from pipeline.store import blobstore


class _FailingB2(BaseHTTPRequestHandler):
    """A B2 stand-in that answers every request 500 and counts them."""

    protocol_version = "HTTP/1.1"

    def do_PUT(self) -> None:
        self.server.requests += 1
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.send_response(500)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_args) -> None:
        pass


@pytest.fixture
def failing_b2(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FailingB2)
    server.requests = 0
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{server.server_port}"
    monkeypatch.setattr(blobstore.cfg, "b2_endpoint", endpoint)
    monkeypatch.setattr(blobstore.cfg, "b2_region", "us-east-1")
    monkeypatch.setattr(blobstore.cfg, "b2_bucket", "capy")
    monkeypatch.setattr(blobstore.cfg, "b2_key_id", "key")
    monkeypatch.setattr(blobstore.cfg, "b2_app_key", "secret")
    monkeypatch.setattr(blobstore, "_client", None)
    monkeypatch.setattr(blobstore, "_once_client", None)
    yield server
    server.shutdown()
    server.server_close()


def test_a_cache_write_sends_three_puts_in_all(failing_b2) -> None:
    with pytest.raises(ClientError):
        blobstore.write_bytes(
            "derived-text/source/result.json", b"{}", "application/json"
        )

    assert failing_b2.requests == 3


def test_a_thumbnail_put_is_a_single_attempt(failing_b2) -> None:
    with pytest.raises(ClientError):
        blobstore.put_object("thumbs/f_1/aa.webp", b"webp", "image/webp", "no-cache")

    assert failing_b2.requests == 1


def test_cache_download_is_bounded_and_cleans_a_partial_file(
    tmp_path, monkeypatch
) -> None:
    destination = tmp_path / "partial.zip"

    class Client:
        def get_object(self, **_kwargs):
            return {"Body": io.BytesIO(b"too large")}

    monkeypatch.setattr(blobstore, "_client", Client())

    with pytest.raises(ValueError, match="configured byte limit"):
        blobstore.download_file("sources/document.pdf", str(destination), 3)

    assert not destination.exists()


def test_cache_byte_read_enforces_its_bound_and_closes_body(monkeypatch) -> None:
    body = io.BytesIO(b"too large")

    class Client:
        def get_object(self, **_kwargs):
            return {"Body": body}

    monkeypatch.setattr(blobstore, "_client", Client())

    with pytest.raises(ValueError, match="configured byte limit"):
        blobstore.read_bytes("previews/source.pdf", max_bytes=3)

    assert body.closed
