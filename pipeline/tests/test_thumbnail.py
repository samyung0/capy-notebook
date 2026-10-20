"""Page-1 thumbnails and text previews written at the end of ingest. The
pixels are decoded in the sandboxed helper (pipeline/ingest/decode.py); the
tests that watch Pillow call the helper's functions in this process."""

from __future__ import annotations

import base64
import hashlib
import io
import logging
import secrets
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import pymupdf
import pytest
from PIL import Image

from pipeline.ingest import decode, thumbnail
from pipeline.ingest import plan as ingest_plan


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


_PDF = _pdf(595, 842)


def _png(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, "PNG")
    return buffer.getvalue()


def _size(webp: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(webp)) as image:
        assert image.format == "WEBP"
        return image.size


@pytest.fixture
def no_document_rendering(monkeypatch):
    """The worker neither converts (the parser's /capture_page is chat's) nor
    renders a document: PyMuPDF is unusable during these tests."""

    def refuse(*_args, **_kwargs):
        raise AssertionError("a document thumbnail rendered or converted in the worker")

    monkeypatch.setattr("requests.post", refuse)
    monkeypatch.setattr(pymupdf, "open", refuse)


@pytest.mark.parametrize("format_name", ["pdf", "docx", "pptx", "xlsx"])
def test_document_pages_come_from_the_parse_bundle(
    tmp_path, monkeypatch, no_document_rendering, format_name
):
    source = tmp_path / "source-1"
    source.write_bytes(b"document")

    plan = _plan(ingest_plan.DOCUMENT_PARSE, format_name)
    webp = thumbnail.render(plan, source, _png(200, 283))

    assert _size(webp) == (200, 283)


def test_a_parse_without_a_page_image_renders_none(tmp_path, no_document_rendering):
    source = tmp_path / "source-1"
    source.write_bytes(_PDF)

    for format_name in ("pdf", "pptx"):
        plan = _plan(ingest_plan.DOCUMENT_PARSE, format_name)
        assert thumbnail.render(plan, source, None) is None


@pytest.mark.parametrize(
    "page",
    [_png(201, 100), _png(200, 401), _PDF],
    ids=["too-wide", "too-tall", "not-a-png"],
)
def test_a_bundled_page_is_checked_before_it_is_decoded(monkeypatch, page):
    decoded = []
    monkeypatch.setattr(Image.Image, "load", lambda self: decoded.append(self))

    with pytest.raises((ValueError, Image.UnidentifiedImageError)):
        decode._page(page)
    assert decoded == []
    with pytest.raises(decode.DecodeFailed):
        thumbnail.render(_plan(ingest_plan.DOCUMENT_PARSE, "pdf"), Path("-"), page)


def test_an_image_is_oriented_shrunk_and_flattened(tmp_path, monkeypatch):
    source = tmp_path / "photo"
    image = Image.new("RGBA", (800, 400), (255, 0, 0, 0))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees for display
    image.save(source, "PNG", exif=exif)
    flattened = []
    paste = Image.Image.paste

    def record(self, im, *args, **kwargs):
        flattened.append(im.size)
        return paste(self, im, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "paste", record)

    webp = base64.b64decode(decode._thumbnail(str(source), "png", 100_000_000)["webp"])

    assert _size(webp) == (200, 400)
    assert (
        thumbnail.render(_plan(ingest_plan.IMAGE_CAPTION, "png"), source, None) == webp
    )
    # Flattening worked on the thumbnail, not the 400 x 800 original.
    assert flattened == [(200, 400)]
    with Image.open(io.BytesIO(webp)) as rendered:
        # The transparent pixels are flattened onto white, as for captions.
        assert rendered.convert("RGB").getpixel((100, 200))[1] > 200


@pytest.mark.parametrize(
    "route,format_name",
    [
        (ingest_plan.IMAGE_CAPTION, "svg"),
        (ingest_plan.STORE_ONLY, "doc"),
        (ingest_plan.DELIMITED_TEXT, "csv"),
    ],
)
def test_routes_without_a_page_have_no_thumbnail(tmp_path, route, format_name):
    source = tmp_path / "source-1"
    source.write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")

    assert thumbnail.render(_plan(route, format_name), source, None) is None


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


