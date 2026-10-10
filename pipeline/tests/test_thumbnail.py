"""Page-1 thumbnails and text previews written at the end of ingest."""

from __future__ import annotations

import hashlib
import io
import logging
from contextlib import contextmanager
from pathlib import Path

import pymupdf
import pytest
from PIL import Image

from pipeline.ingest import plan as ingest_plan
from pipeline.ingest import thumbnail, worker


def _plan(route: str, format_name: str) -> ingest_plan.ProcessingPlan:
    return ingest_plan.ProcessingPlan(
        version=2,
        format=format_name,
        route=route,
        parser_route="fast" if route == ingest_plan.DOCUMENT_PARSE else "",
        caption_mode="standalone" if route == ingest_plan.IMAGE_CAPTION else "none",
        office=format_name in {"docx", "pptx", "xlsx"},
        stages=(),
        resources=(),
    )


def _pdf(width: float, height: float) -> bytes:
    document = pymupdf.open()
    document.new_page(width=width, height=height).insert_text((40, 60), "Page one")
    return document.tobytes()


def _size(webp: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(webp)) as image:
        assert image.format == "WEBP"
        return image.size


def test_pdf_page_one_is_a_200px_wide_webp(tmp_path):
    source = tmp_path / "source-1"  # spooled sources carry no extension
    source.write_bytes(_pdf(595, 842))

    webp = thumbnail.render(_plan(ingest_plan.DOCUMENT_PARSE, "pdf"), source, None)

    # PyMuPDF rounds the A4 height (283.03 px) up.
    assert _size(webp) == (200, 284)


def test_the_repaired_pdf_wins_over_the_source(tmp_path, monkeypatch):
    source = tmp_path / "source-1"
    source.write_bytes(_pdf(595, 842))
    seen = []

    def repaired(artifact):
        seen.append(artifact)
        return _pdf(800, 400)

    monkeypatch.setattr(thumbnail.parser_client, "repaired_pdf", repaired)
    artifact = {"key": "artifacts/x.zip"}

    webp = thumbnail.render(_plan(ingest_plan.DOCUMENT_PARSE, "pdf"), source, artifact)

    assert seen == [artifact] and _size(webp) == (200, 100)


def test_a_tall_page_is_cut_from_the_top(tmp_path):
    source = tmp_path / "source-1"
    source.write_bytes(_pdf(300, 3000))

    webp = thumbnail.render(_plan(ingest_plan.DOCUMENT_PARSE, "pdf"), source, None)

    assert _size(webp) == (200, 400)


def test_an_image_is_oriented_flattened_and_shrunk(tmp_path):
    source = tmp_path / "photo"
    image = Image.new("RGBA", (800, 400), (255, 0, 0, 0))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees for display
    image.save(source, "PNG", exif=exif)

    webp = thumbnail.render(_plan(ingest_plan.IMAGE_CAPTION, "png"), source, None)

    assert _size(webp) == (200, 400)
    with Image.open(io.BytesIO(webp)) as rendered:
        # The transparent pixels are flattened onto white, as for captions.
        assert rendered.convert("RGB").getpixel((100, 200))[1] > 200


@pytest.mark.parametrize(
    "route,format_name",
    [
        (ingest_plan.IMAGE_CAPTION, "svg"),
        (ingest_plan.STORE_ONLY, "doc"),
        (ingest_plan.AUDIO_TRANSCRIPTION, "mp3"),
        (ingest_plan.DELIMITED_TEXT, "csv"),
    ],
)
def test_routes_without_a_page_have_no_thumbnail(tmp_path, route, format_name):
    source = tmp_path / "source-1"
    source.write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")

    assert thumbnail.render(_plan(route, format_name), source, None) is None


def test_office_pages_come_from_the_parser_capture(tmp_path, monkeypatch):
    source = tmp_path / "source-1"
    source.write_bytes(b"office")
    jpeg = io.BytesIO()
    Image.new("RGB", (283, 400), "white").save(jpeg, "JPEG")
    calls = []

    def office(path, name, page, bbox, max_edge):
        calls.append((path, name, page, bbox, max_edge))
        return jpeg.getvalue(), [0, 0, 1000, 1000], (283, 400)

    monkeypatch.setattr(thumbnail.capture, "office_capture_file", office)

    webp = thumbnail.render(_plan(ingest_plan.DOCUMENT_PARSE, "docx"), source, None)

    assert calls == [(source, "source.docx", 1, None, 400)]
    assert _size(webp) == (200, 283)


class _Store:
    """Stands in for the database and bucket calls a capture makes."""

    def __init__(self, monkeypatch, current_key="", stored=True, fail_update=False):
        self.current_key = current_key
        self.stored = stored
        self.fail_update = fail_update
        self.puts: list[tuple] = []
        self.keys: list[str] = []
        self.queued: list[str] = []
        self.previews: list[tuple] = []

        @contextmanager
        def connect():
            class Connection:
                def cursor(self):
                    return self

                def commit(self):
                    pass

                def __enter__(self):
                    return self

                def __exit__(self, *_exc):
                    return False

            yield Connection()

        def set_thumbnail(_cur, file_id, sha, key):
            if self.fail_update:
                raise RuntimeError("database unavailable")
            self.keys.append((file_id, sha, key))
            return self.stored

        monkeypatch.setattr(thumbnail.db, "connect", connect)
        monkeypatch.setattr(
            thumbnail.db, "file_thumbnail_key", lambda _cur, _id: self.current_key
        )
        monkeypatch.setattr(thumbnail.db, "set_file_thumbnail", set_thumbnail)
        monkeypatch.setattr(
            thumbnail.db,
            "enqueue_blob_deletion",
            lambda _cur, key: self.queued.append(key),
        )
        monkeypatch.setattr(
            thumbnail.db,
            "set_file_text_preview",
            lambda _cur, *args: self.previews.append(args),
        )
        monkeypatch.setattr(
            thumbnail.blobstore,
            "put_object",
            lambda *args: self.puts.append(args),
        )


