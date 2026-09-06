"""Offline unit tests for figure selection and captioning (no network).

Selection is intentionally permissive because every rejection is permanent.
Tests cover the 130×130 floor, exact deduplication, and decorative decisions
made by the model and retained in the caption cache.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from PIL import Image, ImageDraw

from pipeline.parse import caption_cache, figures
from pipeline.prompts import captioning as caption_prompts
from pipeline.registry import ModelConfig
from pipeline.retrieval import models

_SOURCE_BLOB = "sources/lecture.pdf"
_SOURCE_ETAG = "etag-1"


_SOURCE_SHA = "ab" * 32


@pytest.mark.asyncio
async def test_caption_call_forces_zai_low_reasoning(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, Any] = {}
    settled: dict[str, Any] = {}
    # Same shape as the seeded vision-only row: no thinking levels at all. The
    # context measurement must not resolve the request's thinking against it.
    spec = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM-5.3-Flash",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        slots=("captioning",),
        context_window_tokens=128_000,
    )

    @asynccontextmanager
    async def tracked_call(**kwargs):
        seen["opened_thinking"] = kwargs.get("thinking")
        seen["context"] = kwargs.get("context")
        yield "call-1"

    async def complete(_spec, _messages, **kwargs):
        seen.update(kwargs)
        return object()

    async def settle(**kwargs):
        settled.update(kwargs)

    monkeypatch.setattr(models.registry, "captioning_spec", lambda: spec)
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
    assert seen["context"] is not None
    assert settled["thinking"] == "low"


@pytest.mark.asyncio
async def test_caption_settlement_failure_never_starts_another_provider_call(
    monkeypatch: pytest.MonkeyPatch,
):
    calls = 0
    spec = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM-5.3-Flash",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        slots=("captioning",),
        thinking_levels=("low",),
        default_thinking="low",
    )

    @asynccontextmanager
    async def tracked_call(**_kwargs):
        yield "call-1"

    async def complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return object()

    async def settle(**_kwargs):
        raise models.accounting.SettlementError("receipt rejected")

    monkeypatch.setattr(models.registry, "captioning_spec", lambda: spec)
    monkeypatch.setattr(models, "measure_request_context", lambda *_a, **_k: None)
    monkeypatch.setattr(models, "_tracked_call", tracked_call)
    monkeypatch.setattr(models.elitellm, "complete", complete)
    monkeypatch.setattr(models.obs, "record_completion", lambda *_a, **_k: None)
    monkeypatch.setattr(models.accounting, "settle", settle)

    with pytest.raises(models.accounting.SettlementError, match="receipt rejected"):
        await models.caption_image("data:image/png;base64,eA==", "caption")

    assert calls == 1


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
    assert selected[0].items[0]["chart_caption"] == ["Figure 4: glucose uptake"]


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

    assert [f.items[0]["page_idx"] for f in selected] == [4, 3]


@pytest.fixture
def captioning(monkeypatch):
    calls: list[str] = []
    cached: dict[str, tuple[str, str, int]] = {}
    locks: dict[str, asyncio.Lock] = {}

    @asynccontextmanager
    async def lock(_file, _asset, digest):
        async with locks.setdefault(digest, asyncio.Lock()):
            yield

    async def lookup(_file, _asset, digest, _published, **_kwargs):
        return cached.get(digest)

    async def persist(_file, _asset, digest, path, raw, _published, **_kwargs):
        cached[digest] = (json.loads(raw)["text"], path, len(raw))

    async def caption(_data_url, prompt, **_kwargs):
        calls.append(prompt)
        return f"description {len(calls)}"

    monkeypatch.setattr(caption_cache, "_lock", lock)
    monkeypatch.setattr(caption_cache, "lookup", lookup)
    monkeypatch.setattr(caption_cache, "_persist", persist)
    monkeypatch.setattr(caption_cache.models, "caption_image", caption)
    return {"calls": calls, "cached": cached}


async def _caption_all(tmp_path, content_list, source_sha256=_SOURCE_SHA):
    return await figures.caption_figures(
        content_list=content_list,
        raw_dir=tmp_path,
        file_name="private-lecture.pdf",
        source_sha256=source_sha256,
        file_id="f_1",
    )


async def test_captions_reuse_image_bytes_across_source_changes_without_prose(
    tmp_path, captioning
):
    _write(tmp_path / "images/a.png", _diagram(seed=1))
    first = [
        _text_block("Private lecture about the Krebs cycle", 2, level=1),
        _image_block("images/a.png", 2),
    ]
    await _caption_all(tmp_path, first)
    second = [_image_block("images/a.png", 8)]
    stats = await _caption_all(tmp_path, second, source_sha256="cd" * 32)
    assert second[0]["description"] == first[1]["description"]
    assert stats["cached"] == 1 and stats["captioned"] == 0
    assert captioning["calls"] == [caption_prompts.IMAGE_PROMPT]
    assert "Private lecture" not in captioning["calls"][0]
    assert "Page:" not in captioning["calls"][0]


async def test_concurrent_same_scope_figures_share_one_caption(tmp_path, captioning):
    _write(tmp_path / "images/a.png", _diagram(seed=1))
    first, second = [_image_block("images/a.png", 0)], [_image_block("images/a.png", 1)]
    results = await asyncio.gather(
        _caption_all(tmp_path, first), _caption_all(tmp_path, second)
    )
    assert len(captioning["calls"]) == 1
    assert {r["cached"] for r in results} == {0, 1}
    assert first[0]["description"] == second[0]["description"]


async def test_cache_failure_keeps_captioned_content(tmp_path, captioning, monkeypatch):
    async def fail(*_args, **_kwargs):
        raise OSError("cache unavailable")

    monkeypatch.setattr(caption_cache, "lookup", fail)
    monkeypatch.setattr(caption_cache, "_persist", fail)
    _write(tmp_path / "images/a.png", _diagram(seed=1))
    content = [_image_block("images/a.png", 0)]
    result = await _caption_all(tmp_path, content)
    assert result["captioned"] == result["applied"] == 1
    assert content[0]["description"] == "description 1"


async def test_caption_failure_cancels_other_inflight_figures(tmp_path, monkeypatch):
    _write(tmp_path / "images/a.png", _diagram(seed=1))
    _write(tmp_path / "images/b.png", _diagram(seed=2))
    started, finished = asyncio.Event(), asyncio.Event()
    count = 0

    async def caption(**_kwargs):
        nonlocal count
        count += 1
        if count == 1:
            await started.wait()
            raise RuntimeError("caption failed")
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            finished.set()

    monkeypatch.setattr(caption_cache, "caption", caption)
    with pytest.raises(RuntimeError, match="caption failed"):
        await _caption_all(
            tmp_path, [_image_block("images/a.png", 0), _image_block("images/b.png", 1)]
        )
    assert finished.is_set()
