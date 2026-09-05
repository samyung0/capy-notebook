"""Offline tests for the parser client's shared-spool trust boundary."""

from __future__ import annotations

import hashlib
import json
import os
import time
import zipfile
from pathlib import Path

import pytest

from pipeline.parse import parser_client

FAST_VERSION = parser_client.parser_version(parser_client.ROUTE_FAST)


def _descriptor(**overrides) -> dict:
    base = {
        "source_key": "sources/source-1",
        "source_sha256": "aa" * 32,
        "route": parser_client.ROUTE_FAST,
    }
    base.update(overrides)
    return parser_client.source_descriptor(**base)


def _artifact_zip(
    path: Path,
    *,
    fingerprint: str,
    content_list=None,
    extra: dict[str, str | bytes] | None = None,
    parser_version: str | None = None,
    schema: str | None = None,
    receipt_request_id: str = "",
    measurements: dict | None = None,
) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "schema": schema or parser_client.ARTIFACT_SCHEMA,
                    "parser_version": parser_version or FAST_VERSION,
                    "source_fingerprint": fingerprint,
                    **(
                        {
                            "parse_receipt": {
                                "id": fingerprint,
                                "request_id": receipt_request_id,
                                "measurements": measurements or {},
                            }
                        }
                        if receipt_request_id
                        else {}
                    ),
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


def test_artifact_key_is_stable_and_fingerprint_addressed():
    descriptor = _descriptor()
    key1, fingerprint1 = parser_client.artifact_identity(descriptor)
    key2, fingerprint2 = parser_client.artifact_identity(descriptor)

    assert (key1, fingerprint1) == (key2, fingerprint2)
    assert key1 == f"artifacts/{fingerprint1}.zip"


def test_source_method_schema_and_release_all_participate_in_identity(monkeypatch):
    _, original = parser_client.artifact_identity(_descriptor())
    _, other_source = parser_client.artifact_identity(
        _descriptor(source_sha256="bb" * 32)
    )
    monkeypatch.setattr(parser_client.cfg, "parse_method", "ocr")
    _, other_method = parser_client.artifact_identity(_descriptor())
    monkeypatch.setattr(parser_client, "ARTIFACT_SCHEMA", "evo-parser-bundle-v4")
    _, other_schema = parser_client.artifact_identity(_descriptor())
    monkeypatch.setattr(parser_client.cfg, "release_sha", "b" * 40)
    _, other_release = parser_client.artifact_identity(_descriptor())

    assert len({original, other_source, other_method, other_schema, other_release}) == 5


def test_unknown_or_missing_route_is_rejected():
    with pytest.raises(parser_client.ParserClientError, match="unknown parse route"):
        parser_client.artifact_identity(_descriptor(route="turbo"))
    with pytest.raises(parser_client.ParserClientError, match="unknown parse route"):
        parser_client.artifact_identity({"source_sha256": "aa" * 32})


def test_shared_keys_cannot_escape_the_spool(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))

    for key in ("/etc/passwd", "../outside", "artifacts/../../outside"):
        with pytest.raises(parser_client.ParserClientError, match="shared spool key"):
            parser_client._shared_path(key)


class _Resp:
    def __init__(self, status_code: int, payload=None, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


@pytest.fixture
def parser_url(monkeypatch):
    monkeypatch.setattr(
        parser_client.cfg, "parser_url", "http://10.77.0.2:8090/file_parse"
    )


def _stub_request(monkeypatch, response) -> list[dict]:
    calls: list[dict] = []
    monkeypatch.setattr(parser_client, "_local_artifact", lambda *_a: None)

    def _post(url, **kwargs):
        calls.append({"url": url, **kwargs})
        return response

    monkeypatch.setattr(parser_client.requests, "post", _post)
    return calls


def test_a_local_cache_hit_never_calls_parser(tmp_path: Path, monkeypatch, parser_url):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    key, fingerprint = parser_client.artifact_identity(_descriptor())
    path = parser_client._shared_path(key)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"cached")
    monkeypatch.setattr(
        parser_client.requests,
        "post",
        lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("parser called on cache hit")
        ),
    )

    artifact = parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")

    assert artifact["key"] == key
    assert artifact["fingerprint"] == fingerprint
    assert artifact["sha256"] == hashlib.sha256(b"cached").hexdigest()
    assert artifact["cached"] is True


