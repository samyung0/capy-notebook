"""Import stage: gateway status mapping, bounded download, and the run order."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlencode

import pytest

from pipeline.ingest import import_stage
from pipeline.jobs import CapacityWait


@pytest.mark.parametrize(
    ("status", "payload", "expected"),
    [
        (409, {"code": "import_not_ready"}, CapacityWait),
        (409, {"code": "import_lease_lost"}, import_stage.ImportRetry),
        (
            429,
            {"code": "too_many_ingest_leases", "retryAfterSeconds": 300},
            CapacityWait,
        ),
        (429, {"code": "llm_credits_exhausted"}, import_stage.ImportRetry),
        (503, {}, import_stage.ImportRetry),
        (410, {"code": "provider_disconnected"}, import_stage.ImportFailure),
        (413, {"code": "file_too_large"}, import_stage.ImportFailure),
    ],
)
def test_gateway_status_maps_to_retry_policy(status, payload, expected):
    with pytest.raises(expected):
        import_stage._raise_for_gateway(status, payload, "acquire")


class _Body:
    def __init__(self, status, chunks=(), body=b""):
        self.status = status
        self._chunks = list(chunks)
        self._body = body

    def stream(self, _size):
        yield from self._chunks

    def read(self, _n):
        return self._body


class _Download:
    def __init__(self, response):
        self.response = response
        self.closed = False

    def close(self):
        self.closed = True


def _open(monkeypatch, response):
    download = _Download(response)
    monkeypatch.setattr(
        import_stage.pinned_http, "open_download", lambda *_a, **_k: download
    )
    return download


def test_download_enforces_max_bytes_and_closes(monkeypatch):
    download = _open(monkeypatch, _Body(200, chunks=[b"a" * 4, b"b" * 4]))
    with pytest.raises(import_stage.ImportFailure) as failure:
        import_stage._download({"kind": "url", "url": "https://x.sharepoint.com/f"}, 6)
    assert failure.value.code == "file_too_large"
    assert download.closed


def test_download_returns_bytes_under_limit(monkeypatch):
    _open(monkeypatch, _Body(200, chunks=[b"ab", b"c"]))
    assert (
        import_stage._download({"kind": "url", "url": "https://x.sharepoint.com/f"}, 6)
        == b"abc"
    )


def test_google_rate_limit_403_retries_but_plain_403_fails(monkeypatch):
    _open(
        monkeypatch,
        _Body(403, body=b'{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}'),
    )
    with pytest.raises(import_stage.ImportRetry):
        import_stage._download(
            {"kind": "bearer", "url": "https://www.googleapis.com/x", "token": "t"}, 6
        )
    _open(monkeypatch, _Body(403, body=b"forbidden"))
    with pytest.raises(import_stage.ImportFailure) as failure:
        import_stage._download(
            {"kind": "bearer", "url": "https://www.googleapis.com/x", "token": "t"}, 6
        )
    assert failure.value.code == "provider_download_refused"


def test_ingest_capacity_wait_releases_lease_and_backs_off_by_retry_after(monkeypatch):
    with pytest.raises(import_stage.ImportWait) as wait:
        import_stage._raise_for_gateway(
            429,
            {"code": "too_many_ingest_leases", "retryAfterSeconds": 300},
            "complete",
        )
    assert (wait.value.release, wait.value.backoff_s) == (True, 300)
    with pytest.raises(import_stage.ImportWait) as held:
        import_stage._raise_for_gateway(409, {"code": "import_not_ready"}, "acquire")
    assert (held.value.release, held.value.backoff_s) == (False, 30)

    sent: list[dict] = []
    released: list[int] = []
    monkeypatch.setattr(
        import_stage,
        "report",
        lambda job, exc, retryable: sent.append(
            {"code": exc.code, "retryable": retryable}
        ),
    )

    class Conn:
        def __enter__(self):
            return self

        def __exit__(self, *_a):
            pass

        def cursor(self):
            return self

        def execute(self, *_a):
            pass

        def fetchone(self):
            return (None,)

        def commit(self):
            pass

    monkeypatch.setattr(import_stage.db, "connect", lambda: Conn())
    monkeypatch.setattr(import_stage.db, "claim_is_current", lambda *_a: True)
    monkeypatch.setattr(
        import_stage.db,
        "release_job_for_capacity",
        lambda _cur, _id, _attempt, backoff_s: released.append(backoff_s),
    )
    monkeypatch.setattr(import_stage.db, "finish_job_attempt", lambda *_a, **_k: None)
    import_stage._yield_for_wait({"id": "imp_1", "attempts": 1}, wait.value)
    assert sent == [{"code": "too_many_ingest_leases", "retryable": True}]
    assert released == [300]


def test_bearer_grant_only_goes_to_the_drive_api(monkeypatch):
    _open(monkeypatch, _Body(200, chunks=[b"x"]))
    with pytest.raises(import_stage.ImportFailure) as failure:
        import_stage._download(
            {"kind": "bearer", "url": "https://x.sharepoint.com/f", "token": "t"}, 6
        )
    assert failure.value.code == "provider_download_refused"


def test_resume_complete_skips_download_and_upload(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(
        import_stage, "_download", lambda *_a: pytest.fail("downloaded")
    )
    monkeypatch.setattr(
        import_stage.blobstore, "write_bytes", lambda *_a: pytest.fail("uploaded")
    )

    def gateway(path, body):
        calls.append(path)
        if path.endswith("/acquire"):
            return 200, {
                "status": "acquired",
                "attemptToken": "tok",
                "attemptObjectPath": "incoming/up/f",
                "maxBytes": 100,
                "declaredSize": 42,
                "resumeComplete": True,
            }
        assert body["actualSize"] == 42
        return 200, {"status": "succeeded", "fileId": "f_1"}

    monkeypatch.setattr(import_stage, "_gateway", gateway)
    import_stage._run(
        {"id": "imp_1", "attempts": 1, "payload": {"importJobId": "imp_1"}}
    )
    assert calls == ["/api/internal/import/acquire", "/api/internal/import/complete"]


def test_complete_without_finalized_status_retries(monkeypatch):
    def gateway(path, _body):
        if path.endswith("/acquire"):
            return 200, {
                "status": "acquired",
                "attemptToken": "tok",
                "attemptObjectPath": "incoming/up/f",
                "maxBytes": 100,
                "download": {"kind": "url", "url": "https://x.sharepoint.com/f"},
            }
        return 200, {}

    monkeypatch.setattr(import_stage, "_gateway", gateway)
    monkeypatch.setattr(import_stage, "_download", lambda *_a: b"hi")
    monkeypatch.setattr(import_stage.blobstore, "write_bytes", lambda *_a: None)
    with pytest.raises(import_stage.ImportRetry):
        import_stage._run(
            {"id": "imp_1", "attempts": 1, "payload": {"importJobId": "imp_1"}}
        )


@pytest.mark.parametrize(
    "object_path", ["sources/blob_x.pdf", "incoming/../sources/blob_x.pdf"]
)
def test_run_writes_only_under_incoming(monkeypatch, object_path):
    reported: list[dict] = []

    def gateway(path, body):
        if path.endswith("/fail"):
            reported.append(body)
            return 200, {}
        assert path.endswith("/acquire")
        return 200, {
            "status": "acquired",
            "attemptToken": "tok",
            "attemptObjectPath": object_path,
            "maxBytes": 100,
            "download": {"kind": "url", "url": "https://x.sharepoint.com/f"},
        }

    monkeypatch.setattr(import_stage, "_gateway", gateway)
    monkeypatch.setattr(
        import_stage, "_download", lambda *_a: pytest.fail("downloaded")
    )
    monkeypatch.setattr(
        import_stage.blobstore, "write_bytes", lambda *_a: pytest.fail("uploaded")
    )
    job = {"id": "imp_1", "attempts": 1, "payload": {"importJobId": "imp_1"}}
    with pytest.raises(import_stage.ImportFailure) as refused:
        import_stage._run(job)
    # The refusal ends the attempt under its lease rather than waiting it out.
    import_stage.report(job, refused.value, retryable=False)
    assert reported == [
        {
            "jobId": "imp_1",
            "attemptToken": "tok",
            "code": "invalid_payload",
            "retryable": False,
        }
    ]


@pytest.mark.parametrize(
    ("filename", "content_type"),
    [
        (
            "lesson.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ),
        (
            "grades.xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        (
            "lesson.pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ),
        ("digital.pdf", "application/pdf"),
    ],
)
@pytest.mark.parametrize("provider", ["google", "microsoft"])
def test_run_preserves_provider_fixture_bytes_before_completing(
    monkeypatch, filename, content_type, provider
):
    data = (
        Path(__file__).parents[2] / "e2e/fixtures/files/basic" / filename
    ).read_bytes()
    url = "https://www.googleapis.com/drive/v3/files/file_1/export?" + urlencode(
        {"mimeType": content_type}
    )
    grant = {"kind": "bearer", "url": url, "token": "fixture-token"}
    headers_expected = {"Authorization": "Bearer fixture-token"}
    if provider == "microsoft":
        url = "https://download.example/" + filename + "?fixture-grant=true"
        grant = {"kind": "url", "url": url}
        headers_expected = {}
    events = []
    download = _Download(_Body(200, chunks=[data[:17], data[17:]]))

    def open_download(actual_url, *, headers, **_kwargs):
        assert actual_url == url
        assert headers == headers_expected
        events.append("download")
        return download

    def gateway(path, body):
        events.append(path.rsplit("/", 1)[-1])
        if path.endswith("/acquire"):
            return 200, {
                "status": "acquired",
                "attemptToken": "tok",
                "attemptObjectPath": "incoming/up/" + filename,
                "contentType": content_type,
                "maxBytes": len(data),
                "download": grant,
            }
        assert body == {
            "jobId": "imp_1",
            "attemptToken": "tok",
            "actualSize": len(data),
        }
        return 200, {"fileId": "f_1", "status": "succeeded"}

    def write(path, actual, mime):
        assert download.closed
        assert (path, bytes(actual), mime) == (
            "incoming/up/" + filename,
            data,
            content_type,
        )
        events.append("upload")

    monkeypatch.setattr(import_stage, "_gateway", gateway)
    monkeypatch.setattr(import_stage.pinned_http, "open_download", open_download)
    monkeypatch.setattr(import_stage.blobstore, "write_bytes", write)
    job = {"id": "imp_1", "attempts": 1, "payload": {"importJobId": "imp_1"}}
    import_stage._run(job)
    assert events == ["acquire", "download", "upload", "complete"]
    assert import_stage._TOKEN_KEY not in job


@pytest.mark.parametrize("failed_stage", ["download", "upload"])
def test_interrupted_import_never_completes_and_keeps_lease_for_failure_report(
    monkeypatch, failed_stage
):
    data = (
        Path(__file__).parents[2] / "e2e/fixtures/files/basic/lesson.docx"
    ).read_bytes()
    events = []
    reports = []

    class Body(_Body):
        def stream(self, _size):
            yield data[:17]
            if failed_stage == "download":
                raise OSError("provider connection closed mid-file")
            yield data[17:]

    download = _open(monkeypatch, Body(200))

    def gateway(path, body):
        events.append(path.rsplit("/", 1)[-1])
        if path.endswith("/acquire"):
            return 200, {
                "status": "acquired",
                "attemptToken": "tok",
                "attemptObjectPath": "incoming/up/lesson.docx",
                "maxBytes": len(data),
                "download": {"kind": "url", "url": "https://www.googleapis.com/export"},
            }
        assert path.endswith("/fail"), "incomplete bytes must never be finalized"
        reports.append(body)
        return 204, {}

    def write(_path, actual, _mime):
        assert failed_stage == "upload", "partial provider bytes reached B2"
        assert bytes(actual) == data
        events.append("upload")
        raise OSError("B2 unavailable")

    monkeypatch.setattr(import_stage, "_gateway", gateway)
    monkeypatch.setattr(import_stage.blobstore, "write_bytes", write)
    job = {"id": "imp_1", "attempts": 1, "payload": {"importJobId": "imp_1"}}
    expected_code = (
        "provider_network" if failed_stage == "download" else "b2_upload_failed"
    )
    with pytest.raises(import_stage.ImportRetry) as failure:
        import_stage._run(job)
    assert failure.value.code == expected_code
    assert download.closed
    assert job[import_stage._TOKEN_KEY] == "tok"
    import_stage.report(job, failure.value, retryable=True)
    assert reports == [
        {
            "jobId": "imp_1",
            "attemptToken": "tok",
            "code": expected_code,
            "retryable": True,
        }
    ]
    assert events == (
        ["acquire", "fail"]
        if failed_stage == "download"
        else ["acquire", "upload", "fail"]
    )


def test_report_skips_retry_without_token_and_sends_terminal(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(
        import_stage, "_gateway", lambda _p, body: sent.append(body) or (204, {})
    )
    job = {"id": "imp_1", "attempts": 2, "payload": {"importJobId": "imp_1"}}
    import_stage.report(job, import_stage.ImportRetry("provider_network", "x"), True)
    assert sent == []
    import_stage.report(job, import_stage.ImportFailure("file_too_large", "x"), False)
    assert sent == [
        {
            "jobId": "imp_1",
            "attemptToken": "",
            "code": "file_too_large",
            "retryable": False,
        }
    ]


def _image_run(monkeypatch, name, kind, data, *, max_bytes=30 << 20):
    """Runs one import of ``data`` and returns what was stored and the
    completion body, or raises the import's failure."""
    stored = {}

    def gateway(path, body):
        if path.endswith("/acquire"):
            return 200, {
                "status": "acquired",
                "attemptToken": "tok",
                "attemptObjectPath": "incoming/up/" + name,
                "contentType": "application/octet-stream",
                "maxBytes": max_bytes,
                "imageMaxBytes": 2 << 20,
                "name": name,
                "kind": kind,
                "download": {"kind": "url", "url": "https://x.sharepoint.com/f"},
            }
        stored["complete"] = body
        return 200, {"fileId": "f_1", "status": "succeeded"}

    def write(path, actual, mime):
        stored["bytes"], stored["type"] = bytes(actual), mime

    _open(monkeypatch, _Body(200, chunks=[data]))
    monkeypatch.setattr(import_stage, "_gateway", gateway)
    monkeypatch.setattr(import_stage.blobstore, "write_bytes", write)
    import_stage._run(
        {"id": "imp_1", "attempts": 1, "payload": {"importJobId": "imp_1"}}
    )
    return stored


