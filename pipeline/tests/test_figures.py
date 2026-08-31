"""Offline unit tests for figure selection and captioning (no network).

Selection is intentionally permissive because every rejection is permanent.
Tests cover the 130×130 floor, exact deduplication, and decorative decisions
made by the model and retained in the caption cache.
"""

from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image, ImageDraw

from pipeline.parse import figures
from pipeline.registry import ModelConfig
from pipeline.retrieval import models

_SOURCE_BLOB = "sources/lecture.pdf"
_SOURCE_ETAG = "etag-1"


_SOURCE_SHA = "ab" * 32


@pytest.mark.asyncio
async def test_caption_call_forces_zai_low_reasoning(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, Any] = {}
    settled: dict[str, Any] = {}
    spec = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM-5.3-Flash",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        surfaces=("chat", "vision"),
        thinking_levels=("low", "high", "max"),
        default_thinking="max",
    )

    @asynccontextmanager
    async def tracked_call(**kwargs):
        seen["opened_thinking"] = kwargs.get("thinking")
        yield "call-1"

    async def complete(_spec, _messages, **kwargs):
        seen.update(kwargs)
        return object()

    async def settle(**kwargs):
        settled.update(kwargs)

    monkeypatch.setattr(models.registry, "vision_spec", lambda: spec)
    monkeypatch.setattr(models, "measure_request_context", lambda *_a, **_k: None)
    monkeypatch.setattr(models, "_tracked_call", tracked_call)
    monkeypatch.setattr(models.elitellm, "complete", complete)
    monkeypatch.setattr(
        models.elitellm,
        "message_from_response",
        lambda _response: SimpleNamespace(content="cell diagram"),
    )
    monkeypatch.setattr(models.obs, "record_completion", lambda *_a, **_k: None)
    monkeypatch.setattr(models.accounting, "settle", settle)

    assert await models.caption_image("data:image/png;base64,eA==", "caption") == (
        "cell diagram"
    )
    assert seen["reasoning"] is False
    assert seen["opened_thinking"] == "low"
    assert settled["thinking"] == "low"


def _caption_key() -> str:
    return figures.cache_key(_SOURCE_SHA)


def _write(path: Path, image: Image.Image) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")
    return path


