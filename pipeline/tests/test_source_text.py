from __future__ import annotations

import asyncio
import threading
from contextlib import asynccontextmanager

import httpx
import pytest
from PIL import Image

from pipeline.ingest import source_text
from pipeline.parse import caption_cache


def test_tabular_text_preserves_headers_values_and_formulas(tmp_path) -> None:
    source = tmp_path / "grades.csv"
    source.write_text(
        'Student,Score,Formula\nAda,98,"=B2/100"\nLin,87,"=B3/100"\n',
        encoding="utf-8",
    )

    text = source_text.tabular_text(str(source), source.name)

    assert "Columns: Student | Score | Formula" in text
    assert "Student=Ada" in text
    assert "Score=98" in text
    assert "Formula==B2/100" in text


def test_tabular_text_rejects_a_delimiter_allocation_bomb(
    monkeypatch, tmp_path
) -> None:
    source = tmp_path / "wide.csv"
    source.write_text("a,b,c,d,e\n", encoding="utf-8")
    monkeypatch.setattr(source_text, "_TABULAR_MAX_CELLS", 4)

    with pytest.raises(source_text.TerminalError, match="cell limit"):
        source_text.tabular_text(str(source), source.name)


def test_tabular_text_bounds_its_expanded_search_projection(
    monkeypatch, tmp_path
) -> None:
    source = tmp_path / "rows.csv"
    source.write_text("LongHeader\na\nb\nc\n", encoding="utf-8")
    monkeypatch.setattr(source_text, "_TABULAR_MAX_OUTPUT_CHARS", 30)

    with pytest.raises(source_text.TerminalError, match="searchable-text limit"):
        source_text.tabular_text(str(source), source.name)


@pytest.mark.asyncio
async def test_image_source_routes_authoritative_file_and_sha_to_caption_cache(
    monkeypatch, tmp_path
):
    source = tmp_path / "diagram.png"
    Image.new("RGB", (32, 32), "white").save(source)
    seen = {}

    async def caption(**kwargs):
        seen.update(kwargs)
        assert (await kwargs["data_url"]()).startswith("data:image/jpeg;base64,")
        return "A diagram.", "shared-caption", 42, True

    monkeypatch.setattr(caption_cache, "caption", caption)
    result = await source_text.caption_image_source(
        local_path=str(source),
        name=source.name,
        source_sha256="ab" * 32,
        file_id="file-1",
    )
    assert seen["file_id"] == "file-1" and seen["image_sha256"] == "ab" * 32
    assert result == ("A diagram.", "shared-caption", 42, True)


@pytest.mark.asyncio
async def test_source_lock_releases_late_acquisition_after_cancellation(
    monkeypatch,
) -> None:
    started = threading.Event()
    finish = threading.Event()
    released = threading.Event()
    connection = object()

    def try_lock(_identity: str):
        started.set()
        assert finish.wait(timeout=2)
        return connection

    def release_lock(actual: object, _identity: str) -> None:
        assert actual is connection
        released.set()

    monkeypatch.setattr(source_text.db, "try_source_artifact_lock", try_lock)
    monkeypatch.setattr(source_text.db, "release_source_artifact_lock", release_lock)

    async def hold_lock() -> None:
        async with source_text._source_lock("source"):
            pytest.fail("cancelled acquisition entered the lock")

    task = asyncio.create_task(hold_lock())
    assert await asyncio.to_thread(started.wait, 2)
    task.cancel()
    finish.set()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert released.is_set()


def test_derived_cache_read_failure_is_a_cache_miss(monkeypatch) -> None:
    monkeypatch.setattr(
        source_text.blobstore,
        "read_bytes",
        lambda _key: (_ for _ in ()).throw(OSError("B2 unavailable")),
    )

    assert source_text._load_artifact("derived-text/source/image-v1.json") is None


def test_derived_artifacts_are_keyed_on_source_bytes_alone() -> None:
    sha = "ab" * 32
    assert (
        source_text.artifact_key(sha, "audio") == f"derived-text/{sha}/elevenlabs.json"
    )


def test_audio_duration_comes_from_ffprobe(monkeypatch, tmp_path) -> None:
    source = tmp_path / "lecture.mp3"
    source.write_bytes(b"audio")

    class Result:
        stdout = "481.25\n"

    monkeypatch.setattr(source_text.subprocess, "run", lambda *_a, **_k: Result())

    assert source_text.audio_duration_seconds(source) == 481.25


