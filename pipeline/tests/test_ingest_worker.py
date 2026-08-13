"""Offline unit tests for the ingest worker's parse routing (no network).

Figure selection and captioning live in ``parse/figures.py`` and are tested
there. What is left here is the branching the worker owns: which parse route a
job's ``parseMode`` maps to, whether captioning runs at all, and — the ordering
the whole feature rests on — that captions are on the blocks before chunking, so
they reach embedding, summarization and concept extraction rather than arriving
after the passage they belong to has already been built.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from pipeline.ingest import worker
from pipeline.parse import modal_parser


@pytest.fixture
def parse_stub(monkeypatch):
    """Stand in for Modal and for the captioner; record how both were called."""
    state: dict[str, Any] = {
        "descriptor": None,
        "captioned": 0,
        "chunked": None,
    }
    content_list = [
        {"type": "text", "text": "Photosynthesis", "page_idx": 0, "text_level": 1},
        {"type": "image", "img_path": "images/fig.png", "page_idx": 0},
    ]

    def _parse(descriptor, _name, raw_dir: Path):
        state["descriptor"] = descriptor
        raw_dir.mkdir(parents=True, exist_ok=True)
        return content_list, "parsed/f_1/x.zip", "fp-1"

    async def _caption(*, content_list, raw_dir, file_name, blob_path, source_etag):
        state["captioned"] += 1
        content_list[1]["description"] = "A labelled chloroplast."
        return {
            "selected": 1,
            "cached": 0,
            "captioned": 1,
            "applied": 1,
            "key": "captions/k.json",
        }

    def _chunk(items):
        state["chunked"] = [dict(item) for item in items]
        return ["chunk"]

    monkeypatch.setattr(
        worker.blobstore, "object_info", lambda _p: {"etag": "e", "size": 9}
    )
    monkeypatch.setattr(worker.modal_parser, "parse_to_bundle", _parse)
    monkeypatch.setattr(worker.figures, "caption_figures", _caption)
    monkeypatch.setattr(worker, "chunk_content_list", _chunk)
    monkeypatch.setattr(worker, "_record_parse_artifact", lambda *a, **k: None)
    monkeypatch.setattr(worker, "_record_caption_blob", lambda *a, **k: None)
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)
    return state


async def _run(parse_mode: str, *, caption_images: bool = False):
    return await worker._chunks_for(
        payload={"blobPath": "sources/blob_1.pdf"},
        name="lecture.pdf",
        kind="pdf",
        parse_mode=parse_mode,
        caption_images=caption_images,
        ws="ws_1",
        file_id="f_1",
    )


@pytest.mark.parametrize(
    ("parse_mode", "route"),
    [
        ("fast", modal_parser.ROUTE_FAST),
        ("accurate", modal_parser.ROUTE_ACCURATE),
        # A job enqueued before the modes were renamed, or by a gateway running
        # older code: parse it rather than fail it.
        ("advanced", modal_parser.ROUTE_ACCURATE),
    ],
)
async def test_the_parse_mode_selects_the_route(parse_stub, parse_mode, route):
    _, _, _, version = await _run(parse_mode)

    assert parse_stub["descriptor"]["route"] == route
    assert version == modal_parser.PARSER_VERSIONS[route]


async def test_text_sources_never_reach_the_parse_service(parse_stub, monkeypatch):
    monkeypatch.setattr(
        worker.blobstore, "fetch_local", lambda _p: ("/tmp/notes.md", lambda: None)
    )
    monkeypatch.setattr(worker, "_read_text", lambda _p: "# Notes")
    monkeypatch.setattr(worker, "chunk_markdown", lambda text: [text])

    chunks, artifact_key, fingerprint, version = await worker._chunks_for(
        payload={"blobPath": "sources/notes.md"},
        name="notes.md",
        kind="md",
        parse_mode="fast",
        caption_images=True,
        ws="ws_1",
        file_id="f_1",
    )

    assert chunks == ["# Notes"]
    assert (artifact_key, fingerprint, version) == (None, None, None)
    assert parse_stub["descriptor"] is None
    assert parse_stub["captioned"] == 0


async def test_json_sources_are_ingested_as_text(parse_stub, monkeypatch):
    monkeypatch.setattr(
        worker.blobstore, "fetch_local", lambda _p: ("/tmp/data.json", lambda: None)
    )
    monkeypatch.setattr(worker, "_read_text", lambda _p: '{"topic": "osmosis"}')
    monkeypatch.setattr(worker, "chunk_markdown", lambda text: [text])

    chunks, artifact_key, fingerprint, version = await worker._chunks_for(
        payload={"blobPath": "sources/data.json"},
        name="data.json",
        kind="json",
        parse_mode="none",
        caption_images=True,
        ws="ws_1",
        file_id="f_1",
    )

    assert chunks == ['{"topic": "osmosis"}']
    assert (artifact_key, fingerprint, version) == (None, None, None)
    assert parse_stub["descriptor"] is None
    assert parse_stub["captioned"] == 0


async def test_captioning_is_off_unless_the_upload_asked_for_it(parse_stub):
    await _run("fast")

    assert parse_stub["captioned"] == 0
    assert "description" not in parse_stub["chunked"][1]


async def test_captions_reach_the_chunker(parse_stub):
    """The ordering the feature depends on: chunking must see the description,
    otherwise the figure is embedded as an empty block and stays unsearchable."""
    await _run("fast", caption_images=True)

    assert parse_stub["captioned"] == 1
    assert parse_stub["chunked"][1]["description"] == "A labelled chloroplast."


async def test_a_successful_parse_is_recorded_before_captioning(
    parse_stub, monkeypatch
):
    """A later vision failure must not leave the zip untracked for the reaper."""
    order: list[str] = []

    def _record(*_a, **_k):
        order.append("parse")

    async def _caption(**_k):
        order.append("caption")
        return {"selected": 0, "cached": 0, "captioned": 0, "applied": 0, "key": ""}

    monkeypatch.setattr(worker, "_record_parse_artifact", _record)
    monkeypatch.setattr(worker.figures, "caption_figures", _caption)

    await _run("fast", caption_images=True)

    assert order == ["parse", "caption"]


async def test_a_missing_source_blob_fails_before_paying_for_a_parse(
    parse_stub, monkeypatch
):
    monkeypatch.setattr(worker.blobstore, "object_info", lambda _p: None)

    with pytest.raises(RuntimeError, match="source blob is missing"):
        await _run("accurate")

    assert parse_stub["descriptor"] is None