def _capture(source: Path, route=ingest_plan.IMAGE_CAPTION, format_name="png"):
    thumbnail.capture_source(
        file_id="f_1",
        workspace_id="ws_1",
        plan=_plan(route, format_name),
        local_path=str(source),
        source_sha256="aa" * 32,
        page_image=None,
    )


def test_a_capture_stores_a_content_addressed_key_once(tmp_path, monkeypatch):
    source = tmp_path / "source-1"
    source.write_bytes(_png(400, 300))
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
    source.write_bytes(_png(400, 300))
    store = _Store(monkeypatch, stored=stored, fail_update=fail_update)

    with caplog.at_level(logging.WARNING, logger="capy.thumbnail"):
        _capture(source)

    [(key, *_rest)] = store.puts
    assert store.queued == [key]
    assert ("thumbnail capture failed" in caplog.text) == fail_update


@pytest.mark.parametrize(
    "route,fmt", [(ingest_plan.RAW_TEXT, "md"), (ingest_plan.DELIMITED_TEXT, "csv")]
)
def test_a_text_source_stores_its_first_600_characters(
    tmp_path, monkeypatch, route, fmt
):
    source = tmp_path / "source-1"
    source.write_text("﻿" + "\x00é" * 700, encoding="utf-8")
    store = _Store(monkeypatch)

    _capture(source, route, fmt)

    assert store.previews == [("f_1", "aa" * 32, "é" * 300)]
    assert store.puts == []


async def test_a_failed_capture_leaves_the_ingest_ready(monkeypatch, tmp_path, caplog):
    """The capture runs after the job committed and never reaches it."""
    from pipeline.ingest import worker  # imports fcntl: Linux only

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
        return ["chunk"], [], b"page"

    async def _attach(**_values):
        return {"content_id": "rgc_1", "ready": True}

    async def _wait(association, **_values):
        return association

    async def _described(**_values):
        return None

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
    monkeypatch.setattr(worker.indexing, "fill_descriptor", _described)
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
                "parseArtifact": {"key": "artifacts/x.zip"},
            },
            "f_1",
            "ws_1",
            "pdf",
            _plan(ingest_plan.DOCUMENT_PARSE, "pdf"),
        )

    assert cleaned == ["source"]
    assert "thumbnail capture failed" in caplog.text


@pytest.mark.integration
def test_a_reuse_without_a_bundle_shares_the_identical_files_key(workspace, tmp_path):
    """A parse that reused identical indexed bytes builds no bundle, so the new
    Office file takes the original's key; the blob outlives the original while
    the copy still references it."""
    sha = "ab" * 32
    original = workspace.add_file("deck.pptx")
    copy = workspace.add_file("deck again.pptx")
    key = f"thumbs/{original}/{'c' * 64}.webp"
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE files SET kind='slides', source_sha256=%s WHERE id IN (%s, %s)",
            (sha, original, copy),
        )
        conn.execute("UPDATE files SET thumbnail_key=%s WHERE id=%s", (key, original))
    source = tmp_path / "source-1"
    source.write_bytes(b"office")

    thumbnail.capture_source(
        file_id=copy,
        workspace_id=workspace.id,
        plan=_plan(ingest_plan.DOCUMENT_PARSE, "pptx"),
        local_path=str(source),
        source_sha256=sha,
        page_image=None,
    )

    refs = "SELECT COALESCE((SELECT ref_count FROM blobs WHERE object_path=%s), 0)"
    queued = "SELECT EXISTS (SELECT 1 FROM pending_blob_deletions WHERE object_path=%s)"
    assert (
        workspace.scalar("SELECT thumbnail_key FROM files WHERE id=%s", (copy,)) == key
    )
    assert workspace.scalar(refs, (key,)) == 2
    with workspace._connect() as conn:
        conn.execute("DELETE FROM files WHERE id=%s", (original,))
    assert workspace.scalar(refs, (key,)) == 1
    assert workspace.scalar(queued, (key,)) is False
    with workspace._connect() as conn:
        conn.execute("DELETE FROM files WHERE id=%s", (copy,))
    assert workspace.scalar(queued, (key,)) is True