def test_audio_duration_rejects_unreadable_media(monkeypatch, tmp_path) -> None:
    source = tmp_path / "bad.mp3"
    source.write_bytes(b"bad")
    monkeypatch.setattr(
        source_text.subprocess,
        "run",
        lambda *_a, **_k: (_ for _ in ()).throw(ValueError("bad")),
    )

    with pytest.raises(source_text.TerminalError, match="duration"):
        source_text.audio_duration_seconds(source)


def test_audio_concurrency_uses_starter_weight_bands() -> None:
    assert source_text.audio_concurrency_units(1) == 1
    assert source_text.audio_concurrency_units(480) == 1
    assert source_text.audio_concurrency_units(480.01) == 2
    assert source_text.audio_concurrency_units(1440) == 3
    assert source_text.audio_concurrency_units(1440.01) == 4
    assert source_text.audio_concurrency_units(36_000) == 4


@pytest.mark.asyncio
async def test_audio_submission_is_synchronous_and_omits_webhook_fields(
    monkeypatch,
) -> None:
    captured = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"text": "transcript", "language_code": "en"}

    class Client:
        def __init__(self, **kwargs):
            captured["client"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            request = httpx.Request("POST", url, **kwargs)
            captured.update(url=url, request=request, **kwargs)
            return Response()

    monkeypatch.setattr(source_text.cfg, "elevenlabs_api_key", "secret")
    monkeypatch.setattr(source_text.httpx, "AsyncClient", Client)

    assert (await source_text._transcribe_audio("https://blob.test/audio"))[
        "text"
    ] == "transcript"
    timeout = captured["client"]["timeout"]
    assert timeout.connect == source_text.cfg.elevenlabs_sync_timeout_s
    assert timeout.read == source_text.cfg.elevenlabs_sync_timeout_s
    assert captured["files"] == {
        "model_id": (None, "scribe_v2"),
        "source_url": (None, "https://blob.test/audio"),
    }
    assert captured["headers"] == {"xi-api-key": "secret"}
    request = captured["request"]
    assert request.headers["content-type"].startswith("multipart/form-data; boundary=")
    body = request.read()
    assert b'name="model_id"' in body
    assert b"scribe_v2" in body
    assert b'name="source_url"' in body
    assert b"https://blob.test/audio" in body
    assert b"webhook" not in body


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "error_type"),
    [
        (408, source_text.ElevenLabsRetryableResponseError),
        (425, source_text.ElevenLabsRetryableResponseError),
        (429, source_text.ElevenLabsRetryableResponseError),
        (500, source_text.ElevenLabsRetryableResponseError),
        (400, source_text.ElevenLabsTerminalResponseError),
        (409, source_text.ElevenLabsTerminalResponseError),
        (422, source_text.ElevenLabsTerminalResponseError),
    ],
)
async def test_audio_submission_classifies_provider_status(
    monkeypatch, status_code: int, error_type: type[Exception]
) -> None:
    class Response:
        def __init__(self, status: int):
            self.status_code = status

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return Response(status_code)

    monkeypatch.setattr(source_text.cfg, "elevenlabs_api_key", "secret")
    monkeypatch.setattr(source_text.httpx, "AsyncClient", Client)

    with pytest.raises(error_type):
        await source_text._transcribe_audio("https://blob.test/audio")


@pytest.mark.asyncio
async def test_audio_submission_has_absolute_wall_clock_timeout(monkeypatch) -> None:
    request_closed = asyncio.Event()

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            request_closed.set()

        async def post(self, *_args, **_kwargs):
            await asyncio.Future()

    monkeypatch.setattr(source_text.cfg, "elevenlabs_api_key", "secret")
    monkeypatch.setattr(source_text.cfg, "elevenlabs_sync_timeout_s", 0.01)
    monkeypatch.setattr(source_text.httpx, "AsyncClient", Client)

    with pytest.raises(TimeoutError):
        await source_text._transcribe_audio("https://blob.test/audio")
    assert request_closed.is_set()


