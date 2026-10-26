"""capture_page: the cited-page guard, the per-turn cap, rendering and the
image transport. The provider call itself is covered by the agent tests."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import pymupdf
import pytest

from pipeline.retrieval import capture, pending, tools
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


@pytest.fixture(autouse=True)
def no_office_files(monkeypatch):
    """capture_page looks the file's kind up first; these files are no Office
    files unless a test says so."""

    async def office_file(*_args):
        return False

    monkeypatch.setattr(capture, "office_file", office_file)


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
    assert '"f_2" is outside the sources chosen for this chat' in result.text()


async def test_capture_attaches_the_image_and_adds_no_citation(rendered):
    ctx = _ctx(1, 2)
    ctx.pending_sources = pending.PendingSources(
        [
            {
                "fileId": "f_1",
                "name": "bio.pdf",
                "epoch": 1,
                "checkpoint": 2,
                "indexedCheckpoint": 1,
                "changes": [
                    {
                        "id": "c",
                        "kind": "text",
                        "operation": "replace",
                        "before": "old",
                        "after": "leaf relabelled",
                    }
                ],
            }
        ],
        read_ids=set(),
    )
    result = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "bbox": [0, 0, 500, 500], "_tool_call_id": "c7"},
        ctx,
    )
    assert not result.refused and not result.passages
    # A capture is a read: it passes the page's file changes on (r3 M17).
    assert "leaf relabelled" in result.pending
    # The model is pointed at the number that already covers the page; the
    # playground builds the same text through tools._capture_note.
    assert result.text() == (
        "Captured bio.pdf page 2 region [0, 0, 500, 500] as capture 1. The rendered "
        "image is attached to the next message; read it directly. This page is "
        "already in the evidence as [2]; cite those numbers for what the capture shows."
    )
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


async def test_a_message_allows_sixteen_images(monkeypatch, rendered):
    """The 16th image returns with the limit sentence and later image calls
    are refused, also when a response's captures run side by side (Epo
    2026-10-21, 16 since 2026-10-22)."""
    real = capture.render_file

    async def _side_by_side(*args):
        await asyncio.sleep(0)
        return await real(*args)

    monkeypatch.setattr(capture, "render_file", _side_by_side)
    ctx = _ctx(2)
    results = await asyncio.gather(
        *(
            tools._capture_page(
                {"file_id": "f_1", "page": 2, "_tool_call_id": f"k{n}"}, ctx
            )
            for n in range(1, 18)
        )
    )
    taken = [r for r in results if not r.refused]
    assert len(taken) == 16 == len(ctx.pending_images)
    assert [r.text().endswith(tools.IMAGE_LIMIT) for r in taken] == [False] * 15 + [
        True
    ]
    knowledge = await tools._capture_knowledge_page(
        {"excerpt_id": "e_1", "page": 1, "_tool_call_id": "k18"}, ctx
    )
    for refused in [*(r for r in results if r.refused), knowledge]:
        assert refused.error_code == "limit_reached"
        assert refused.text() == tools.IMAGE_LIMIT


def test_an_image_no_request_carried_is_never_dropped():
    """(Q349) A drop takes only images an earlier request carried: past the
    budget, the carried ones go oldest first, and the new ones stay even when
    they alone are past half the budget (a capture edge raised by config)."""
    ctx = ToolContext(workspace_id="ws_1")
    for n, tokens in enumerate([10_000, 10_000, 10_000, 12_000, 12_000], 1):
        call_id = f"k{n}"
        ctx.captures.append({"callId": call_id, "estimatedImageTokens": tokens})
        ctx.pending_images[call_id] = (f"capture_page result {n}", f"url{n}")
        ctx.budget_images.add(call_id)
    ctx.images_sent.update({"k1", "k2", "k3"})

    tools.keep_images_within_budget(ctx)

    assert sorted(ctx.pending_images) == ["k4", "k5"]


async def test_dropped_captures_still_count_toward_the_sixteen(monkeypatch):
    """(Q349) The image budget drops old captures from the requests, but each
    capture still counts toward the 16 per message: the 17th is refused with
    the limit sentence as before."""

    async def _render_file(*_args):
        return _jpeg(8, 8), [0.0, 0.0, 1000.0, 1000.0], (1568, 1568)

    monkeypatch.setattr(capture, "render_file", _render_file)
    ctx = _ctx(2)
    for n in range(1, 17):
        result = await tools._capture_page(
            {"file_id": "f_1", "page": 2, "_tool_call_id": f"k{n}"}, ctx
        )
        assert not result.refused
        ctx.images_sent.update(ctx.pending_images)  # a request carried it
        tools.keep_images_within_budget(ctx)
    assert len(ctx.pending_images) < 16  # the budget dropped some
    later = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "_tool_call_id": "k17"}, ctx
    )
    assert later.refused and later.error_code == "limit_reached"
    assert later.text() == tools.IMAGE_LIMIT
    assert ctx.images_taken == 16 and "k17" not in ctx.pending_images


async def test_source_change_images_share_the_cap(monkeypatch, rendered):
    """resolve_source_change's images count with the page captures both ways:
    a 16th image from a capture carries the sentence, and a source change's
    image past the cap fails with the reason (Epo 2026-10-22)."""

    async def _resolve(**_kwargs):
        return _jpeg(40, 20)

    monkeypatch.setattr(tools.pending, "resolve", _resolve)
    ctx = _ctx(2)

    def change(call_id: str):
        args = {"file_id": "f_1", "change_id": "c", "checkpoint": 1}
        return tools._resolve_source_change(args | {"_tool_call_id": call_id}, ctx)

    first = await change("r1")
    assert not first.refused and not first.failed
    assert tools.IMAGE_LIMIT not in first.text()
    for n in range(2, 16):
        page = await tools._capture_page(
            {"file_id": "f_1", "page": 2, "_tool_call_id": f"k{n}"}, ctx
        )
        assert not page.refused and tools.IMAGE_LIMIT not in page.text()
    sixteenth = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "_tool_call_id": "k16"}, ctx
    )
    assert not sixteenth.refused and sixteenth.text().endswith(tools.IMAGE_LIMIT)

    past = await change("r17")
    assert past.failed and past.error_code == "limit_reached"
    assert past.text() == tools.SOURCE_IMAGE_LIMIT
    assert len(ctx.pending_images) == 16 and "r17" not in ctx.pending_images


async def test_two_source_images_side_by_side_at_fifteen_attach_one(monkeypatch):
    """Review r2 M1: the check after the render keeps parallel source changes
    under the cap."""

    async def _resolve(**_kwargs):
        await asyncio.sleep(0)  # both pass the check before the render
        return _jpeg(40, 20)

    monkeypatch.setattr(tools.pending, "resolve", _resolve)
    ctx = ToolContext(workspace_id="ws_1", images_taken=15)
    results = await asyncio.gather(
        *(
            tools._resolve_source_change(
                {"file_id": "f_1", "change_id": c, "checkpoint": 1, "_tool_call_id": c},
                ctx,
            )
            for c in ("r1", "r2")
        )
    )
    assert sorted(r.outcome for r in results) == ["failed", "succeeded"]
    assert ctx.images_taken == 16 and len(ctx.pending_images) == 1


async def test_two_knowledge_captures_side_by_side_at_fifteen_attach_one(
    monkeypatch, pdf
):
    """Review r2 M1: the same for capture_knowledge_page."""

    async def _target(excerpt_id):
        return _capture_target([338, 339])

    async def _render(object_key, max_bytes, page, bbox, max_edge):
        await asyncio.sleep(0)  # both pass the check before the render
        return capture.render(pdf, 1, bbox, max_edge)

    monkeypatch.setattr(tools.library, "capture_target", _target)
    monkeypatch.setattr(capture, "render_knowledge", _render)
    ctx = ToolContext(workspace_id="ws_1", images_taken=15)
    results = await asyncio.gather(
        *(
            tools._capture_knowledge_page(
                {"excerpt_id": "e_1", "page": page, "_tool_call_id": f"k{page}"}, ctx
            )
            for page in (338, 339)
        )
    )
    assert sorted(r.outcome for r in results) == ["refused", "succeeded"]
    assert ctx.images_taken == 16 and len(ctx.pending_images) == 1


async def test_a_source_image_that_is_the_sixteenth_says_nothing(monkeypatch, rendered):
    """The limit sentence comes only with a capture (Epo 2026-10-22)."""

    async def _resolve(**_kwargs):
        return _jpeg(40, 20)

    monkeypatch.setattr(tools.pending, "resolve", _resolve)
    ctx = _ctx(2)
    for n in range(1, 16):
        await tools._capture_page(
            {"file_id": "f_1", "page": 2, "_tool_call_id": f"k{n}"}, ctx
        )
    args = {"file_id": "f_1", "change_id": "c", "checkpoint": 1}
    sixteenth = await tools._resolve_source_change(args | {"_tool_call_id": "r16"}, ctx)
    assert not sixteenth.failed and "r16" in ctx.pending_images
    assert tools.IMAGE_LIMIT not in sixteenth.text()
    later = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "_tool_call_id": "k17"}, ctx
    )
    assert later.refused and later.error_code == "limit_reached"


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
        "text": "Images from the tool calls above:",
    }
    assert [p["type"] for p in parts[1:]] == ["text", "image_url", "text"] * 2
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


def test_injected_captures_keep_their_estimate_without_a_decode(monkeypatch):
    """(security regression: rate-limit audit Q238) The request built for a
    model call carries its capture images with their recorded pixel estimate,
    so measuring it decodes no image; the estimate equals the decoded one."""
    from pipeline.registry import ModelConfig
    from pipeline.retrieval import models

    decoded: list = []
    real = capture._image_bytes
    monkeypatch.setattr(
        capture, "_image_bytes", lambda part: decoded.append(part) or real(part)
    )
    spec = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        platform_enabled=True,
        byok_enabled=False,
        thinking_levels=("low", "high"),
        default_thinking="high",
    )
    messages = [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "capture_page", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "Captured page 1."},
    ]
    images = {"c1": ("capture_page result 1", capture.data_url(_jpeg(560, 280)))}

    kept = capture.inject_images(
        messages, images, "zai", {"c1": capture.patch_tokens(560, 280)}
    )
    measured = models.measure_request_context(kept, model=spec)
    assert decoded == []

    fresh = capture.inject_images(messages, images, "zai")
    assert models.measure_request_context(fresh, model=spec) == measured
    assert decoded


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
    assert anthropic[-1]["content"][-2]["type"] == "image"
    assert capture.split_images(anthropic)[1] == expected_image
    captures = [
        {"callId": "k1", "estimatedImageTokens": 10},
        {"callId": "k2", "estimatedImageTokens": 5},
    ]
    attached = {"k1": ("capture 1", "u1"), "k2": ("capture 2", "u2")}
    assert capture.image_tokens(captures, attached) == 15


def test_a_request_after_a_drop_counts_only_its_attached_images():
    """(security regression: rate-limit audit Q238; Q349) A capture the budget
    dropped is no longer among the images passed in, though the turn's token
    map still holds it: the images message keeps an estimate of its text and
    its own images only, the same as measuring it by decoding."""
    from pipeline.registry import ModelConfig
    from pipeline.retrieval import accounting, models

    spec = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        platform_enabled=True,
        byok_enabled=False,
        thinking_levels=("low", "high"),
        default_thinking="high",
    )
    messages = [
        {"role": "assistant", "content": "", "tool_calls": []},
        {"role": "tool", "tool_call_id": "k1", "content": "Captured page 1."},
        {"role": "tool", "tool_call_id": "k2", "content": "Captured page 2."},
    ]
    images = {"k2": ("capture_page result 2", capture.data_url(_jpeg(560, 280)))}
    tokens = {
        "k1": capture.patch_tokens(1568, 1568),
        "k2": capture.patch_tokens(560, 280),
    }

    kept = capture.inject_images(messages, images, "zai", tokens)
    fresh = capture.inject_images(messages, images, "zai")

    assert [part["type"] for part in kept[-1]["content"]] == [
        "text",
        "text",
        "image_url",
        "text",
    ]
    assert accounting.kept_tokens(kept[-1]) is not None
    measured = models.measure_request_context(fresh, model=spec)
    assert models.measure_request_context(kept, model=spec) == measured


def test_a_folded_capture_stays_attached_after_the_turn_note():
    """Live compaction folded k1's exchange into the turn note: its image rides
    right after the note until the answer (Epo 2026-10-21)."""
    messages = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "q", "_kind": "query"},
        {"role": "user", "content": "note", "_kind": "turn_note"},
        {"role": "assistant", "content": "", "tool_calls": []},
        {"role": "tool", "tool_call_id": "k2", "content": "Captured page 2."},
    ]
    images = {
        "k1": ("capture 1", "data:image/jpeg;base64,AA=="),
        "k2": ("capture 2", "data:image/jpeg;base64,BB=="),
    }

    out = capture.inject_images(messages, images, "zai")

    assert [m.get("_kind") or m["role"] for m in out] == [
        "system",
        "query",
        "turn_note",
        "user",
        "assistant",
        "tool",
        "user",
    ]
    assert (
        out[3]["content"][0]["text"] == "Images from the tool calls this note folded:"
    )
    assert out[3]["content"][2]["image_url"]["url"].endswith("AA==")
    assert out[6]["content"][2]["image_url"]["url"].endswith("BB==")


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


def _capture_target(pages: list[int], withheld: tuple[int, ...] = ()):
    from pipeline.retrieval import library

    return library.CaptureTarget(
        excerpt_id="e_1",
        book_id="ahss",
        book_title="Advanced High School Statistics",
        object_key="books/aaa.pdf",
        bytes=1024,
        pages=pages,
        withheld_pages=list(withheld),
    )


async def test_knowledge_capture_refuses_a_withheld_page_as_withheld(monkeypatch):
    """Not the generic page refusal, so the agent does not try another excerpt."""

    async def _target(excerpt_id):
        return _capture_target([338], withheld=(339,))

    async def _render(*args):
        raise AssertionError("a withheld page is never rendered")

    monkeypatch.setattr(tools.library, "capture_target", _target)
    monkeypatch.setattr(capture, "render_knowledge", _render)
    ctx = ToolContext(workspace_id="ws_1")
    refused = await tools._capture_knowledge_page(
        {"excerpt_id": "e_1", "page": 339, "_tool_call_id": "a"}, ctx
    )
    assert refused.refused and "Page 339" in refused.text()
    assert "withheld from the library" in refused.text()
    assert "covers pages" not in refused.text() and not ctx.pending_images


async def test_knowledge_capture_is_bounded_by_the_excerpt_pages(monkeypatch, pdf):
    """An excerpt is the unit the model works in: it may look at its own
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
    ctx = ToolContext(workspace_id="ws_1")

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