@pytest.mark.integration
@pytest.mark.parametrize("same_owner", [False, True], ids=["other-owner", "same-owner"])
def test_a_reuse_never_shares_a_key_from_another_workspace(
    workspace, tmp_path, same_owner
):
    """Security regression (review 1 M1): a key names its file and a file id
    leads to its workspace, so a reused file never takes the key of a file in
    another workspace: another owner's link workspace, or the same owner's
    other workspace (a link workspace's key would show in a public one)."""
    sha = "cd" * 32
    owner = workspace.user_id if same_owner else f"u_{secrets.token_hex(4)}"
    other_workspace = f"ws_{secrets.token_hex(6)}"
    donor = f"f_{secrets.token_hex(6)}"
    key = f"thumbs/{donor}/{'d' * 64}.webp"
    with workspace._connect() as conn:
        if not same_owner:
            conn.execute(
                "INSERT INTO users (id, name, email) VALUES (%s, 'Other', %s)",
                (owner, f"{owner}@capynotebook.test"),
            )
        conn.execute(
            "INSERT INTO workspaces (id, user_id, name, privacy) VALUES (%s, %s, 'Shared', 'link')",
            (other_workspace, owner),
        )
        conn.execute(
            """INSERT INTO files (id, workspace_id, user_id, name, kind, size_bytes,
                status, blob_path, source_sha256, thumbnail_key)
            SELECT %s, w.id, w.user_id, 'deck.pdf', 'pdf', 1024, 'ready', %s, %s, %s
            FROM workspaces w WHERE w.id = %s""",
            (donor, f"sources/{donor}", sha, key, other_workspace),
        )
    copy = workspace.add_file("deck.pdf")
    with workspace._connect() as conn:
        conn.execute("UPDATE files SET source_sha256=%s WHERE id=%s", (sha, copy))
    source = tmp_path / "source-1"
    source.write_bytes(b"pdf")
    try:
        thumbnail.capture_source(
            file_id=copy,
            workspace_id=workspace.id,
            plan=_plan(ingest_plan.DOCUMENT_PARSE, "pdf"),
            local_path=str(source),
            source_sha256=sha,
            page_image=None,
        )
        shared = workspace.scalar(
            "SELECT thumbnail_key FROM files WHERE id=%s", (copy,)
        )
        assert shared is None
    finally:
        with workspace._connect() as conn:
            conn.execute("DELETE FROM workspaces WHERE id=%s", (other_workspace,))
            if not same_owner:
                conn.execute("DELETE FROM users WHERE id=%s", (owner,))


@pytest.mark.integration
def test_ingest_leaves_a_browser_capture_alone(workspace):
    """Once an editor's browser captured a file (review T3 S4), an ingest
    refresh neither writes its page-1 key nor shares a reused file's key over
    the capture: the browser owns the thumbnail."""
    sha = "ef" * 32
    donor = workspace.add_file("deck.pptx")
    captured = workspace.add_file("deck again.pptx")
    donor_key = f"thumbs/{donor}/{'d' * 64}.webp"
    capture_key = f"thumbs/{captured}/{'b' * 64}.webp"
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE files SET kind='slides', source_sha256=%s WHERE id IN (%s, %s)",
            (sha, donor, captured),
        )
        conn.execute(
            "UPDATE files SET thumbnail_key=%s WHERE id=%s", (donor_key, donor)
        )
        conn.execute(
            "UPDATE files SET thumbnail_key=%s, thumbnail_captured_at=now() WHERE id=%s",
            (capture_key, captured),
        )
    with workspace._connect() as conn, conn.cursor() as cur:
        assert not thumbnail.db.set_file_thumbnail(
            cur, captured, sha, f"thumbs/{captured}/{'a' * 64}.webp"
        )
        assert not thumbnail.db.share_file_thumbnail(cur, captured, workspace.id, sha)
    assert (
        workspace.scalar("SELECT thumbnail_key FROM files WHERE id=%s", (captured,))
        == capture_key
    )