@pytest.mark.asyncio
async def test_audio_settles_before_saving_reusable_artifact(monkeypatch) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def source_lock(_identity: str):
        yield

    monkeypatch.setattr(source_text, "_source_lock", source_lock)
    monkeypatch.setattr(source_text, "_load_artifact", lambda _key: None)
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: 17.2)
    monkeypatch.setattr(source_text, "_reserve_audio_capacity", lambda *_a: True)
    monkeypatch.setattr(
        source_text,
        "_release_audio_capacity",
        lambda *_a: events.append("release"),
    )
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda *_a: "https://blob.test/audio",
    )

    async def transcribe(_url):
        return {"text": "lecture transcript"}

    monkeypatch.setattr(source_text, "_transcribe_audio", transcribe)
    monkeypatch.setattr(source_text.accounting, "new_call_id", lambda: "pc_audio")

    async def open_call(*_a, **_k):
        events.append("open")

    async def settle_units(**_kwargs):
        events.append("settle")

    async def abandon_call(_call_id):
        events.append("abandon")

    def save(_key, payload):
        assert "accountingStatus" not in payload
        events.append("save")
        return 123

    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "settle_units", settle_units)
    monkeypatch.setattr(source_text.accounting, "abandon_call", abandon_call)
    monkeypatch.setattr(source_text, "_save_artifact", save)

    text, _, size = await source_text.transcribe_audio_source(
        local_path="/tmp/lecture.mp3",
        source_sha256="ab" * 32,
        blob_path="sources/audio",
        audio_rate={"creditMicrosPerUnit": 9, "version": 1},
    )

    assert text == "lecture transcript"
    assert size == 123
    assert events == ["open", "release", "settle", "save"]


@pytest.mark.asyncio
async def test_audio_continues_after_settlement_when_cache_write_fails(
    monkeypatch,
) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def source_lock(_identity: str):
        yield

    monkeypatch.setattr(source_text, "_source_lock", source_lock)
    monkeypatch.setattr(source_text, "_load_artifact", lambda _key: None)
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: 17.2)
    monkeypatch.setattr(source_text, "_reserve_audio_capacity", lambda *_a: True)
    monkeypatch.setattr(
        source_text,
        "_release_audio_capacity",
        lambda *_a: events.append("release"),
    )
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda *_a: "https://blob.test/audio",
    )

    async def transcribe(_url):
        return {"text": "lecture transcript"}

    monkeypatch.setattr(source_text, "_transcribe_audio", transcribe)
    monkeypatch.setattr(source_text, "_save_artifact", lambda *_args: None)
    monkeypatch.setattr(source_text.accounting, "new_call_id", lambda: "pc_audio")

    async def open_call(*_a, **_k):
        events.append("open")

    async def settle_units(**_kwargs):
        events.append("settle")

    async def abandon_call(_call_id):
        events.append("abandon")

    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "settle_units", settle_units)
    monkeypatch.setattr(source_text.accounting, "abandon_call", abandon_call)

    result = await source_text.transcribe_audio_source(
        local_path="/tmp/lecture.mp3",
        source_sha256="ab" * 32,
        blob_path="sources/audio",
        audio_rate={"creditMicrosPerUnit": 9, "version": 1},
    )

    assert result == ("lecture transcript", "", 0)
    assert events == ["open", "release", "settle"]


@pytest.mark.asyncio
async def test_audio_releases_capacity_after_deterministic_settlement_rejection(
    monkeypatch,
) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def source_lock(_identity: str):
        yield

    monkeypatch.setattr(source_text, "_source_lock", source_lock)
    monkeypatch.setattr(source_text, "_load_artifact", lambda _key: None)
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: 17.2)
    monkeypatch.setattr(source_text, "_reserve_audio_capacity", lambda *_args: True)
    monkeypatch.setattr(
        source_text,
        "_release_audio_capacity",
        lambda *_args: events.append("release"),
    )
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda *_args: "https://blob.test/audio",
    )

    async def transcribe(_url):
        return {"text": "lecture transcript"}

    monkeypatch.setattr(source_text, "_transcribe_audio", transcribe)
    monkeypatch.setattr(source_text.accounting, "new_call_id", lambda: "pc_audio")

    async def open_call(*_args, **_kwargs):
        events.append("open")

    async def settle_units(**_kwargs):
        events.append("settle")
        raise source_text.accounting.SettlementError("call identity mismatch")

    async def abandon_call(*_args, **_kwargs):
        events.append("abandon")

    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "settle_units", settle_units)
    monkeypatch.setattr(source_text.accounting, "abandon_call", abandon_call)

    with pytest.raises(source_text.accounting.SettlementError):
        await source_text.transcribe_audio_source(
            local_path="/tmp/lecture.mp3",
            source_sha256="ab" * 32,
            blob_path="sources/audio",
            audio_rate={"creditMicrosPerUnit": 9, "version": 1},
        )

    assert events == ["open", "release", "settle"]


