"""Import stage: gateway status mapping, bounded download, and the run order."""

from __future__ import annotations

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


def test_run_uploads_before_completing_and_reports_actual_size(monkeypatch):
    calls: list[tuple[str, dict]] = []
    writes: list[tuple[str, int, str]] = []

    def gateway(path, body):
        calls.append((path, body))
        if path.endswith("/acquire"):
            return 200, {
                "status": "acquired",
                "attemptToken": "tok",
                "attemptObjectPath": "incoming/up/file.pdf.attempt-1",
                "contentType": "application/pdf",
                "maxBytes": 100,
                "download": {"kind": "url", "url": "https://x.sharepoint.com/f"},
            }
        return 200, {"fileId": "f_1", "status": "succeeded"}

    monkeypatch.setattr(import_stage, "_gateway", gateway)
    monkeypatch.setattr(import_stage, "_download", lambda _grant, _max: b"hello")
    monkeypatch.setattr(
        import_stage.blobstore,
        "write_bytes",
        lambda path, data, ct: writes.append((path, len(data), ct)),
    )
    job = {"id": "imp_1", "attempts": 1, "payload": {"importJobId": "imp_1"}}
    import_stage._run(job)
    assert writes == [("incoming/up/file.pdf.attempt-1", 5, "application/pdf")]
    assert [path for path, _ in calls] == [
        "/api/internal/import/acquire",
        "/api/internal/import/complete",
    ]
    assert calls[1][1] == {"jobId": "imp_1", "attemptToken": "tok", "actualSize": 5}
    assert import_stage._TOKEN_KEY not in job


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