def test_a_missing_local_bundle_restores_and_verifies_the_durable_cache(
    tmp_path: Path, monkeypatch, parser_url
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    monkeypatch.setattr(parser_client.cfg, "b2_bucket", "cache")
    key, fingerprint = parser_client.artifact_identity(_descriptor())
    source = tmp_path / "durable-source.zip"
    blob = _artifact_zip(source, fingerprint=fingerprint)
    source.unlink()
    downloads: list[str] = []

    def _download(durable_key: str, destination: str, _limit: int):
        downloads.append(durable_key)
        Path(destination).write_bytes(blob)
        return len(blob), hashlib.sha256(blob).hexdigest()

    monkeypatch.setattr(parser_client.blobstore, "download_file", _download)
    monkeypatch.setattr(
        parser_client.requests,
        "post",
        lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("parser called on durable cache hit")
        ),
    )

    artifact = parser_client._request_artifact(_descriptor(), "doc.pdf", "job-2")

    assert downloads == [parser_client.durable_artifact_key(fingerprint)]
    assert parser_client._shared_path(key).read_bytes() == blob
    assert artifact["durableKey"] == downloads[0]
    assert artifact["sha256"] == hashlib.sha256(blob).hexdigest()


def test_an_invalid_durable_bundle_is_ignored_and_parser_runs(
    tmp_path: Path, monkeypatch, parser_url
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    monkeypatch.setattr(parser_client.cfg, "b2_bucket", "cache")
    key, _ = parser_client.artifact_identity(_descriptor())

    def _download(_key: str, destination: str, _limit: int):
        Path(destination).write_bytes(b"not a zip")
        return 9, hashlib.sha256(b"not a zip").hexdigest()

    monkeypatch.setattr(parser_client.blobstore, "download_file", _download)
    calls = _stub_request(
        monkeypatch,
        _Resp(
            200,
            {
                "artifact": {
                    "key": key,
                    "size": 9,
                    "sha256": hashlib.sha256(b"local zip").hexdigest(),
                }
            },
        ),
    )

    artifact = parser_client._request_artifact(_descriptor(), "doc.pdf", "job-2")

    assert len(calls) == 1
    assert artifact["key"] == key
    assert not parser_client._shared_path(key).exists()


def test_local_cache_replays_a_lost_receipt_only_to_its_creating_job(
    tmp_path: Path, monkeypatch, parser_url
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    key, fingerprint = parser_client.artifact_identity(_descriptor())
    _artifact_zip(
        parser_client._shared_path(key),
        fingerprint=fingerprint,
        receipt_request_id="job-1",
        measurements={
            "_page_count": 4,
            "_ocr_page_count": 1,
            "_worker_cpu_ms": 3200,
            "_server_parse_ms": 4100,
        },
    )
    measured: list[dict] = []
    monkeypatch.setattr(
        parser_client.obs,
        "record_parse_usage",
        lambda **values: measured.append(values),
    )

    parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")
    parser_client._request_artifact(_descriptor(), "doc.pdf", "another-job")

    assert len(measured) == 1
    assert measured[0]["pages"] == 4
    assert measured[0]["receipt_id"] == fingerprint


def test_connection_loss_after_publication_recovers_receipt_immediately(
    tmp_path: Path, monkeypatch, parser_url
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    key, fingerprint = parser_client.artifact_identity(_descriptor())
    measured: list[dict] = []
    monkeypatch.setattr(
        parser_client.obs,
        "record_parse_usage",
        lambda **values: measured.append(values),
    )

    def _publish_then_disconnect(*_args, **_kwargs):
        _artifact_zip(
            parser_client._shared_path(key),
            fingerprint=fingerprint,
            receipt_request_id="job-final",
            measurements={"_page_count": 2, "_server_parse_ms": 100},
        )
        raise parser_client.requests.ConnectionError("response lost")

    monkeypatch.setattr(parser_client.requests, "post", _publish_then_disconnect)

    artifact = parser_client._request_artifact(_descriptor(), "doc.pdf", "job-final")

    assert artifact["key"] == key
    assert measured[0]["pages"] == 2
    assert measured[0]["receipt_id"] == fingerprint


def test_local_hard_timeout_quarantine_fails_without_calling_parser(
    tmp_path: Path, monkeypatch, parser_url
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    _, fingerprint = parser_client.artifact_identity(_descriptor())
    marker = tmp_path / "quarantine" / f"{fingerprint}.json"
    marker.parent.mkdir(parents=True)
    marker.write_text(
        json.dumps(
            {
                "reason": "parse_hard_timeout",
                "detail": "too slow",
                "source_fingerprint": fingerprint,
                "parser_version": FAST_VERSION,
            }
        )
    )
    monkeypatch.setattr(
        parser_client.requests,
        "post",
        lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("quarantined fingerprint called the parser")
        ),
    )

    with pytest.raises(parser_client.ParserHardTimeoutError, match="too slow"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def test_local_oom_quarantine_fails_without_calling_parser(
    tmp_path: Path, monkeypatch, parser_url
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    _, fingerprint = parser_client.artifact_identity(_descriptor())
    marker = tmp_path / "quarantine" / f"{fingerprint}.json"
    marker.parent.mkdir(parents=True)
    marker.write_text(
        json.dumps(
            {
                "reason": "parse_oom",
                "detail": "memory exhausted",
                "source_fingerprint": fingerprint,
                "parser_version": FAST_VERSION,
            }
        )
    )
    monkeypatch.setattr(
        parser_client.requests,
        "post",
        lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("quarantined fingerprint called the parser")
        ),
    )

    with pytest.raises(parser_client.ParserOOMError, match="memory exhausted"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def test_connection_loss_checks_oom_marker_before_retry(
    tmp_path: Path, monkeypatch, parser_url
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    _, fingerprint = parser_client.artifact_identity(_descriptor())

    def _oom_then_disconnect(*_args, **_kwargs):
        marker = tmp_path / "quarantine" / f"{fingerprint}.json"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(
            json.dumps(
                {
                    "reason": "parse_oom",
                    "detail": "memory exhausted",
                    "source_fingerprint": fingerprint,
                    "parser_version": FAST_VERSION,
                }
            )
        )
        raise parser_client.requests.ConnectionError("parser exited")

    monkeypatch.setattr(parser_client.requests, "post", _oom_then_disconnect)

    with pytest.raises(parser_client.ParserOOMError, match="memory exhausted"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def test_missing_parser_url_is_a_configuration_error(monkeypatch):
    monkeypatch.setattr(parser_client.cfg, "parser_url", "")
    with pytest.raises(parser_client.ParserClientError, match="PARSER_URL"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def test_request_passes_relative_source_and_fingerprint(monkeypatch, parser_url):
    key, fingerprint = parser_client.artifact_identity(_descriptor())
    calls = _stub_request(
        monkeypatch,
        _Resp(
            200,
            {
                "artifact": {
                    "key": key,
                    "size": 10,
                    "sha256": "cc" * 32,
                }
            },
        ),
    )

    parser_client._request_artifact(_descriptor(), "d.pdf", "job-1")

    request = calls[0]
    assert request["url"].endswith("/file_parse")
    assert request["json"]["source_key"] == "sources/source-1"
    assert request["json"]["source_sha256"] == "aa" * 32
    assert request["json"]["output_key"] == f"artifacts/{fingerprint}.zip"
    assert request["json"]["request_id"] == "job-1"
    assert "source_url" not in request["json"]
    assert "output_url" not in request["json"]
    assert request["timeout"] == parser_client.cfg.parser_timeout


def test_http_error_is_wrapped(monkeypatch, parser_url):
    _stub_request(monkeypatch, _Resp(500, {"detail": "boom"}))
    with pytest.raises(parser_client.ParserClientError, match="remote parse 500"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def test_hard_timeout_response_is_terminally_classified(monkeypatch, parser_url):
    _stub_request(
        monkeypatch,
        _Resp(422, {"code": "parse_hard_timeout", "detail": "too slow"}),
    )
    with pytest.raises(parser_client.ParserHardTimeoutError, match="too slow"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def test_oom_response_is_terminally_classified(monkeypatch, parser_url):
    _stub_request(
        monkeypatch,
        _Resp(422, {"code": "parse_oom", "detail": "memory exhausted"}),
    )
    with pytest.raises(parser_client.ParserOOMError, match="memory exhausted"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def test_parser_capacity_response_is_classified_without_becoming_terminal(
    monkeypatch, parser_url
):
    _stub_request(
        monkeypatch,
        _Resp(429, {"code": "parser_capacity", "detail": "queue is full"}),
    )
    with pytest.raises(parser_client.ParserCapacityError, match="queue is full"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def test_success_and_failure_both_record_parser_measurements(monkeypatch, parser_url):
    measured: list[dict] = []
    monkeypatch.setattr(
        parser_client.obs,
        "record_parse_usage",
        lambda **values: measured.append(values),
    )
    key, _ = parser_client.artifact_identity(_descriptor())
    _stub_request(
        monkeypatch,
        _Resp(
            200,
            {
                "artifact": {"key": key, "size": 10, "sha256": "cc" * 32},
                "_page_count": 4,
                "_ocr_page_count": 1,
                "_worker_cpu_ms": 3200,
                "_server_parse_ms": 4100,
                "_download_ms": 7,
                "_upload_ms": 8,
            },
        ),
    )
    parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")

    _stub_request(
        monkeypatch,
        _Resp(
            500,
            {
                "detail": "parse failed",
                "_page_count": 2,
                "_worker_cpu_ms": 900,
                "_server_parse_ms": 1200,
            },
        ),
    )
    with pytest.raises(parser_client.ParserClientError, match="parse failed"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")

    assert measured[0]["pages"] == 4
    assert measured[0]["download_milliseconds"] == 7
    assert measured[0]["upload_milliseconds"] == 8
    assert measured[1]["pages"] == 2
    assert measured[1]["cpu_milliseconds"] == 900


def test_mismatched_key_or_missing_checksum_is_rejected(monkeypatch, parser_url):
    _stub_request(
        monkeypatch,
        _Resp(
            200,
            {"artifact": {"key": "artifacts/elsewhere.zip", "size": 10}},
        ),
    )
    with pytest.raises(parser_client.ParserClientError, match="unexpected artifact"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")

    key, _ = parser_client.artifact_identity(_descriptor())
    _stub_request(monkeypatch, _Resp(200, {"artifact": {"key": key, "size": 10}}))
    with pytest.raises(parser_client.ParserClientError, match="checksum"):
        parser_client._request_artifact(_descriptor(), "doc.pdf", "job-1")


def _install_artifact(monkeypatch, tmp_path: Path, **zip_kwargs) -> dict:
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    fingerprint = zip_kwargs.pop("fingerprint", "fp-1")
    key = f"artifacts/{fingerprint}.zip"
    path = parser_client._shared_path(key)
    blob = _artifact_zip(path, fingerprint=fingerprint, **zip_kwargs)
    return {
        "key": key,
        "fingerprint": fingerprint,
        "size": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
    }


def test_verified_bundle_upload_is_best_effort(tmp_path: Path, monkeypatch):
    fingerprint = "a" * 64
    artifact = {
        **_install_artifact(monkeypatch, tmp_path, fingerprint=fingerprint),
        "version": FAST_VERSION,
    }
    monkeypatch.setattr(parser_client.cfg, "b2_bucket", "cache")
    uploads: list[tuple[str, bytes, str]] = []

    class Client:
        def put_object(self, **values) -> None:
            uploads.append(
                (values["Key"], values["Body"].read(), values["ContentType"])
            )
            raise OSError("B2 unavailable")

    monkeypatch.setattr(parser_client.blobstore, "_client", Client())
    monkeypatch.setattr(parser_client.blobstore.time, "sleep", lambda _seconds: None)

    assert (
        parser_client.publish_durable_artifact(
            artifact,
            route=parser_client.ROUTE_FAST,
            require_office_preview=False,
        )
        is None
    )
    assert len(uploads) == 3
    assert uploads[0][0] == parser_client.durable_artifact_key(fingerprint)
    assert all(
        upload[1] == parser_client._shared_path(artifact["key"]).read_bytes()
        for upload in uploads
    )


def test_bundle_is_verified_before_durable_upload(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    monkeypatch.setattr(parser_client.cfg, "b2_bucket", "cache")
    fingerprint = "b" * 64
    path = parser_client._shared_path(f"artifacts/{fingerprint}.zip")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not a zip")
    artifact = {
        "key": f"artifacts/{fingerprint}.zip",
        "fingerprint": fingerprint,
        "version": FAST_VERSION,
        "size": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    monkeypatch.setattr(
        parser_client.blobstore,
        "write_file",
        lambda *_a: (_ for _ in ()).throw(
            AssertionError("unverified bundle was uploaded")
        ),
    )

    with pytest.raises(zipfile.BadZipFile):
        parser_client.publish_durable_artifact(
            artifact,
            route=parser_client.ROUTE_FAST,
            require_office_preview=False,
        )
    assert not path.exists()


def test_invalid_local_bundle_is_removed_before_the_next_parse_attempt(
    tmp_path: Path, monkeypatch, parser_url
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    monkeypatch.setattr(parser_client.cfg, "b2_bucket", "")
    key, fingerprint = parser_client.artifact_identity(_descriptor())
    path = parser_client._shared_path(key)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not a zip")

    artifact = parser_client.ensure_artifact(_descriptor(), "doc.pdf", "job-1")
    with pytest.raises(zipfile.BadZipFile):
        parser_client.publish_durable_artifact(
            artifact,
            route=parser_client.ROUTE_FAST,
            require_office_preview=False,
        )
    assert not path.exists()

    calls: list[str] = []

    def post(url, **_kwargs):
        calls.append(url)
        return _Resp(503, {"detail": "parser unavailable"})

    monkeypatch.setattr(parser_client.requests, "post", post)
    with pytest.raises(parser_client.ParserClientError, match="remote parse 503"):
        parser_client.ensure_artifact(_descriptor(), "doc.pdf", "job-2")

    assert calls == [parser_client.cfg.parser_url]
    assert fingerprint in key


def test_extract_writes_and_validates_the_bundle(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(
        monkeypatch, tmp_path, extra={"images/fig1.png": "not-really-a-png"}
    )
    raw = tmp_path / "raw"
    raw.mkdir()

    parser_client._extract(artifact, raw, FAST_VERSION)

    assert json.loads((raw / "content_list.json").read_text())[0]["text"] == "Hello"
    assert (raw / "images" / "fig1.png").is_file()


def test_office_bundle_requires_a_valid_preview(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(monkeypatch, tmp_path)
    raw = tmp_path / "raw"
    raw.mkdir()
    with pytest.raises(parser_client.ParserClientError, match="preview.pdf"):
        parser_client._extract(artifact, raw, FAST_VERSION, require_office_preview=True)

    artifact = _install_artifact(
        monkeypatch,
        tmp_path,
        fingerprint="fp-2",
        extra={"preview.pdf": b"%PDF-exact"},
    )
    parser_client._extract(artifact, raw, FAST_VERSION, require_office_preview=True)
    assert (raw / "preview.pdf").read_bytes() == b"%PDF-exact"


def test_extract_rejects_path_traversal(tmp_path: Path, monkeypatch):
    artifact = _install_artifact(
        monkeypatch, tmp_path, extra={"../outside.txt": "owned"}
    )
    raw = tmp_path / "raw"
    raw.mkdir()
    with pytest.raises(parser_client.ParserClientError, match="unsafe path"):
        parser_client._extract(artifact, raw, FAST_VERSION)
    assert not (tmp_path / "outside.txt").exists()


def test_extract_rejects_checksum_size_and_expansion_mismatches(
    tmp_path: Path, monkeypatch
):
    artifact = _install_artifact(monkeypatch, tmp_path)
    raw = tmp_path / "raw"
    raw.mkdir()
    with pytest.raises(parser_client.ParserClientError, match="size mismatch"):
        parser_client._extract(
            {**artifact, "size": artifact["size"] + 1}, raw, FAST_VERSION
        )
    with pytest.raises(parser_client.ParserClientError, match="checksum mismatch"):
        parser_client._extract({**artifact, "sha256": "0" * 64}, raw, FAST_VERSION)

    monkeypatch.setattr(parser_client.cfg, "parse_artifact_max_entry_bytes", 16)
    artifact = _install_artifact(
        monkeypatch,
        tmp_path,
        fingerprint="fp-large",
        extra={"document.md": "x" * 17},
    )
    with pytest.raises(parser_client.ParserClientError, match="entry exceeds"):
        parser_client._extract(artifact, raw, FAST_VERSION)


def test_extract_rejects_stale_version_and_wrong_source(tmp_path: Path, monkeypatch):
    raw = tmp_path / "raw"
    raw.mkdir()
    stale = _install_artifact(
        monkeypatch, tmp_path, fingerprint="stale", parser_version="legacy-0.1"
    )
    with pytest.raises(parser_client.ParserClientError, match="version mismatch"):
        parser_client._extract(stale, raw, FAST_VERSION)

    wrong = _install_artifact(monkeypatch, tmp_path, fingerprint="actual")
    with pytest.raises(parser_client.ParserClientError, match="source mismatch"):
        parser_client._extract({**wrong, "fingerprint": "expected"}, raw, FAST_VERSION)


def test_parse_to_bundle_replaces_a_corrupt_cached_artifact(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    key = "artifacts/cached.zip"
    path = parser_client._shared_path(key)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not a zip")
    calls = 0

    def _request(*_args):
        nonlocal calls
        calls += 1
        if calls == 2:
            _artifact_zip(path, fingerprint="fp")
        blob = path.read_bytes()
        return {
            "key": key,
            "fingerprint": "fp",
            "size": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest(),
            "cached": calls == 1,
        }

    monkeypatch.setattr(parser_client, "_request_artifact", _request)
    content, returned_key, _ = parser_client.parse_to_bundle(
        _descriptor(), "doc.pdf", tmp_path / "raw", request_id="job-1"
    )

    assert calls == 2
    assert content[0]["text"] == "Hello"
    assert returned_key == key


def test_fresh_broken_artifact_is_not_retried(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    key = "artifacts/fresh.zip"
    path = parser_client._shared_path(key)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not a zip")
    blob = path.read_bytes()
    monkeypatch.setattr(
        parser_client,
        "_request_artifact",
        lambda *_a: {
            "key": key,
            "fingerprint": "fp",
            "size": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest(),
            "cached": False,
        },
    )

    with pytest.raises(zipfile.BadZipFile):
        parser_client.parse_to_bundle(
            _descriptor(), "doc.pdf", tmp_path / "raw", request_id="job-1"
        )


def test_discard_artifact_only_removes_its_fingerprint_addressed_bundle(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    fingerprint = "a" * 64
    path = tmp_path / "artifacts" / f"{fingerprint}.zip"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"invalid")

    parser_client.discard_artifact(
        {"key": f"artifacts/{fingerprint}.zip", "fingerprint": fingerprint}
    )
    assert not path.exists()

    with pytest.raises(parser_client.ParserClientError, match="repair descriptor"):
        parser_client.discard_artifact(
            {"key": "sources/source-1", "fingerprint": fingerprint}
        )


def test_handoff_extraction_classifies_a_broken_zip_for_repair(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    fingerprint = "a" * 64
    path = tmp_path / "artifacts" / f"{fingerprint}.zip"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not a zip")
    artifact = {
        "key": f"artifacts/{fingerprint}.zip",
        "fingerprint": fingerprint,
        "version": FAST_VERSION,
        "size": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }

    with pytest.raises(parser_client.ParserClientError, match="could not be read"):
        parser_client.extract_artifact(
            artifact,
            tmp_path / "raw-handoff",
            route=parser_client.ROUTE_FAST,
            require_office_preview=False,
        )


def test_local_spool_sweep_uses_separate_source_and_artifact_ttls(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    monkeypatch.setattr(parser_client.cfg, "parse_source_ttl_hours", 2)
    monkeypatch.setattr(parser_client.cfg, "parse_zip_ttl_hours", 6)
    source = tmp_path / "sources" / "source-old"
    artifact = tmp_path / "artifacts" / "artifact-old.zip"
    source.parent.mkdir(parents=True)
    artifact.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    artifact.write_bytes(b"artifact")
    old = time.time() - 7 * 60 * 60
    os.utime(source, (old, old))
    os.utime(artifact, (old, old))

    assert parser_client.sweep_local_spool() == {"sources": 1, "artifacts": 1}


def test_local_spool_sweep_keeps_keys_referenced_by_active_jobs(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(parser_client.cfg, "parse_shared_dir", str(tmp_path))
    monkeypatch.setattr(parser_client.cfg, "parse_source_ttl_hours", 2)
    monkeypatch.setattr(parser_client.cfg, "parse_zip_ttl_hours", 6)
    source = tmp_path / "sources" / "source-active"
    artifact = tmp_path / "artifacts" / "artifact-active.zip"
    source.parent.mkdir(parents=True)
    artifact.parent.mkdir(parents=True)
    source.write_bytes(b"source")
    artifact.write_bytes(b"artifact")
    old = time.time() - 7 * 60 * 60
    os.utime(source, (old, old))
    os.utime(artifact, (old, old))

    removed = parser_client.sweep_local_spool(
        {"sources/source-active", "artifacts/artifact-active.zip"}
    )

    assert removed == {"sources": 0, "artifacts": 0}
    assert source.exists()
    assert artifact.exists()


def test_empty_env_is_treated_as_unset(monkeypatch):
    from pipeline.config import _env

    monkeypatch.setenv("EVO_EMPTY_AS_UNSET", "")
    assert _env("EVO_EMPTY_AS_UNSET", "fallback") == "fallback"
