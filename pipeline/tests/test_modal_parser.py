"""Offline unit tests for the Modal parse client (no network).

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

FAST_VERSION = modal_parser.PARSER_VERSIONS[modal_parser.ROUTE_FAST]


def _descriptor(**overrides) -> dict:
    base = {
        "blob_path": "sources/blob_1.pdf",
        "source_sha256": "aa" * 32,
        "route": modal_parser.ROUTE_FAST,
    }
    base.update(overrides)
    return modal_parser.source_descriptor(
        blob_path=base["blob_path"],
        source_sha256=base["source_sha256"],
        route=base["route"],
    )


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
                    "parser_version": parser_version or FAST_VERSION,
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
    assert (
        key1
        == f"parsed/{descriptor['source_sha256']}/{FAST_VERSION}/{fingerprint1}.zip"
    )


def test_a_changed_source_addresses_a_different_artifact():
    """The source hash is what stops a different document replaying a stale parse."""
    _, original = modal_parser.artifact_identity(_descriptor())
    _, reuploaded = modal_parser.artifact_identity(_descriptor(source_sha256="bb" * 32))

    assert original != reuploaded


def test_parse_method_participates_in_the_fingerprint(monkeypatch):
    _, before = modal_parser.artifact_identity(_descriptor())
    monkeypatch.setattr(modal_parser.cfg, "parse_method", "txt")
    _, after = modal_parser.artifact_identity(_descriptor())

    assert before != after


def test_an_unknown_route_is_rejected():
    with pytest.raises(modal_parser.ModalParseError, match="unknown parse route"):
        modal_parser.artifact_identity(_descriptor(route="turbo"))


def test_a_missing_route_is_rejected_rather_than_read_as_fast():
    """A blank route must not address (and bill) a parser nobody picked."""
    with pytest.raises(modal_parser.ModalParseError, match="unknown parse route"):
        modal_parser.artifact_identity({"source_sha256": "aa" * 32})
    with pytest.raises(modal_parser.ModalParseError, match="unknown parse route"):
        modal_parser.artifact_identity(_descriptor(route=""))


# ------------------------------------------------------------- request path


class _Resp:
    def __init__(self, status_code: int, payload=None, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


@pytest.fixture
def parser_urls(monkeypatch):
    monkeypatch.setattr(
        modal_parser.cfg, "parser_url", "http://10.77.0.2:8090/file_parse"
    )


def test_a_cache_hit_never_calls_remote_parser(monkeypatch, parser_urls):
    key, fingerprint = modal_parser.artifact_identity(_descriptor())
    monkeypatch.setattr(
        modal_parser.blobstore, "object_info", lambda _k: {"size": 10, "etag": "e"}
    )

    def _explode(*_a, **_k):
        raise AssertionError("parser must not be called on a cache hit")

    monkeypatch.setattr(modal_parser.requests, "post", _explode)

    artifact = modal_parser._request_artifact(_descriptor(), "doc.pdf")

    assert artifact["key"] == key
    assert artifact["fingerprint"] == fingerprint
    assert artifact["cached"] is True


def test_missing_parser_url_is_a_configuration_error(monkeypatch):
    monkeypatch.setattr(modal_parser.cfg, "parser_url", "")

    with pytest.raises(modal_parser.ModalParseError, match="PARSER_URL"):
        modal_parser._request_artifact(_descriptor(), "doc.pdf")


def _stub_presign(monkeypatch, response) -> list[dict]:
    calls: list[dict] = []
    monkeypatch.setattr(modal_parser.blobstore, "object_info", lambda _k: None)
    monkeypatch.setattr(modal_parser.blobstore, "presign_get", lambda _k: "https://get")
    monkeypatch.setattr(
        modal_parser.blobstore, "presign_put", lambda _k, _t: "https://put"
    )

    def _post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return response

    monkeypatch.setattr(modal_parser.requests, "post", _post)
    return calls


def test_the_request_uses_the_fast_endpoint_and_version(monkeypatch, parser_urls):
    key, _ = modal_parser.artifact_identity(_descriptor())
    calls = _stub_presign(monkeypatch, _Resp(200, {"artifact": {"key": key}}))

    modal_parser._request_artifact(_descriptor(), "d.pdf")

    assert calls[0]["url"] == "http://10.77.0.2:8090/file_parse"
    assert calls[0]["json"]["parser_version"] == FAST_VERSION


def test_http_error_is_wrapped(monkeypatch, parser_urls):
    _stub_presign(monkeypatch, _Resp(500, text="boom"))

    with pytest.raises(modal_parser.ModalParseError, match="remote parse 500"):
        modal_parser._request_artifact(_descriptor(), "doc.pdf")


def test_success_records_page_and_child_cpu_measurement(monkeypatch, parser_urls):
    key, _ = modal_parser.artifact_identity(_descriptor())
    measured: list[dict] = []
    monkeypatch.setattr(
        modal_parser.obs,
        "record_parse_usage",
        lambda **values: measured.append(values),
    )
    _stub_presign(
        monkeypatch,
        _Resp(
            200,
            {
                "artifact": {"key": key},
                "_page_count": 4,
                "_ocr_page_count": 1,
                "_worker_cpu_ms": 3200,
                "_server_parse_ms": 4100,
                "_queue_ms": 250,
                "_worker_pss_bytes": 1234,
                "_parse_method": "all_rapidocr",
                "_source_format": "pdf",
            },
        ),
    )

    modal_parser._request_artifact(_descriptor(), "doc.pdf")

    assert measured[0]["pages"] == 4
    assert measured[0]["ocr_pages"] == 1
    assert measured[0]["cpu_milliseconds"] == 3200
    assert measured[0]["elapsed_milliseconds"] == 4100
    assert measured[0]["queue_milliseconds"] == 250
    assert measured[0]["worker_pss_bytes"] == 1234
    assert measured[0]["method"] == "all_rapidocr"
    assert measured[0]["source_format"] == "pdf"


def test_failed_parse_records_measurement_before_raising(monkeypatch, parser_urls):
    measured: list[dict] = []
    monkeypatch.setattr(
        modal_parser.obs,
        "record_parse_usage",
        lambda **values: measured.append(values),
    )
    _stub_presign(
        monkeypatch,
        _Resp(
            500,
            {
                "detail": "remote parse failed",
                "_page_count": 2,
                "_ocr_page_count": 2,
                "_worker_cpu_ms": 900,
                "_server_parse_ms": 1200,
            },
        ),
    )

    with pytest.raises(modal_parser.ModalParseError, match="remote parse failed"):
        modal_parser._request_artifact(_descriptor(), "doc.pdf")

    assert measured[0]["pages"] == 2
    assert measured[0]["ocr_pages"] == 2
    assert measured[0]["cpu_milliseconds"] == 900


def test_failed_parse_records_cpu_without_inventing_a_page(monkeypatch, parser_urls):
    measured: list[dict] = []
    monkeypatch.setattr(
        modal_parser.obs,
        "record_parse_usage",
        lambda **values: measured.append(values),
    )
    _stub_presign(
        monkeypatch,
        _Resp(
            500,
            {
                "detail": "page probing failed",
                "_page_count": 0,
                "_ocr_page_count": 0,
                "_worker_cpu_ms": 90,
                "_server_parse_ms": 120,
            },
        ),
    )

    with pytest.raises(modal_parser.ModalParseError, match="page probing failed"):
        modal_parser._request_artifact(_descriptor(), "broken.pdf")

    assert measured[0]["pages"] == 0
    assert measured[0]["ocr_pages"] == 0
    assert measured[0]["cpu_milliseconds"] == 90
    assert measured[0]["elapsed_milliseconds"] == 120


def test_a_mismatched_artifact_key_is_rejected(monkeypatch, parser_urls):
    """The key is derived locally; a service returning a different one is either
    misconfigured or writing somewhere we would never read."""
    _stub_presign(
        monkeypatch, _Resp(200, {"artifact": {"key": "parsed/somewhere/else.zip"}})
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

    modal_parser._extract(artifact, raw, FAST_VERSION)

    assert json.loads((raw / "content_list.json").read_text())[0]["text"] == "Hello"
    assert (raw / "images" / "fig1.png").is_file()


def test_extract_rejects_path_traversal(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(
        monkeypatch, tmp_path, extra={"../outside.txt": "owned"}
    )
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError, match="unsafe path"):
        modal_parser._extract(artifact, raw, FAST_VERSION)
    assert not (tmp_path / "outside.txt").exists()


def test_extract_rejects_a_checksum_mismatch(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(monkeypatch, tmp_path)
    artifact["sha256"] = "0" * 64
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError, match="checksum mismatch"):
        modal_parser._extract(artifact, raw, FAST_VERSION)


def test_extract_rejects_a_stale_parser_version(tmp_path: Path, monkeypatch):
    """A bundle from an older parser would silently degrade citations, so it is
    a cache miss rather than a usable artifact."""
    artifact = _install_artifact(monkeypatch, tmp_path, parser_version="mineru-0.1")
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError, match="version mismatch"):
        modal_parser._extract(artifact, raw, FAST_VERSION)


def test_extract_rejects_an_artifact_from_another_source(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(monkeypatch, tmp_path, fingerprint="fp-other")
    artifact["fingerprint"] = "fp-expected"
    raw = tmp_path / "raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError, match="source mismatch"):
        modal_parser._extract(artifact, raw, FAST_VERSION)


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


def test_empty_env_is_treated_as_unset(monkeypatch):
    from pipeline.config import _env

    monkeypatch.setenv("EVO_EMPTY_AS_UNSET", "")
    assert _env("EVO_EMPTY_AS_UNSET", "fallback") == "fallback"