def _zip(parts):
    import io
    import zipfile

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return out.getvalue()


def _png_header(width, height):
    import struct
    import zlib

    body = b"IHDR" + struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + body
        + struct.pack(">I", zlib.crc32(body))
    )


def test_office_import_stores_the_compressed_file_and_reports_removed_pictures(
    monkeypatch,
):
    compressed = _zip({"ppt/media/image1.png": _png_header(2400, 1600)})
    seen = {}

    def office_images(data, *, image_max_bytes, max_pixels):
        seen["cap"] = image_max_bytes
        return compressed, 2

    monkeypatch.setattr(import_stage.decode, "office_images", office_images)
    stored = _image_run(
        monkeypatch, "deck.pptx", "slides", _zip({"ppt/media/image99.emf": b"\0"})
    )
    assert seen["cap"] == 2 << 20
    assert stored["bytes"] == compressed
    assert stored["complete"] == {
        "jobId": "imp_1",
        "attemptToken": "tok",
        "actualSize": len(compressed),
        "removedPictures": 2,
    }


def test_office_import_still_breaking_the_rules_is_refused_finally(monkeypatch):
    monkeypatch.setattr(
        import_stage.decode, "office_images", lambda *_a, **_k: (None, 0)
    )
    for parts, code in (
        ({"word/media/eq.wmf": b"\0\0"}, "office_vector_image"),
        ({"word/media/image1.png": _png_header(2401, 2)}, "office_image_too_large"),
    ):
        with pytest.raises(import_stage.ImportFailure) as failure:
            _image_run(monkeypatch, "plan.docx", "doc", _zip(parts))
        assert failure.value.code == code