async def test_capture_names_inspect_office_document_before_asking_for_a_passage(
    monkeypatch, rendered
):
    """An Office file is refused at once, cited page or not (Q283), so the
    model is not sent searching for a passage to capture."""

    async def office_file(workspace_id, file_id):
        return (workspace_id, file_id) == ("ws_1", "f_1")

    monkeypatch.setattr(capture, "office_file", office_file)
    for ctx in (_ctx(), _ctx(2)):
        result = await tools._capture_page(
            {"file_id": "f_1", "page": 2, "_tool_call_id": "c1"}, ctx
        )
        assert result.refused and result.error_code == "unsupported_format"
        assert capture.OFFICE_NO_PAGES in result.text()
        assert not ctx.pending_images and ctx.images_taken == 0


@pytest.mark.parametrize(
    ("kind", "name", "outcome"),
    [
        ("doc", "plan.docx", "office"),
        ("sheet", "grades.XLSX", "office"),
        ("slides", "deck.pptx", "office"),
        ("sheet", "marks.csv", "no pdf"),
        ("sheet", "marks.tsv", "no pdf"),
        ("doc", "old.doc", "no pdf"),
        ("slides", "old.ppt", "no pdf"),
        ("pdf", "renamed.docx", "renders"),
    ],
)
async def test_capture_refuses_only_the_office_files_inspect_reads(
    monkeypatch, pdf, kind, name, outcome
):
    """A Word, Excel or PowerPoint file inspect_office_document reads (its
    kind and a .docx, .xlsx or .pptx name, as Go's SourceEditFormat) has no
    page view (Q283): the refusal names inspect_office_document. CSV, TSV and
    legacy .doc, .xls and .ppt files keep the page-less source's refusal, and
    a PDF renders whatever its name (Q396, review r1 L3)."""
    row = {
        "kind": kind,
        "name": name,
        "ever_parsed_successfully": True,
        "parse_mode": "standard",
        "blob_path": "source/blob",
    }

    async def source(*_args):
        return row

    monkeypatch.setattr(capture.store, "file_page_source", source)
    assert capture.is_office(row) is (outcome == "office")
    if outcome == "renders":

        async def pdf_path(*_args):
            return pdf

        monkeypatch.setattr(capture, "pdf_path", pdf_path)
        expected = capture.render(pdf, 1, None, 100)
        assert await capture.render_file("ws_1", "f_1", 1, None, 100) == expected
        return
    with pytest.raises(capture.CaptureUnavailable) as no:
        await capture.render_file("ws_1", "f_1", 1, None, 100)
    assert no.value.code == "unsupported_format"
    if outcome == "office":
        assert str(no.value) == capture.OFFICE_NO_PAGES
    else:
        assert str(no.value) == "this source has no retained PDF"