def _capture(source: Path, route=ingest_plan.DOCUMENT_PARSE, format_name="pdf"):
    thumbnail.capture_source(
        file_id="f_1",
        plan=_plan(route, format_name),
        local_path=str(source),
        source_sha256="aa" * 32,
        artifact=None,
    )


def test_a_capture_stores_a_content_addressed_key_once(tmp_path, monkeypatch):
    source = tmp_path / "source-1"
    source.write_bytes(_pdf(595, 842))
    store = _Store(monkeypatch)

    _capture(source)

    [(key, data, content_type, cache_control)] = store.puts
    assert key == f"thumbs/f_1/{hashlib.sha256(data).hexdigest()}.webp"
    assert content_type == "image/webp"
    assert cache_control == "public, max-age=31536000, immutable"
    assert store.keys == [("f_1", "aa" * 32, key)] and store.queued == []

    unchanged = _Store(monkeypatch, current_key=key)
    _capture(source)
    assert unchanged.puts == [] and unchanged.keys == []


@pytest.mark.parametrize(
    "stored,fail_update", [(False, False), (True, True)], ids=["superseded", "failed"]
)
def test_a_key_no_row_took_is_queued_for_deletion(
    tmp_path, monkeypatch, caplog, stored, fail_update
):
    source = tmp_path / "source-1"
    source.write_bytes(_pdf(595, 842))
    store = _Store(monkeypatch, stored=stored, fail_update=fail_update)

    with caplog.at_level(logging.WARNING, logger="capy.thumbnail"):
        _capture(source)

    [(key, *_rest)] = store.puts
    assert store.queued == [key]
    assert ("thumbnail capture failed" in caplog.text) == fail_update


def test_a_text_source_stores_its_first_600_characters(tmp_path, monkeypatch):
    source = tmp_path / "source-1"
    source.write_text("﻿" + "\x00é" * 700, encoding="utf-8")
    store = _Store(monkeypatch)

    _capture(source, ingest_plan.RAW_TEXT, "md")

    assert store.previews == [("f_1", "aa" * 32, "é" * 300)]
    assert store.puts == []


async def test_a_failed_capture_leaves_the_ingest_ready(monkeypatch, tmp_path, caplog):
    """The capture runs after the job committed and never reaches it."""
    source = tmp_path / "source-1"
    source.write_bytes(b"%PDF broken")
    cleaned: list[str] = []

    async def _pin(_workspace_id):
        return {
            "embedding_dim": 2560,
            "embedding_provider_slug": "deepinfra",
            "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
            "embedding_model_version": 1,
        }

    async def _none(**_values):
        return None

    async def _chunks(**_values):
        return ["chunk"]

    async def _attach(**_values):
        return {"content_id": "rgc_1", "ready": True}

    async def _wait(association, **_values):
        return association

    def _broken(*_args):
        raise RuntimeError("renderer crashed")

    monkeypatch.setattr(worker, "_file_exists", lambda *_a: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a: "lecture.pdf")
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    monkeypatch.setattr(worker, "_account_allows_ingest", lambda *_a: True)
    monkeypatch.setattr(worker, "_record_source_sha", lambda *_a: None)
    monkeypatch.setattr(worker.store, "workspace_embedding_pin", _pin)
    monkeypatch.setattr(worker.store, "find_ready_donor", _none)
    monkeypatch.setattr(
        worker,
        "_acquire_local_source",
        lambda *_a: (
            str(source),
            "sources/s",
            "aa" * 32,
            lambda: cleaned.append("source"),
        ),
    )
    monkeypatch.setattr(worker, "_chunks_for", _chunks)
    monkeypatch.setattr(worker.indexing, "content_hash", lambda _chunks: "digest")
    monkeypatch.setattr(worker.store, "attach_file_content", _attach)
    monkeypatch.setattr(worker, "_wait_for_content", _wait)
    monkeypatch.setattr(worker, "_finish_ok", lambda *_a, **_k: True)
    monkeypatch.setattr(worker, "_publish_progress", lambda *_a, **_k: None)
    monkeypatch.setattr(worker, "_release_parse_artifact", lambda _p: None)
    monkeypatch.setattr(thumbnail, "render", _broken)

    with caplog.at_level(logging.WARNING, logger="capy.thumbnail"):
        await worker._process_ingest_job(
            {"id": "job_1", "attempts": 1, "type": "ingest"},
            {
                "blobPath": "sources/s",
                "sourceRevision": 1,
                "sourceETag": "etag-a",
                "actorUserId": "u_1",
                "reservationId": "cr_1",
            },
            "f_1",
            "ws_1",
            "pdf",
            _plan(ingest_plan.DOCUMENT_PARSE, "pdf"),
        )

    assert cleaned == ["source"]
    assert "thumbnail capture failed" in caplog.text