def test_image_source_import_is_shrunk_and_renamed(monkeypatch):
    shrunk = (
        b"\xff\xd8\xff\xc0\x00\x11\x08" + bytes([0x07, 0x00, 0x09, 0x00]) + b"\0" * 32
    )
    monkeypatch.setattr(
        import_stage.decode, "source_image", lambda *_a, **_k: (shrunk, "jpeg")
    )
    stored = _image_run(monkeypatch, "photo.png", "image", _png_header(4000, 3000))
    assert stored["bytes"] == shrunk
    assert stored["type"] == "image/jpeg"
    assert stored["complete"]["name"] == "photo.jpg"
    assert stored["complete"]["contentType"] == "image/jpeg"


def test_heic_import_this_pillow_cannot_shrink_is_kept_within_five_megapixels_only(
    monkeypatch,
):
    from test_image_check import heic

    monkeypatch.setattr(
        import_stage.decode, "source_image", lambda *_a, **_k: "unreadable"
    )
    small = heic(2000, 2000)
    assert _image_run(monkeypatch, "IMG_1.HEIC", "image", small)["bytes"] == small
    with pytest.raises(import_stage.ImportFailure) as failure:
        _image_run(monkeypatch, "IMG_2.HEIC", "image", heic(4032, 3024))
    assert failure.value.code == "image_unreadable"