def _diagram(size: tuple[int, int] = (600, 400), seed: int = 0) -> Image.Image:
    """A line drawing on white: sparse, mostly one colour, and exactly the kind
    of image the flatness heuristics must never reject.

    ``seed`` changes the composition, not just its offset — two drawings that
    differ by a few pixels *should* hash together, so nudging one would test the
    perceptual hash rather than the selection rules.
    """
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    width, height = size
    boxes = 2 + seed % 5
    for i in range(boxes):
        top = 20 + i * (height - 60) // boxes
        left = 20 + (i * (seed + 3) * 37) % max(1, width // 2)
        draw.rectangle((left, top, left + 140 + seed * 9, top + 40), outline="black")
        draw.line((left + 140, top + 20, width - 40, height - 30 * (i + 1)), width=3)
        draw.text((left + 10, top + 10), f"stage {i} of {seed}", fill="black")
    return image


def _solid(size: tuple[int, int] = (600, 400), color: str = "#2f5fa8") -> Image.Image:
    return Image.new("RGB", size, color)


def _image_block(img_path: str, page: int, **extra: Any) -> dict[str, Any]:
    block = {
        "type": "image",
        "img_path": img_path,
        "page_idx": page,
        "bbox": [100, 100, 900, 700],
    }
    block.update(extra)
    return block


def _text_block(text: str, page: int, level: int | None = None) -> dict[str, Any]:
    block: dict[str, Any] = {"type": "text", "text": text, "page_idx": page}
    if level is not None:
        block["text_level"] = level
    return block


# ---------------------------------------------------------------- selection


def test_a_line_diagram_survives_selection(tmp_path: Path):
    _write(tmp_path / "images" / "fig.png", _diagram())
    content_list = [_image_block("images/fig.png", 0)]

    selected = figures.select_figures(content_list, tmp_path)

    assert [f.path.name for f in selected] == ["fig.png"]


@pytest.mark.parametrize(
    ("name", "image"),
    [
        ("tiny", _diagram((80, 60))),
        ("sliver", _diagram((900, 60))),
    ],
)
def test_undersized_crops_are_rejected(tmp_path: Path, name: str, image: Image.Image):
    _write(tmp_path / "images" / f"{name}.png", image)
    content_list = [_image_block(f"images/{name}.png", 0)]

    assert figures.select_figures(content_list, tmp_path) == []


def test_a_figure_the_parser_already_described_is_not_recaptioned(tmp_path: Path):
    _write(tmp_path / "images" / "fig.png", _diagram())
    content_list = [
        _image_block("images/fig.png", 0, description="Parser already said this")
    ]

    assert figures.select_figures(content_list, tmp_path) == []


def test_chart_blocks_are_selected_and_use_their_own_caption_key(tmp_path: Path):
    """A recognised data graphic comes back typed ``chart``, not ``image``.

    Selecting only ``image`` skipped these, so a plot was neither captioned here
    nor indexed by the chunker — it left the corpus entirely.
    """
    _write(tmp_path / "images" / "plot.png", _diagram())
    content_list = [
        _image_block(
            "images/plot.png",
            0,
            type="chart",
            chart_caption=["Figure 4: glucose uptake"],
        )
    ]

    selected = figures.select_figures(content_list, tmp_path)

    assert [f.path.name for f in selected] == ["plot.png"]
    assert "Figure 4: glucose uptake" in selected[0].context


def test_page_bbox_does_not_reject_a_large_decodable_crop(
    tmp_path: Path,
):
    _write(tmp_path / "images" / "fig.png", _diagram())
    content_list = [_image_block("images/fig.png", 0, bbox=[10, 10, 60, 60])]

    assert len(figures.select_figures(content_list, tmp_path)) == 1


def test_the_130_pixel_floor_is_inclusive(tmp_path: Path):
    _write(tmp_path / "images" / "keep.png", _diagram((130, 130)))
    _write(tmp_path / "images" / "drop.png", _diagram((129, 130)))
    content_list = [
        _image_block("images/keep.png", 0),
        _image_block("images/drop.png", 0),
    ]

    assert [
        item.path.name for item in figures.select_figures(content_list, tmp_path)
    ] == ["keep.png"]


def test_the_same_picture_used_twice_is_captioned_once(tmp_path: Path):
    _write(tmp_path / "images" / "a.png", _diagram())
    _write(tmp_path / "images" / "b.png", _diagram())  # byte-identical
    content_list = [
        _image_block("images/a.png", 0),
        _image_block("images/b.png", 4),
    ]

    selected = figures.select_figures(content_list, tmp_path)

    assert len(selected) == 1
    assert selected[0].items == content_list


def test_near_duplicate_images_are_left_for_the_model(tmp_path: Path):
    content_list = []
    for page in range(8):
        crest = _diagram()
        crest.putpixel((page, page), (200, 30, 30))  # defeats the digest
        _write(tmp_path / "images" / f"crest{page}.png", crest)
        content_list.append(_image_block(f"images/crest{page}.png", page))

    assert len(figures.select_figures(content_list, tmp_path)) == 8


def test_distinct_figures_on_many_pages_all_survive(tmp_path: Path):
    """The counterpart to the test above: repetition must be measured on image
    content, not on "there is an image on every page", or a well illustrated
    textbook loses every figure it has."""
    content_list = []
    for page in range(8):
        _write(tmp_path / "images" / f"fig{page}.png", _diagram(seed=page + 1))
        content_list.append(_image_block(f"images/fig{page}.png", page))

    selected = figures.select_figures(content_list, tmp_path)

    assert len(selected) == 8


def test_the_safety_valve_keeps_the_largest_figures(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(figures.cfg, "caption_max_per_file", 2)
    content_list = []
    for page in range(5):
        _write(tmp_path / "images" / f"fig{page}.png", _diagram(seed=page + 1))
        content_list.append(
            _image_block(
                f"images/fig{page}.png", page, bbox=[0, 0, 100 * (page + 1), 800]
            )
        )

    selected = figures.select_figures(content_list, tmp_path)

    assert [f.page for f in selected] == [4, 3]


def test_context_carries_the_document_vocabulary(tmp_path: Path):
    _write(tmp_path / "images" / "fig.png", _diagram())
    content_list = [
        _text_block("Cellular Respiration", 0, level=1),
        _text_block("The Krebs cycle", 0, level=2),
        _text_block("Acetyl-CoA enters the cycle here.", 0),
        _image_block("images/fig.png", 0, image_caption=["Figure 3.1"]),
        _text_block("Each turn yields three NADH.", 0),
    ]

    context = figures.select_figures(content_list, tmp_path)[0].context

    assert "Cellular Respiration › The Krebs cycle" in context
    assert "Figure 3.1" in context
    assert "Acetyl-CoA enters the cycle here." in context
    assert "Each turn yields three NADH." in context


# --------------------------------------------------------------- captioning


@pytest.fixture
def captioning(monkeypatch):
    """Stub the vision model and the caption cache; record what each did."""
    calls: list[str] = []
    store: dict[str, bytes] = {}
    gate = threading.Lock()
    lock_state = {"held": False}

    class Connection:
        pass

    def try_lock(_identity: str):
        with gate:
            if lock_state["held"]:
                return None
            lock_state["held"] = True
            return Connection()

    def release_lock(_connection: Connection, _identity: str) -> None:
        with gate:
            lock_state["held"] = False

    async def _caption(_data_url: str, prompt: str) -> str:
        calls.append(prompt)
        return f"description {len(calls)}"

    monkeypatch.setattr(figures.models, "caption_image", _caption)
    monkeypatch.setattr(figures.db, "try_source_artifact_lock", try_lock)
    monkeypatch.setattr(figures.db, "release_source_artifact_lock", release_lock)
    monkeypatch.setattr(figures.blobstore, "read_bytes", lambda key: store.get(key))
    monkeypatch.setattr(
        figures.blobstore,
        "write_bytes",
        lambda key, data, _type: store.__setitem__(key, data),
    )
    return {"calls": calls, "store": store}


async def _caption_all(tmp_path: Path, content_list: list[dict[str, Any]]) -> dict:
    return await figures.caption_figures(
        content_list=content_list,
        raw_dir=tmp_path,
        file_name="lecture.pdf",
        source_sha256=_SOURCE_SHA,
    )


async def test_captions_are_written_onto_the_blocks_before_chunking(
    tmp_path: Path, captioning
):
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))
    _write(tmp_path / "images" / "b.png", _diagram(seed=2))
    content_list = [
        _image_block("images/a.png", 0),
        _image_block("images/b.png", 1),
    ]

    stats = await _caption_all(tmp_path, content_list)

    assert stats["captioned"] == 2
    # Set comparison: the calls run concurrently, so which figure gets which
    # numbered stub is not fixed.
    assert {block["description"] for block in content_list} == {
        "description 1",
        "description 2",
    }


