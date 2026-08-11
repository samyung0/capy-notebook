"""Offline unit tests for the Modal MinerU client (no network).

The client never sees document bytes — it brokers presigned URLs and then
unpacks a zip that a remote service produced. Everything worth testing is in
that handoff: artifact addressing (which is what makes re-ingest free), the
validation of an artifact that arrived from outside this process, and the
recovery path when a cached artifact turns out to be corrupt.
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from pipeline.parse import modal_parser


def _descriptor(**overrides) -> dict:
    base = {
        "blob_path": "sources/blob_1.pdf",
        "file_id": "f_1",
        "source_etag": "etag-1",
        "source_size": 123,
    }
    base.update(overrides)
    return modal_parser.source_descriptor(**base)


def _artifact_zip(
    path: Path,
    *,
    fingerprint: str,
    content_list=None,
    extra: dict[str, str] | None = None,
    parser_version: str | None = None,
    schema: str | None = None,
) -> bytes:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "schema": schema or modal_parser.ARTIFACT_SCHEMA,
                    "parser_version": parser_version or modal_parser.PARSER_VERSION,
                    "source_fingerprint": fingerprint,
                }
            ),
        )
        archive.writestr(
            "content_list.json",
            json.dumps(
                content_list
                if content_list is not None
                else [{"type": "text", "text": "Hello", "page_idx": 0}]
            ),
        )
        for name, body in (extra or {}).items():
            archive.writestr(name, body)
    return path.read_bytes()


# --------------------------------------------------------------- addressing


def test_artifact_key_is_stable_and_versioned():
    descriptor = _descriptor()
    key1, fingerprint1 = modal_parser.artifact_identity(descriptor)
    key2, fingerprint2 = modal_parser.artifact_identity(descriptor)

    assert (key1, fingerprint1) == (key2, fingerprint2)
    assert key1 == f"parsed/f_1/{modal_parser.PARSER_VERSION}/{fingerprint1}.zip"


def test_a_changed_source_addresses_a_different_artifact():
    """The etag is what stops a re-upload under the same key replaying a stale
    parse."""
    _, original = modal_parser.artifact_identity(_descriptor())
    _, reuploaded = modal_parser.artifact_identity(_descriptor(source_etag="etag-2"))
    _, resized = modal_parser.artifact_identity(_descriptor(source_size=999))

    assert len({original, reuploaded, resized}) == 3


def test_parse_method_participates_in_the_fingerprint(monkeypatch):
    _, before = modal_parser.artifact_identity(_descriptor())
    monkeypatch.setattr(modal_parser.cfg, "parse_method", "ocr")
    _, after = modal_parser.artifact_identity(_descriptor())

    assert before != after


# ------------------------------------------------------------- request path


class _Resp:
    def __init__(self, status_code: int, payload=None, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


def test_a_cache_hit_never_calls_modal(monkeypatch):
    monkeypatch.setattr(
        modal_parser.cfg, "modal_parse_url", "https://modal.test/file_parse"
    )
    key, fingerprint = modal_parser.artifact_identity(_descriptor())
    monkeypatch.setattr(
        modal_parser.blobstore, "object_info", lambda _k: {"size": 10, "etag": "e"}
    )

    def _explode(*_a, **_k):
        raise AssertionError("modal must not be called on a cache hit")

    monkeypatch.setattr(modal_parser.requests, "post", _explode)

    artifact = modal_parser._request_artifact(_descriptor(), "doc.pdf")

    assert artifact["key"] == key
    assert artifact["fingerprint"] == fingerprint
    assert artifact["cached"] is True


def test_missing_modal_url_is_a_configuration_error(monkeypatch):
    monkeypatch.setattr(modal_parser.cfg, "modal_parse_url", "")

    with pytest.raises(modal_parser.ModalParseError, match="MODAL_PARSE_URL"):
        modal_parser._request_artifact(_descriptor(), "doc.pdf")


def test_http_error_is_wrapped(monkeypatch):
    monkeypatch.setattr(
        modal_parser.cfg, "modal_parse_url", "https://modal.test/file_parse"
    )
    monkeypatch.setattr(modal_parser.blobstore, "object_info", lambda _k: None)
    monkeypatch.setattr(modal_parser.blobstore, "presign_get", lambda _k: "https://get")
    monkeypatch.setattr(
        modal_parser.blobstore, "presign_put", lambda _k, _t: "https://put"
    )
    monkeypatch.setattr(
        modal_parser.requests, "post", lambda *a, **k: _Resp(500, text="boom")
    )

    with pytest.raises(modal_parser.ModalParseError, match="modal parse 500"):
        modal_parser._request_artifact(_descriptor(), "doc.pdf")


def test_a_mismatched_artifact_key_is_rejected(monkeypatch):
    """The key is derived locally; a service returning a different one is either
    misconfigured or writing somewhere we would never read."""
    monkeypatch.setattr(
        modal_parser.cfg, "modal_parse_url", "https://modal.test/file_parse"
    )
    monkeypatch.setattr(modal_parser.blobstore, "object_info", lambda _k: None)
    monkeypatch.setattr(modal_parser.blobstore, "presign_get", lambda _k: "https://get")
    monkeypatch.setattr(
        modal_parser.blobstore, "presign_put", lambda _k, _t: "https://put"
    )
    monkeypatch.setattr(
        modal_parser.requests,
        "post",
        lambda *a, **k: _Resp(200, {"artifact": {"key": "parsed/somewhere/else.zip"}}),
    )

    with pytest.raises(modal_parser.ModalParseError, match="unexpected artifact key"):
        modal_parser._request_artifact(_descriptor(), "doc.pdf")


# -------------------------------------------------------------- unpacking


def _install_artifact(monkeypatch, tmp_path: Path, **zip_kwargs) -> dict:
    fingerprint = zip_kwargs.pop("fingerprint", "fp-1")
    blob = _artifact_zip(
        tmp_path / "artifact.zip", fingerprint=fingerprint, **zip_kwargs
    )
    monkeypatch.setattr(
        modal_parser.blobstore,
        "download_to",
        lambda _key, destination: destination.write_bytes(blob),
    )
    return {
        "key": "parsed/f_1/x.zip",
        "fingerprint": fingerprint,
        "sha256": hashlib.sha256(blob).hexdigest(),
    }


def test_extract_writes_the_bundle(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(
        monkeypatch, tmp_path, extra={"images/fig1.png": "not-really-a-png"}
    )
    raw = tmp_path / "raw"
    raw.mkdir()

    modal_parser._extract(artifact, raw)

    assert json.loads((raw / "content_list.json").read_text())[0]["text"] == "Hello"
    assert (raw / "images" / "fig1.png").is_file()


def test_extract_rejects_path_traversal(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(
        monkeypatch, tmp_path, extra={"../outside.txt": "owned"}
    )
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError, match="unsafe path"):
        modal_parser._extract(artifact, raw)
    assert not (tmp_path / "outside.txt").exists()


def test_extract_rejects_a_checksum_mismatch(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(monkeypatch, tmp_path)
    artifact["sha256"] = "0" * 64
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError, match="checksum mismatch"):
        modal_parser._extract(artifact, raw)


def test_extract_rejects_a_stale_parser_version(tmp_path: Path, monkeypatch):
    """A bundle from an older parser would silently degrade citations, so it is
    a cache miss rather than a usable artifact."""
    artifact = _install_artifact(monkeypatch, tmp_path, parser_version="mineru-0.1")
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError, match="version mismatch"):
        modal_parser._extract(artifact, raw)


def test_extract_rejects_an_artifact_from_another_source(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(monkeypatch, tmp_path, fingerprint="fp-other")
    artifact["fingerprint"] = "fp-expected"
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError, match="source mismatch"):
        modal_parser._extract(artifact, raw)


def test_parse_to_bundle_discards_a_corrupt_cached_artifact(
    tmp_path: Path, monkeypatch
):
    """A cached zip that will not open must be deleted, not retried forever."""
    good = _artifact_zip(tmp_path / "good.zip", fingerprint="ignored")
    deleted: list[str] = []
    attempts = {"n": 0}

    def _download(_key, destination: Path):
        attempts["n"] += 1
        destination.write_bytes(b"not a zip" if attempts["n"] == 1 else good)

    monkeypatch.setattr(modal_parser.blobstore, "download_to", _download)
    monkeypatch.setattr(
        modal_parser.blobstore, "delete", lambda key: deleted.append(key)
    )
    monkeypatch.setattr(
        modal_parser,
        "_request_artifact",
        lambda *_a: {"key": "parsed/f_1/x.zip", "cached": attempts["n"] == 0},
    )

    content_list, key, _fingerprint = modal_parser.parse_to_bundle(
        _descriptor(), "doc.pdf", tmp_path / "raw"
    )

    assert deleted == ["parsed/f_1/x.zip"]
    assert content_list[0]["text"] == "Hello"
    assert key == "parsed/f_1/x.zip"


def test_parse_to_bundle_propagates_a_fresh_artifact_failure(
    tmp_path: Path, monkeypatch
):
    """Only a *cached* artifact is worth discarding and retrying; a freshly
    produced broken one means the parser is broken."""
    monkeypatch.setattr(
        modal_parser.blobstore,
        "download_to",
        lambda _key, destination: destination.write_bytes(b"not a zip"),
    )
    monkeypatch.setattr(
        modal_parser,
        "_request_artifact",
        lambda *_a: {"key": "parsed/f_1/x.zip", "cached": False},
    )

    with pytest.raises(zipfile.BadZipFile):
        modal_parser.parse_to_bundle(_descriptor(), "doc.pdf", tmp_path / "raw")
