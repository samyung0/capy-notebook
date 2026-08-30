from __future__ import annotations

import asyncio
import threading

import pytest
from PIL import Image

from pipeline.ingest import source_text


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
async def test_concurrent_image_uploads_share_one_caption_artifact(
    monkeypatch, tmp_path
) -> None:
    source = tmp_path / "diagram.png"
    Image.new("RGB", (32, 32), "white").save(source)
    objects: dict[str, bytes] = {}
    gate = threading.Lock()
    state = {"locked": False, "calls": 0}

    class Connection:
        pass

    def try_lock(_identity: str):
        with gate:
            if state["locked"]:
                return None
            state["locked"] = True
            return Connection()

    def release_lock(_connection: Connection, _identity: str) -> None:
        with gate:
            state["locked"] = False

    async def caption(_data_url: str, prompt: str) -> str:
        state["calls"] += 1
        assert "formula" in prompt
        await asyncio.sleep(0.02)
        return "A chart showing x = 4 and y = x²."

    monkeypatch.setattr(source_text.db, "try_source_artifact_lock", try_lock)
    monkeypatch.setattr(source_text.db, "release_source_artifact_lock", release_lock)
    monkeypatch.setattr(
        source_text.blobstore, "read_bytes", lambda key: objects.get(key)
    )
    monkeypatch.setattr(
        source_text.blobstore,
        "write_bytes",
        lambda key, data, _content_type: objects.__setitem__(key, data),
    )
    monkeypatch.setattr(source_text.models, "caption_image", caption)

    first, second = await asyncio.gather(
        source_text.caption_image_source(
            local_path=str(source), name=source.name, source_sha256="ab" * 32
        ),
        source_text.caption_image_source(
            local_path=str(source), name=source.name, source_sha256="ab" * 32
        ),
    )

    assert state["calls"] == 1
    assert first[0] == second[0]
    assert first[1] == second[1]


def test_audio_artifact_identity_uses_elevenlabs_version(monkeypatch) -> None:
    monkeypatch.setattr(
        source_text.cfg, "elevenlabs_transcript_version", "scribe-v2-test"
    )
    assert source_text.artifact_key("ab" * 32, "audio").endswith(
        "/elevenlabs-scribe-v2-test.json"
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


def test_audio_submission_uses_scribe_webhook_metadata(monkeypatch) -> None:
    captured = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"request_id": "transcript_1"}

    def post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return Response()

    monkeypatch.setattr(source_text.cfg, "elevenlabs_api_key", "secret")
    monkeypatch.setattr(source_text.cfg, "elevenlabs_webhook_id", "webhook_1")
    monkeypatch.setattr(source_text.httpx, "post", post)

    assert source_text._submit_audio("at_1", "https://blob.test/audio") == (
        "transcript_1"
    )
    assert captured["data"] == {
        "model_id": "scribe_v2",
        "source_url": "https://blob.test/audio",
        "webhook": "true",
        "webhook_metadata": '{"audioTranscriptionId":"at_1"}',
        "webhook_id": "webhook_1",
    }
    assert captured["headers"] == {"xi-api-key": "secret"}


@pytest.mark.asyncio
async def test_failed_provider_delete_is_queued_durably(monkeypatch) -> None:
    requested = []
    finalized = []
    monkeypatch.setattr(source_text, "delete_provider_audio", lambda _provider: False)
    monkeypatch.setattr(
        source_text,
        "_request_audio_cleanup",
        lambda transcription_id, error: requested.append((transcription_id, error)),
    )
    monkeypatch.setattr(
        source_text,
        "_finalize_audio",
        lambda transcription_id: finalized.append(transcription_id),
    )

    deleted = await source_text._delete_or_queue_provider_audio(
        "provider-1", "transcription-1"
    )

    assert deleted is False
    assert requested == [
        (
            "transcription-1",
            "provider transcript deletion failed after successful ingest",
        )
    ]
    assert finalized == []