@pytest.mark.integration
def test_ingest_writes_a_text_preview_only_for_an_untouched_upload(workspace):
    """The save path owns a text source's preview (Epo 2026-10-13): once the
    file has saved edits, rows or a folded state, an ingest of its bytes
    leaves the preview the saves wrote; an untouched upload takes it."""
    sha = "ab" * 32
    untouched = workspace.add_file("notes.md")
    saved = workspace.add_file("draft.md")
    folded = workspace.add_file("folded.md")
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE files SET kind='text', source_sha256=%s WHERE id IN (%s, %s, %s)",
            (sha, untouched, saved, folded),
        )
        for file_id, state, rows in ((saved, None, 1), (folded, b"state", 0)):
            conn.execute(
                """INSERT INTO source_documents (file_id, user_id, format, base_revision,
                     base_blob_path, base_source_sha256, state, log_rows)
                   VALUES (%s, %s, 'text', 1, %s, %s, %s, %s)""",
                (file_id, workspace.user_id, f"p/{file_id}", sha, state, rows),
            )
        conn.execute(
            "UPDATE files SET preview=jsonb_build_object('text', 'saved') WHERE id IN (%s, %s)",
            (saved, folded),
        )
    with workspace._connect() as conn, conn.cursor() as cur:
        for file_id in (untouched, saved, folded):
            thumbnail.db.set_file_text_preview(cur, file_id, sha, "ingested")
    previews = {
        file_id: workspace.scalar(
            "SELECT preview->>'text' FROM files WHERE id=%s", (file_id,)
        )
        for file_id in (untouched, saved, folded)
    }
    assert previews == {untouched: "ingested", saved: "saved", folded: "saved"}


@pytest.mark.integration
def test_an_ingest_waiting_on_a_first_save_keeps_the_saves_preview(workspace):
    """An ingest that writes while a file's first save holds the file row
    waits for the save and then sees its state: the save's preview stays."""
    import psycopg

    sha = "cd" * 32
    file_id = workspace.add_file("first.md")
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE files SET kind='text', source_sha256=%s WHERE id=%s", (sha, file_id)
        )
    # The first save, as SaveSourceCheckpoint orders it: the row lock, the
    # state, then the preview, committed together.
    save = psycopg.connect(workspace.dsn)
    try:
        save.execute("SELECT 1 FROM files WHERE id=%s FOR UPDATE", (file_id,))
        save.execute(
            """INSERT INTO source_documents (file_id, user_id, format, base_revision,
                 base_blob_path, base_source_sha256, state, log_rows)
               VALUES (%s, %s, 'text', 1, %s, %s, %s, 0)""",
            (file_id, workspace.user_id, f"p/{file_id}", sha, b"state"),
        )
        save.execute(
            "UPDATE files SET preview=jsonb_build_object('text', 'first save') WHERE id=%s",
            (file_id,),
        )

        def ingest() -> None:
            with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
                thumbnail.db.set_file_text_preview(cur, file_id, sha, "ingested")
                conn.commit()

        worker = threading.Thread(target=ingest)
        worker.start()
        # Commit only once the ingest waits on the save's row lock.
        deadline = time.monotonic() + 30
        while not workspace.scalar(
            """SELECT count(*) FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'"""
        ):
            assert time.monotonic() < deadline, "the ingest never waited on the save"
            time.sleep(0.02)
        save.commit()
    finally:
        save.close()
    worker.join(30)
    assert not worker.is_alive()
    assert (
        workspace.scalar("SELECT preview->>'text' FROM files WHERE id=%s", (file_id,))
        == "first save"
    )