# ------------------------------------------------------------- Office pictures


def test_a_picture_crop_box_stays_inside_the_picture():
    """Security regression (review r1 L1, Q381): an Office picture's crop is
    what the file says, any finite value in a DOCX and null in an XLSX: a
    side that is no finite number reads as 0, a padding (negative) side as 0,
    a side past 1 as 1, and a pair leaving nothing leaves that axis whole, so
    the box never leaves the picture or turns empty."""
    box = capture.crop_box
    assert box(None) == [0, 0, 1000, 1000]
    assert box({"left": 0.125, "top": 0.25}) == [125, 250, 1000, 1000]
    for junk in (None, float("nan"), float("inf"), -float("inf"), "0.5", True):
        assert box({"left": junk, "right": 0.5}) == [0, 0, 500, 1000]
    assert box({"left": -0.5, "right": 0.25}) == [0, 0, 750, 1000]
    assert box({"top": 7.0, "bottom": 0.0}) == [0, 0, 1000, 1000]
    assert box({"left": 0.75, "right": 0.25, "top": 0.5}) == [0, 500, 1000, 1000]
    assert box({"top": 0.5, "bottom": 0.375}) == [0, 500, 1000, 625]
    assert box([0.1, 0.1, 0.1, 0.1]) == [0, 0, 1000, 1000]