async def test_a_reingest_replays_the_cache_so_the_content_hash_is_stable(
    tmp_path: Path, captioning
):
    """Two ingests of the same source must produce byte-identical chunk text,
    or canonical de-duplication in rag_contents silently stops working."""
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))
    first = [_image_block("images/a.png", 0)]
    second = [_image_block("images/a.png", 0)]

    await _caption_all(tmp_path, first)
    stats = await _caption_all(tmp_path, second)

    assert len(captioning["calls"]) == 1
    assert stats == {
        "selected": 1,
        "cached": 1,
        "captioned": 0,
        "decorative": 0,
        "applied": 1,
        "key": _caption_key(),
    }
    assert second[0]["description"] == first[0]["description"]


async def test_concurrent_ingests_share_one_embedded_caption_cache(
    tmp_path: Path, captioning
):
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    _write(first_dir / "images" / "a.png", _diagram(seed=1))
    _write(second_dir / "images" / "a.png", _diagram(seed=1))
    first = [_image_block("images/a.png", 0)]
    second = [_image_block("images/a.png", 0)]

    first_stats, second_stats = await asyncio.gather(
        _caption_all(first_dir, first),
        _caption_all(second_dir, second),
    )

    assert len(captioning["calls"]) == 1
    assert first[0]["description"] == second[0]["description"]
    assert {first_stats["captioned"], second_stats["captioned"]} == {0, 1}


async def test_a_bumped_caption_version_invalidates_the_cache(
    tmp_path: Path, captioning, monkeypatch
):
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))
    await _caption_all(tmp_path, [_image_block("images/a.png", 0)])

    monkeypatch.setattr(figures.cfg, "caption_version", "v3")
    await _caption_all(tmp_path, [_image_block("images/a.png", 0)])

    assert len(captioning["calls"]) == 2
    assert set(captioning["store"]) == {
        _caption_key().replace("v3", "v2"),
        _caption_key(),
    }


