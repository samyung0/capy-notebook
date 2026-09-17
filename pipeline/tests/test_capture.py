"""capture_page: the cited-page guard, the per-turn cap, rendering and the
image transport. The provider call itself is covered by the agent tests."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pymupdf
import pytest

from pipeline.retrieval import capture, tools
from pipeline.retrieval.search import Passage
from pipeline.retrieval.tools import ToolContext


def _passage(page: int, **kwargs) -> Passage:
    return Passage(
        chunk_id=kwargs.pop("chunk_id", f"c{page}"),
        file_id=kwargs.pop("file_id", "f_1"),
        file_name="bio.pdf",
        chunk_idx=0,
        section_path="",
        text="Figure 2 shows the leaf.",
        hit_text="Figure 2 shows the leaf.",
        page_start=page,
        page_end=kwargs.pop("page_end", page),
        **kwargs,
    )


def _ctx(*pages: int) -> ToolContext:
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1"])
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "bio.pdf", "chapter_id": None, "chunks": 1},
            {"id": "f_2", "name": "other.pdf", "chapter_id": None, "chunks": 1},
        ],
    }
    tools.assign_citations(ctx, [_passage(p) for p in pages])
    return ctx


@pytest.fixture
def pdf(tmp_path):
    path = tmp_path / "two-pages.pdf"
    with pymupdf.open() as doc:
        for n in (1, 2):
            page = doc.new_page(width=400, height=600)
            page.insert_text((40, 80), f"Page {n}", fontsize=24)
        doc.save(path)
    return path


@pytest.fixture
def rendered(monkeypatch, pdf):
    async def _render_file(workspace_id, file_id, page, bbox, max_edge):
        assert (workspace_id, file_id) == ("ws_1", "f_1")
        return capture.render(pdf, page, bbox, max_edge)

    monkeypatch.setattr(capture, "render_file", _render_file)
    monkeypatch.setattr(tools.cfg, "capture_max_edge", 200)
    return pdf


async def test_capture_needs_a_shown_passage_on_that_page(rendered):
    ctx = _ctx(3)
    result = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "_tool_call_id": "c1"}, ctx
    )
    assert result.refused
    assert "Retrieve a passage that shows this page first" in result.text()
    assert not ctx.pending_images


async def test_capture_refuses_files_outside_the_scope(rendered):
    ctx = _ctx(2)
    result = await tools._capture_page(
        {"file_id": "f_2", "page": 2, "_tool_call_id": "c1"}, ctx
    )
    assert result.refused
    assert result.text() == tools._INVALID_SCOPE


async def test_capture_attaches_the_image_and_adds_no_citation(rendered):
    ctx = _ctx(1, 2)
    result = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "bbox": [0, 0, 500, 500], "_tool_call_id": "c7"},
        ctx,
    )
    assert not result.refused and not result.passages
    # The model is pointed at the number that already covers the page.
    assert "already in the evidence as [2]" in result.text()
    assert len(ctx.citations) == 2
    label, url = ctx.pending_images["c7"]
    assert label == "capture_page result 1: bio.pdf page 2 region [0, 0, 500, 500]"
    assert url.startswith("data:image/jpeg;base64,")
    (record,) = ctx.captures
    assert (record["callId"], record["page"], record["bbox"]) == (
        "c7",
        2,
        [0, 0, 500, 500],
    )
    # A 200x300 pt box rendered to a 200 px long edge.
    assert list(record["pixels"]) == [134, 200]


async def test_capture_stops_at_the_turn_cap_except_in_curate(rendered, monkeypatch):
    monkeypatch.setattr(tools.cfg, "captures_per_turn", 1)
    ctx = _ctx(1)
    first = await tools._capture_page(
        {"file_id": "f_1", "page": 1, "_tool_call_id": "a"}, ctx
    )
    second = await tools._capture_page(
        {"file_id": "f_1", "page": 1, "_tool_call_id": "b"}, ctx
    )
    assert not first.refused
    assert second.refused and second.error_code == "limit_reached"

    # A whole set of materials is one curate turn, and captures leave the
    # request when their exchange folds, so curate has no cap.
    ctx.curate = True
    third = await tools._capture_page(
        {"file_id": "f_1", "page": 1, "_tool_call_id": "c"}, ctx
    )
    assert not third.refused


async def test_capture_rejects_a_page_past_the_end_and_a_bad_box(rendered):
    ctx = _ctx(2, 9)
    past = await tools._capture_page(
        {"file_id": "f_1", "page": 9, "_tool_call_id": "a"}, ctx
    )
    bad = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "bbox": [500, 0, 100, 100], "_tool_call_id": "b"},
        ctx,
    )
    assert past.refused and "between 1 and 2" in past.text()
    assert bad.refused and "bbox" in bad.text()


async def test_capture_names_unsupported_sources(monkeypatch):
    async def _no_pdf(*args):
        raise capture.CaptureUnavailable(
            "capture_page works on parsed PDF and Office sources only"
        )

    monkeypatch.setattr(capture, "render_file", _no_pdf)
    result = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "_tool_call_id": "a"}, _ctx(2)
    )
    assert result.refused and result.error_code == "unsupported_format"


def test_render_scales_the_box_to_the_max_edge(pdf):
    jpeg, box, size = capture.render(pdf, 1, None, 300)
    assert jpeg[:2] == b"\xff\xd8"
    assert box == [0.0, 0.0, 1000.0, 1000.0]
    assert size == (200, 300)
    _, box, size = capture.render(pdf, 2, [100, 100, 900, 300], 300)
    assert box == [100.0, 100.0, 900.0, 300.0]
    # A 320x120 pt box: the long edge lands on max_edge (pixmap rounding aside).
    assert 300 <= size[0] <= 301 and abs(size[0] / size[1] - 320 / 120) < 0.05


def test_images_ride_in_one_user_message_after_the_step_tool_results():
    messages = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": []},
        {"role": "tool", "tool_call_id": "c1", "content": "Captured page 2"},
        {"role": "tool", "tool_call_id": "c2", "content": "Captured page 3"},
        {"role": "assistant", "content": "", "tool_calls": []},
        {"role": "tool", "tool_call_id": "c3", "content": "search result"},
    ]
    images = {
        "c1": ("capture 1", "data:image/jpeg;base64,AA=="),
        "c2": ("capture 2", "data:image/jpeg;base64,BB=="),
    }

    out = capture.inject_images(messages, images, "zai")

    assert [m["role"] for m in out] == [
        "system",
        "user",
        "assistant",
        "tool",
        "tool",
        "user",
        "assistant",
        "tool",
    ]
    parts = out[5]["content"]
    assert parts[0] == {
        "type": "text",
        "text": "Images from the capture_page calls above:",
    }
    assert [p["type"] for p in parts[1:]] == ["text", "image_url", "text", "image_url"]
    assert parts[2]["image_url"]["url"] == "data:image/jpeg;base64,AA=="
    # The originals are untouched and a turn without captures is a no-op.
    assert messages[4]["role"] == "tool" and messages[5]["role"] == "assistant"
    assert capture.inject_images(messages, {}, "zai") is messages


def test_anthropic_gets_an_image_block():
    part = capture.image_part("data:image/jpeg;base64,AA==", "anthropic")
    assert part == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/jpeg", "data": "AA=="},
    }


def test_capture_cache_evicts_least_recently_used(tmp_path):
    now = time.time()
    for name, age in (("a", 30), ("b", 10), ("c", 20)):
        path = tmp_path / f"{name}.pdf"
        path.write_bytes(b"x" * 100)
        os.utime(path, (now - age, now - age))
    capture._evict(tmp_path, 250)
    assert sorted(p.name for p in tmp_path.glob("*.pdf")) == ["b.pdf", "c.pdf"]


def test_capture_page_is_offered_with_the_read_operation():
    ctx = ToolContext(workspace_id="ws_1", operations=frozenset({"source.read"}))
    names = {s["function"]["name"] for s in tools.schemas_for(ctx)}
    assert "capture_page" in names
    assert tools.REGISTRY["capture_page"].handler is tools._capture_page
    spec = json.loads(
        (
            Path(__file__).resolve().parents[1]
            / "pipeline"
            / "generated"
            / "agent_tools.json"
        ).read_text()
    )
    assert spec["version"] == tools.contract.VERSION
    assert any(t["name"] == "capture_page" for t in spec["tools"])


def _jpeg(width: int, height: int) -> bytes:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, "JPEG", quality=80)
    return buffer.getvalue()


def test_context_measurement_counts_images_by_pixels_not_base64():
    """A 1568 px JPEG is ~300 KB of base64, which the JSON counter would read
    as ~100k tokens; the request is measured with the patch estimate instead."""
    from pipeline.registry import ModelConfig
    from pipeline.retrieval import models

    spec = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        thinking_levels=("low", "high", "max"),
        default_thinking="low",
        context_window_tokens=200_000,
        slots=("chat",),
    )
    jpeg = _jpeg(1568, 1120)
    base = [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}]
    with_image = capture.inject_images(
        base + [{"role": "tool", "tool_call_id": "k1", "content": "Captured page 1."}],
        {"k1": ("capture_page result 1", capture.data_url(jpeg))},
        "zai",
    )
    plain = models.measure_request_context(base, model=spec).total_tokens
    measured = models.measure_request_context(with_image, model=spec).total_tokens
    expected_image = capture.patch_tokens(1568, 1120)
    assert expected_image == 56 * 40
    # Label text and the tool result add a few dozen tokens; the image adds its patches.
    assert expected_image < measured - plain < expected_image + 200
    stripped, tokens = capture.split_images(with_image)
    assert tokens == expected_image
    assert all(
        p["type"] == "text"
        for m in stripped
        for p in (m["content"] if isinstance(m["content"], list) else [])
    )
    # The Anthropic block shape measures the same.
    anthropic = capture.inject_images(
        base + [{"role": "tool", "tool_call_id": "k1", "content": "Captured page 1."}],
        {"k1": ("capture 1", capture.data_url(jpeg))},
        "anthropic",
    )
    assert anthropic[-1]["content"][-1]["type"] == "image"
    assert capture.split_images(anthropic)[1] == expected_image
    captures = [
        {"callId": "k1", "estimatedImageTokens": 10},
        {"callId": "k2", "estimatedImageTokens": 5},
    ]
    assert capture.image_tokens(captures) == 15
    # k1's exchange folded into the turn note: its image no longer rides along.
    folded = [{"role": "user", "content": "note", "_kind": "turn_note"}] + [
        {"role": "tool", "tool_call_id": "k2", "content": "Captured page 2."}
    ]
    assert capture.image_tokens(captures, folded) == 5


async def test_pdf_cache_is_keyed_by_the_stored_object(tmp_path, monkeypatch):
    """A replaced PDF source publishes a new source path; the old render
    must not be served under the new chunk regions."""
    monkeypatch.setattr(capture.cfg, "capture_cache_dir", str(tmp_path))
    rows = {
        "old": {
            "kind": "pdf",
            "blob_path": "previews/s/v1/fp1.pdf",
            "size_bytes": 10,
        },
        "new": {
            "kind": "pdf",
            "blob_path": "previews/s/v2/fp2.pdf",
            "size_bytes": 10,
        },
    }
    current = {"row": rows["old"]}
    downloads: list[str] = []

    async def _row(workspace_id, file_id):
        return current["row"]

    def _download(blob, target, max_bytes):
        downloads.append(blob)
        target.write_bytes(b"%PDF " + blob.encode())

    monkeypatch.setattr(capture.store, "file_page_source", _row)
    monkeypatch.setattr(capture, "_download", _download)

    first = await capture.pdf_path("ws_1", "f_1")
    again = await capture.pdf_path("ws_1", "f_1")
    current["row"] = rows["new"]
    after_reparse = await capture.pdf_path("ws_1", "f_1")

    assert first == again and first.name == capture.cache_name("previews/s/v1/fp1.pdf")
    assert after_reparse != first
    assert downloads == ["previews/s/v1/fp1.pdf", "previews/s/v2/fp2.pdf"]
    assert after_reparse.read_bytes().endswith(b"previews/s/v2/fp2.pdf")


def _capture_target(pages: list[int]):
    from pipeline.retrieval import library

    return library.CaptureTarget(
        excerpt_id="e_1",
        book_id="ahss",
        book_title="Advanced High School Statistics",
        object_key="books/aaa.pdf",
        bytes=1024,
        pages=pages,
    )


async def test_knowledge_capture_is_bounded_by_the_excerpt_pages(monkeypatch, pdf):
    """An excerpt is the unit the curate model works in: it may look at its own
    pages and its figures' pages, not browse the book."""
    rendered: list[tuple] = []

    async def _target(excerpt_id):
        assert excerpt_id == "e_1"
        return _capture_target([338, 339, 341])

    async def _render(object_key, max_bytes, page, bbox, max_edge):
        rendered.append((object_key, max_bytes, page))
        return capture.render(pdf, 1, bbox, max_edge)

    monkeypatch.setattr(tools.library, "capture_target", _target)
    monkeypatch.setattr(capture, "render_knowledge", _render)
    ctx = ToolContext(workspace_id="ws_1", curate=True)

    outside = await tools._capture_knowledge_page(
        {"excerpt_id": "e_1", "page": 400, "_tool_call_id": "a"}, ctx
    )
    assert outside.refused and "pages 338, 339, 341" in outside.text()
    assert not rendered and not ctx.pending_images

    # 341 is the page of one of the excerpt's figures.
    inside = await tools._capture_knowledge_page(
        {"excerpt_id": "e_1", "page": 341, "_tool_call_id": "b"}, ctx
    )
    assert not inside.refused and not inside.passages, "a capture adds no citation"
    label, url = ctx.pending_images["b"]
    assert label == (
        "capture_knowledge_page result 1: Advanced High School Statistics page 341"
    )
    assert url.startswith("data:image/jpeg;base64,")
    assert rendered == [("books/aaa.pdf", 1024, 341)]
    assert ctx.captures[0]["fileId"] == "e_1" and ctx.captures[0]["page"] == 341

    # Curate mode has no per-turn capture cap: a capture is dropped when its
    # exchange folds into the turn note anyway.
    monkeypatch.setattr(tools.cfg, "captures_per_turn", 1)
    again = await tools._capture_knowledge_page(
        {"excerpt_id": "e_1", "page": 338, "_tool_call_id": "c"}, ctx
    )
    assert not again.refused and len(ctx.captures) == 2