def _halves(width: int, height: int) -> bytes:
    """A PNG red on its left half and blue on its right."""
    import io

    from PIL import Image

    image = Image.new("RGB", (width, height), (255, 0, 0))
    image.paste((0, 0, 255), (width // 2, 0, width, height))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def test_a_picture_is_sent_with_its_crop_applied():
    import io

    from PIL import Image

    jpeg, box, size = capture.picture_jpeg(_halves(200, 100), {"left": 0.5}, 1568)
    assert box == [500, 0, 1000, 1000] and size == (100, 100)
    with Image.open(io.BytesIO(jpeg)) as image:
        red, _, blue = image.convert("RGB").getpixel((50, 50))
    assert blue > 200 and red < 50


@pytest.mark.parametrize("gif_frame", [False, True])
def test_a_picture_past_the_side_limit_is_refused_before_decoding(
    monkeypatch, gif_frame
):
    """Security regression (review r1 L3, r2, Q381, Q384): the engine lists a
    picture from its header alone, so the AI process checks the size Pillow
    reads before any pixel is decoded: a picture past IMAGE_MAX_SIDE (the
    upload check's limit) is refused, a GIF whose first frame passes its small
    logical screen included."""
    import io
    import struct

    from PIL import Image

    side = capture.IMAGE_MAX_SIDE + 1
    buffer = io.BytesIO()
    if gif_frame:
        Image.new("P", (side, 4)).save(buffer, "GIF")
        data = bytearray(buffer.getvalue())
        data[6:8] = struct.pack("<H", 10)  # the logical screen says 10 wide
        data = bytes(data)
    else:
        Image.new("RGB", (side, 4)).save(buffer, "PNG")
        data = buffer.getvalue()

    def decoded(*_args):
        raise AssertionError("decoded past the side limit")

    monkeypatch.setattr(capture, "_decoded", decoded)
    with pytest.raises(capture.CaptureUnavailable, match=f"{side} by 4 pixels"):
        capture.picture_jpeg(data, None, 1568)


def test_pictures_of_one_call_follow_its_result_in_order():
    """Several pictures of one inspect_office_document call ride after its
    tool result, each its own image; a folded call's ride after the note."""
    url = capture.data_url(_jpeg(8, 8))
    images = {
        capture.picture_id("c1", 1): ("first", url),
        "c2": ("capture", url),
        capture.picture_id("c1", 2): ("second", url),
        capture.picture_id("gone", 1): ("folded", url),
    }
    messages = [
        {"role": "user", "content": "q"},
        {"role": "user", "_kind": "turn_note", "content": "note"},
        {"role": "assistant", "content": "", "tool_calls": []},
        {"role": "tool", "tool_call_id": "c1", "content": "pictures"},
        {"role": "tool", "tool_call_id": "c2", "content": "page"},
    ]
    out = capture.inject_images(messages, images)

    def labels(message):
        return [
            part["text"].split("\n")[0]
            for part in message["content"]
            if part["type"] == "text" and part["text"].endswith("<source>")
        ]

    assert labels(out[2]) == ["folded"]
    assert [m.get("tool_call_id") for m in out[4:6]] == ["c1", "c2"]
    assert labels(out[6]) == ["first", "second", "capture"]


# ------------------------------------------------------------- image sources


def _png(width: int, height: int) -> bytes:
    import io

    from PIL import Image

    # Half-transparent red: flattening on white must give pink, not dark red.
    image = Image.new("RGBA", (width, height), (255, 0, 0, 128))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _image_row(data: bytes, name: str = "photo.png") -> dict:
    import hashlib

    return {
        "kind": "image",
        "name": name,
        "parse_mode": "none",
        "ever_parsed_successfully": False,
        "blob_path": "sources/photo",
        "source_sha256": hashlib.sha256(data).hexdigest(),
        "size_bytes": len(data),
    }


def _attached(ctx: ToolContext, call_id: str):
    import base64
    import io

    from PIL import Image

    label, url = ctx.pending_images[call_id]
    return label, Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1])))