async def test_the_prompt_carries_the_page_but_not_the_file_name(
    tmp_path: Path, captioning
):
    """Everything in the prompt has to be inside the cache key.

    Captions are stored under ``(source_sha256, caption version)`` and reused by
    every later upload of the same bytes, so the uploader's file name must not
    reach the model: it would leak into another workspace's captions and make
    identical bytes caption differently depending on who ingested them first.
    """
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))

    await _caption_all(tmp_path, [_image_block("images/a.png", 3)])

    prompt = captioning["calls"][0]
    assert "lecture.pdf" not in prompt
    assert "Page: 4" in prompt
    assert "return exactly DECORATIVE" in prompt


async def test_the_context_preamble_is_absent_when_there_is_no_context(
    tmp_path: Path, captioning
):
    """A lone figure must not be promised context that never arrives.

    The preamble ends in a colon. Emitted with nothing after it, it reads as a
    cue that reference material follows, which is an invitation to invent some.
    """
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))

    await _caption_all(tmp_path, [_image_block("images/a.png", 0)])

    prompt = captioning["calls"][0]
    assert figures._CAPTION_CONTEXT_PREAMBLE not in prompt
    assert not prompt.rstrip().endswith(":")


async def test_the_context_preamble_appears_once_context_exists(
    tmp_path: Path, captioning
):
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))
    content_list = [
        _text_block("The Krebs cycle", 0, level=1),
        _image_block("images/a.png", 0),
    ]

    await _caption_all(tmp_path, content_list)

    prompt = captioning["calls"][0]
    assert figures._CAPTION_CONTEXT_PREAMBLE in prompt
    assert "The Krebs cycle" in prompt


async def test_an_unreadable_cache_is_not_a_failed_ingest(
    tmp_path: Path, captioning, monkeypatch
):
    """The cache is an optimization. Losing it costs money, not correctness."""
    monkeypatch.setattr(figures.blobstore, "read_bytes", lambda _k: b"{ not json")

    def _explode(*_a, **_k):
        raise RuntimeError("B2 is down")

    monkeypatch.setattr(figures.blobstore, "write_bytes", _explode)
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))
    content_list = [_image_block("images/a.png", 0)]

    stats = await _caption_all(tmp_path, content_list)

    assert stats["captioned"] == 1
    assert content_list[0]["description"] == "description 1"


async def test_a_decorative_result_is_cached_but_not_added_to_chunks(
    tmp_path: Path, captioning, monkeypatch
):
    async def _decorative(_data_url: str, prompt: str) -> str:
        captioning["calls"].append(prompt)
        return "DECORATIVE"

    monkeypatch.setattr(figures.models, "caption_image", _decorative)
    _write(tmp_path / "images" / "logo.png", _solid((200, 200)))
    content_list = [_image_block("images/logo.png", 0), _text_block("Hello", 0)]

    first = await _caption_all(tmp_path, content_list)
    second_content = [_image_block("images/logo.png", 0)]
    second = await _caption_all(tmp_path, second_content)

    assert first["decorative"] == 1
    assert first["applied"] == 0
    assert second["cached"] == 1
    assert second["decorative"] == 1
    assert len(captioning["calls"]) == 1
    assert "description" not in content_list[0]
    assert "description" not in second_content[0]


async def test_the_caption_cache_follows_the_source_blob_not_the_parse_route(
    tmp_path: Path, captioning
):
    """Re-parsing the same bytes on another route must not recaption."""
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))
    first = [_image_block("images/a.png", 0)]
    second = [_image_block("images/a.png", 0)]

    await _caption_all(tmp_path, first)
    stats = await figures.caption_figures(
        content_list=second,
        raw_dir=tmp_path,
        file_name="lecture.pdf",
        source_sha256=_SOURCE_SHA,
    )

    assert len(captioning["calls"]) == 1
    assert stats["cached"] == 1
    assert stats["key"] == _caption_key()

    third = [_image_block("images/a.png", 0)]
    await figures.caption_figures(
        content_list=third,
        raw_dir=tmp_path,
        file_name="lecture.pdf",
        source_sha256="cd" * 32,
    )
    assert len(captioning["calls"]) == 2


async def test_the_cached_payload_is_keyed_by_image_content(tmp_path: Path, captioning):
    """Keyed by the image digest rather than its path, so the same figure moving
    between pages on a re-parse still hits."""
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))
    content_list = [_image_block("images/a.png", 0)]

    await _caption_all(tmp_path, content_list)

    cached = json.loads(captioning["store"][_caption_key()])
    digest = next(iter(cached))
    assert len(digest) == 64
    assert cached[digest] == "description 1"
