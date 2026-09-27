from __future__ import annotations

import io

import pytest

from pipeline.store import blobstore


def test_cache_write_retries_twice_before_succeeding(monkeypatch) -> None:
    calls = 0

    class Client:
        def put_object(self, **_kwargs) -> None:
            nonlocal calls
            calls += 1
            if calls < 3:
                raise OSError("temporary B2 failure")

    monkeypatch.setattr(blobstore, "_client", Client())
    monkeypatch.setattr(blobstore.time, "sleep", lambda _seconds: None)

    blobstore.write_bytes("derived-text/source/result.json", b"{}", "application/json")

    assert calls == 3


def test_cache_write_raises_after_three_attempts(monkeypatch) -> None:
    calls = 0

    class Client:
        def put_object(self, **_kwargs) -> None:
            nonlocal calls
            calls += 1
            raise OSError("B2 unavailable")

    monkeypatch.setattr(blobstore, "_client", Client())
    monkeypatch.setattr(blobstore.time, "sleep", lambda _seconds: None)

    with pytest.raises(OSError, match="B2 unavailable"):
        blobstore.write_bytes(
            "derived-text/source/result.json", b"{}", "application/json"
        )

    assert calls == 3


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