async def test_image_source_is_its_own_page_one(monkeypatch):
    data = _png(300, 200)
    row = _image_row(data)

    async def _source(workspace_id, file_id):
        assert (workspace_id, file_id) == ("ws_1", "f_1")
        return row

    def download(key, path, limit):
        assert key == "sources/photo" and limit == len(data)
        Path(path).write_bytes(data)
        return len(data), row["source_sha256"]

    monkeypatch.setattr(capture.store, "file_page_source", _source)
    monkeypatch.setattr(capture.blobstore, "download_file", download)
    monkeypatch.setattr(tools.cfg, "capture_max_edge", 200)
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1"])
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "photo.png", "chapter_id": None, "chunks": 1}],
    }
    # The caption chunk carries no page: it cites the image as a whole.
    tools.assign_citations(ctx, [_passage(None)])

    whole = await tools._capture_page(
        {"file_id": "f_1", "page": 1, "_tool_call_id": "a"}, ctx
    )
    assert not whole.refused, whole.text()
    assert "[1]" in whole.text()
    label, image = _attached(ctx, "a")
    assert label.endswith("photo.png page 1")
    assert image.size == (200, 133) and image.mode == "RGB"
    red, green, blue = image.getpixel((100, 66))
    assert red > 245 and 118 <= green <= 138 and 118 <= blue <= 138

    boxed = await tools._capture_page(
        {"file_id": "f_1", "page": 1, "bbox": [0, 0, 500, 1000], "_tool_call_id": "b"},
        ctx,
    )
    assert not boxed.refused, boxed.text()
    assert _attached(ctx, "b")[1].size == (150, 200)

    # A page-less passage cites page 1 only, and the renderer agrees.
    second = await tools._capture_page(
        {"file_id": "f_1", "page": 2, "_tool_call_id": "c"}, ctx
    )
    assert second.refused and "Retrieve a passage" in second.text()
    with pytest.raises(ValueError, match="an image has one page"):
        capture._image_capture(row, 2, None, 200)