@pytest.mark.asyncio
async def test_cancelled_audio_call_waits_for_receipt_deadline(monkeypatch) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def source_lock(_identity: str):
        yield

    monkeypatch.setattr(source_text, "_source_lock", source_lock)
    monkeypatch.setattr(source_text, "_load_artifact", lambda _key: None)
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: 17.2)
    monkeypatch.setattr(source_text, "_reserve_audio_capacity", lambda *_args: True)
    monkeypatch.setattr(
        source_text,
        "_release_audio_capacity",
        lambda *_args: events.append("release"),
    )
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda *_args: "https://blob.test/audio",
    )
    monkeypatch.setattr(source_text.accounting, "new_call_id", lambda: "pc_audio")

    async def open_call(*_args, **_kwargs):
        events.append("open")

    async def abandon_call(*_args, **_kwargs):
        events.append("abandon")

    async def cancel_during_provider(_source_url):
        raise asyncio.CancelledError

    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "abandon_call", abandon_call)
    monkeypatch.setattr(source_text, "_transcribe_audio", cancel_during_provider)

    with pytest.raises(asyncio.CancelledError):
        await source_text.transcribe_audio_source(
            local_path="/tmp/lecture.mp3",
            source_sha256="ab" * 32,
            blob_path="sources/audio",
            audio_rate={"creditMicrosPerUnit": 9, "version": 1},
        )

    assert events == ["open", "release"]


@pytest.mark.asyncio
async def test_audio_cancellation_after_response_finishes_receipt_and_cache(
    monkeypatch,
) -> None:
    events: list[str] = []
    cleanup_started = asyncio.Event()
    allow_cleanup = asyncio.Event()

    @asynccontextmanager
    async def source_lock(_identity: str):
        yield

    monkeypatch.setattr(source_text, "_source_lock", source_lock)
    monkeypatch.setattr(source_text, "_load_artifact", lambda _key: None)
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: 17.2)
    monkeypatch.setattr(source_text, "_reserve_audio_capacity", lambda *_args: True)
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda *_args: "https://blob.test/audio",
    )
    monkeypatch.setattr(source_text.accounting, "new_call_id", lambda: "pc_audio")

    async def open_call(*_args, **_kwargs):
        events.append("open")

    async def maintain(_lease_id):
        await asyncio.Future()

    async def stop(_lease_id, heartbeat):
        cleanup_started.set()
        await allow_cleanup.wait()
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
        events.append("release")

    async def transcribe(_source_url):
        return {"text": "lecture transcript"}

    async def settle_units(**_kwargs):
        events.append("settle")

    def save(_key, _payload):
        events.append("save")
        return 123

    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "settle_units", settle_units)
    monkeypatch.setattr(source_text, "_maintain_audio_capacity", maintain)
    monkeypatch.setattr(source_text, "_stop_audio_capacity", stop)
    monkeypatch.setattr(source_text, "_transcribe_audio", transcribe)
    monkeypatch.setattr(source_text, "_save_artifact", save)

    task = asyncio.create_task(
        source_text.transcribe_audio_source(
            local_path="/tmp/lecture.mp3",
            source_sha256="ab" * 32,
            blob_path="sources/audio",
            audio_rate={"creditMicrosPerUnit": 9, "version": 1},
        )
    )
    await cleanup_started.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()

    allow_cleanup.set()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert events == ["open", "release", "settle", "save"]


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_response", [False, True], ids=["valid", "invalid"])
async def test_audio_cancellation_during_completed_wait_handoff_settles_and_caches(
    monkeypatch, invalid_response: bool
) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def source_lock(_identity: str):
        yield

    monkeypatch.setattr(source_text, "_source_lock", source_lock)
    monkeypatch.setattr(source_text, "_load_artifact", lambda _key: None)
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: 17.2)
    monkeypatch.setattr(source_text, "_reserve_audio_capacity", lambda *_args: True)
    monkeypatch.setattr(
        source_text,
        "_release_audio_capacity",
        lambda *_args: events.append("release"),
    )
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda *_args: "https://blob.test/audio",
    )
    monkeypatch.setattr(source_text.accounting, "new_call_id", lambda: "pc_audio")

    async def open_call(*_args, **_kwargs):
        events.append("open")

    async def maintain(_lease_id):
        await asyncio.Future()

    async def transcribe(_source_url):
        if invalid_response:
            raise source_text.ElevenLabsInvalidResponseError("empty transcript")
        return {"text": "lecture transcript"}

    async def settle_units(**_kwargs):
        events.append("settle")

    def save(_key, _payload):
        events.append("save")
        return 123

    real_sleep = asyncio.sleep

    async def cancel_wait_after_provider_finishes(tasks, **_kwargs):
        while not any(task.done() for task in tasks):
            await real_sleep(0)
        asyncio.current_task().cancel()
        await real_sleep(0)
        raise AssertionError("cancellation was not delivered")

    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "settle_units", settle_units)
    monkeypatch.setattr(source_text, "_maintain_audio_capacity", maintain)
    monkeypatch.setattr(source_text, "_transcribe_audio", transcribe)
    monkeypatch.setattr(source_text, "_save_artifact", save)
    monkeypatch.setattr(
        source_text.asyncio, "wait", cancel_wait_after_provider_finishes
    )

    with pytest.raises(asyncio.CancelledError):
        await source_text.transcribe_audio_source(
            local_path="/tmp/lecture.mp3",
            source_sha256="ab" * 32,
            blob_path="sources/audio",
            audio_rate={"creditMicrosPerUnit": 9, "version": 1},
        )

    expected = ["open", "release", "settle"]
    if not invalid_response:
        expected.append("save")
    assert events == expected