async def test_knowledge_pdf_cache_is_keyed_by_the_object_key(tmp_path, monkeypatch):
    monkeypatch.setattr(capture.cfg, "capture_cache_dir", str(tmp_path))
    downloads: list[tuple[str, int]] = []

    def _download(object_key, local_path, max_bytes):
        downloads.append((object_key, max_bytes))
        Path(local_path).write_bytes(b"%PDF " + object_key.encode())
        return len(object_key) + 5, "sha"

    monkeypatch.setattr(capture.blobstore, "library_download_file", _download)

    first = await capture.knowledge_pdf_path("books/aaa.pdf", 1024)
    again = await capture.knowledge_pdf_path("books/aaa.pdf", 1024)
    other = await capture.knowledge_pdf_path("books/bbb.pdf", 2048)

    assert first == again == tmp_path / capture.cache_name("books/aaa.pdf")
    assert other != first and first.read_bytes().endswith(b"books/aaa.pdf")
    assert downloads == [("books/aaa.pdf", 1024), ("books/bbb.pdf", 2048)]
    with pytest.raises(capture.CaptureUnavailable):
        await capture.knowledge_pdf_path("", 10)


def test_office_capture_returns_only_jpeg_and_removes_temporary_source(monkeypatch):
    import base64
    import hashlib
    from contextlib import contextmanager

    data = b"editable-office-source"
    jpeg = _jpeg(100, 100)
    downloaded_paths = []

    def download(key, path, limit):
        assert key == "sources/office" and limit == len(data)
        target = Path(path)
        downloaded_paths.append(target)
        target.write_bytes(data)
        return len(data), hashlib.sha256(data).hexdigest()

    @contextmanager
    def post(url, **kwargs):
        assert url == "http://parser.test/capture_page"
        assert kwargs["files"]["file"][1].read() == data

        class Response:
            def raise_for_status(self):
                pass

            def iter_content(self, _size):
                yield json.dumps(
                    {
                        "jpeg": base64.b64encode(jpeg).decode(),
                        "box": [0, 0, 1000, 1000],
                        "size": [100, 100],
                    }
                ).encode()

        yield Response()

    monkeypatch.setattr(capture.cfg, "parser_url", "http://parser.test/file_parse")
    monkeypatch.setattr(capture.blobstore, "download_file", download)
    monkeypatch.setattr(capture.requests, "post", post)
    result = capture._office_capture(
        {
            "name": "source.docx",
            "blob_path": "sources/office",
            "size_bytes": len(data),
            "source_sha256": hashlib.sha256(data).hexdigest(),
        },
        1,
        None,
        100,
    )
    assert result[0] == jpeg and result[2] == (100, 100)
    assert downloaded_paths and all(
        not path.parent.exists() for path in downloaded_paths
    )


@pytest.mark.parametrize(
    "kind,extension",
    [("doc", "docx"), ("sheet", "xlsx"), ("slides", "pptx"), ("pdf", "pdf")],
)
async def test_capture_uses_stored_format_after_rename(
    monkeypatch, pdf, kind, extension
):
    row = {
        "kind": kind,
        "name": "renamed.docx" if kind == "pdf" else "renamed without extension",
        "ever_parsed_successfully": True,
        "parse_mode": "standard",
        "blob_path": "source/blob",
    }
    expected = capture.render(pdf, 1, None, 100)
    calls = []

    async def source(*_args):
        return row

    async def pdf_path(*_args):
        calls.append("pdf")
        return pdf

    def office(source_row, page, bbox, max_edge):
        calls.append(source_row["name"])
        assert (page, bbox, max_edge) == (1, None, 100)
        return expected

    monkeypatch.setattr(capture.store, "file_page_source", source)
    monkeypatch.setattr(capture, "pdf_path", pdf_path)
    monkeypatch.setattr(capture, "_office_capture", office)
    assert await capture.render_file("ws_1", "f_1", 1, None, 100) == expected
    assert calls == ["pdf" if kind == "pdf" else f"source.{extension}"]