async def test_text_source_still_refuses_through_the_renderer(monkeypatch):
    async def _source(workspace_id, file_id):
        return {
            "kind": "txt",
            "name": "notes.txt",
            "parse_mode": "none",
            "blob_path": "sources/notes",
            "source_sha256": "",
            "size_bytes": 12,
        }

    monkeypatch.setattr(capture.store, "file_page_source", _source)
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1"])
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "notes.txt", "chapter_id": None, "chunks": 1}],
    }
    tools.assign_citations(ctx, [_passage(None)])
    result = await tools._capture_page(
        {"file_id": "f_1", "page": 1, "_tool_call_id": "a"}, ctx
    )
    assert result.refused and result.error_code == "unsupported_format"
    assert "no retained PDF" in result.text()


async def test_capture_refuses_a_note_as_a_note():
    ctx = ToolContext(workspace_id="ws_1")
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {
                "id": "mat_1",
                "name": "Notes",
                "chapter_id": None,
                "chunks": 1,
                "kind": "material",
                "material_kind": "note",
            }
        ],
    }
    tools.assign_citations(ctx, [_passage(None, file_id="mat_1")])
    result = await tools._capture_page(
        {"file_id": "mat_1", "page": 1, "_tool_call_id": "a"}, ctx
    )
    assert result.refused and "That id is a note" in result.text()