@pytest.mark.asyncio
async def test_completed_invalid_audio_response_is_still_settled(monkeypatch) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def source_lock(_identity: str):
        yield

    monkeypatch.setattr(source_text, "_source_lock", source_lock)
    monkeypatch.setattr(source_text, "_load_artifact", lambda _key: None)
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: 17.2)
    monkeypatch.setattr(source_text, "_reserve_audio_capacity", lambda *_args: True)
    monkeypatch.setattr(
        source_text,
        "_release_audio_capacity",
        lambda *_args: events.append("release"),
    )
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda *_args: "https://blob.test/audio",
    )
    monkeypatch.setattr(source_text.accounting, "new_call_id", lambda: "pc_audio")

    async def open_call(*_args, **_kwargs):
        events.append("open")

    async def settle_units(**_kwargs):
        events.append("settle")

    async def transcribe(_source_url):
        raise source_text.ElevenLabsInvalidResponseError("empty transcript")

    async def abandon_call(*_args, **_kwargs):
        events.append("abandon")

    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "settle_units", settle_units)
    monkeypatch.setattr(source_text.accounting, "abandon_call", abandon_call)
    monkeypatch.setattr(source_text, "_transcribe_audio", transcribe)

    with pytest.raises(source_text.ElevenLabsInvalidResponseError):
        await source_text.transcribe_audio_source(
            local_path="/tmp/lecture.mp3",
            source_sha256="ab" * 32,
            blob_path="sources/audio",
            audio_rate={"creditMicrosPerUnit": 9, "version": 1},
        )

    assert events == ["open", "release", "settle"]


@pytest.mark.asyncio
async def test_lost_capacity_lease_closes_request_before_release(monkeypatch) -> None:
    events: list[str] = []

    @asynccontextmanager
    async def source_lock(_identity: str):
        yield

    monkeypatch.setattr(source_text, "_source_lock", source_lock)
    monkeypatch.setattr(source_text, "_load_artifact", lambda _key: None)
    monkeypatch.setattr(source_text, "audio_duration_seconds", lambda _path: 17.2)
    monkeypatch.setattr(source_text, "_reserve_audio_capacity", lambda *_args: True)
    monkeypatch.setattr(
        source_text,
        "_release_audio_capacity",
        lambda *_args: events.append("release"),
    )
    monkeypatch.setattr(
        source_text.blobstore,
        "presign_get",
        lambda *_args: "https://blob.test/audio",
    )
    monkeypatch.setattr(source_text.accounting, "new_call_id", lambda: "pc_audio")

    async def open_call(*_args, **_kwargs):
        events.append("open")

    async def maintain(_lease_id):
        await asyncio.sleep(0)
        raise source_text.RetryableError("capacity expired")

    async def transcribe(_source_url):
        try:
            await asyncio.Future()
        finally:
            events.append("request_closed")

    async def abandon_call(*_args, **_kwargs):
        events.append("abandon")

    monkeypatch.setattr(source_text.accounting, "open_call", open_call)
    monkeypatch.setattr(source_text.accounting, "abandon_call", abandon_call)
    monkeypatch.setattr(source_text, "_maintain_audio_capacity", maintain)
    monkeypatch.setattr(source_text, "_transcribe_audio", transcribe)

    with pytest.raises(source_text.RetryableError, match="capacity expired"):
        await source_text.transcribe_audio_source(
            local_path="/tmp/lecture.mp3",
            source_sha256="ab" * 32,
            blob_path="sources/audio",
            audio_rate={"creditMicrosPerUnit": 9, "version": 1},
        )

    assert events == ["open", "request_closed", "release"]