def test_image_capture_refuses_a_decompression_bomb_as_too_large(monkeypatch):
    from PIL import Image

    data = _png(300, 200)
    row = _image_row(data)

    def download(key, path, limit):
        Path(path).write_bytes(data)
        return len(data), row["source_sha256"]

    monkeypatch.setattr(capture.blobstore, "download_file", download)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 10)
    with pytest.raises(capture.CaptureUnavailable, match="too large"):
        capture._image_capture(row, 1, None, 200)


def test_image_capture_decodes_a_large_photo_at_the_capture_size(monkeypatch):
    """A 64-megapixel JPEG decodes at a reduced scale, never at full size, and
    the capture keeps its size and format (Q239)."""
    import io

    from PIL import Image, ImageFile

    photo = io.BytesIO()
    Image.new("L", (8000, 8000), 128).save(photo, "JPEG")
    decoded: list[int] = []
    real_load = ImageFile.ImageFile.load

    def load(self):
        answer = real_load(self)
        decoded.append(self.width * self.height)
        return answer

    monkeypatch.setattr(ImageFile.ImageFile, "load", load)
    jpeg, _box, size = capture.image_jpeg(photo, [0, 0, 500, 1000], 200)
    assert size == (100, 200)
    assert Image.open(io.BytesIO(jpeg)).format == "JPEG"
    # The 1/8 DCT scale: one megapixel decoded for a 200-pixel capture.
    assert decoded and max(decoded) <= 1000 * 1000


@pytest.mark.parametrize("format_name", ["JPEG", "TIFF"])
def test_a_reduced_capture_stands_an_oriented_photo_upright(format_name):
    """Pillow turns a TIFF upright as it loads and exif_transpose turns a
    JPEG: either way the reduced capture is upright, at its full-size shape."""
    import io

    from PIL import Image

    photo = Image.new("RGB", (800, 400), "blue")
    photo.paste("red", (0, 0, 400, 400))
    exif = Image.Exif()
    exif[0x0112] = 6  # shown turned a quarter clockwise
    source = io.BytesIO()
    photo.save(source, format_name, exif=exif)

    jpeg, _box, size = capture.image_jpeg(source, None, 100)
    assert size == (50, 100)
    upright = Image.open(io.BytesIO(jpeg))
    assert upright.getpixel((25, 10))[0] > 200  # the red half on top
    assert upright.getpixel((25, 90))[2] > 200


def test_image_capture_refuses_formats_pillow_cannot_read(monkeypatch):
    data = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
    row = _image_row(data, "logo.svg")

    def download(key, path, limit):
        Path(path).write_bytes(data)
        return len(data), row["source_sha256"]

    monkeypatch.setattr(capture.blobstore, "download_file", download)
    with pytest.raises(capture.CaptureUnavailable) as err:
        capture._image_capture(row, 1, None, 200)
    assert err.value.code == "unsupported_format"
