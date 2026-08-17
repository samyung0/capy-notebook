"""Offline unit tests for figure selection and captioning (no network).

Selection is where the judgement is. Every rejection here is permanent — a
figure that is filtered out is never described, so it is unreachable by search
for the life of the document — which makes the false-negative cases (a line
diagram, a duplicated figure, a one-off logo) more interesting than the obvious
rejections. The captioning half is tested for the two properties the rest of the
pipeline depends on: captions land on the ``content_list`` before chunking, and
a second ingest of the same source reuses them so ``content_hash`` is stable.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from PIL import Image, ImageDraw

from pipeline.parse import figures

_SOURCE_BLOB = "sources/lecture.pdf"
_SOURCE_ETAG = "etag-1"


_SOURCE_SHA = "ab" * 32


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


def test_a_line_diagram_survives_the_flatness_filters(tmp_path: Path):
    """The naive "mostly one colour means logo" rule would drop this, and it is
    the single most valuable image on a lecture slide."""
    _write(tmp_path / "images" / "fig.png", _diagram())
    content_list = [_image_block("images/fig.png", 0)]

    selected = figures.select_figures(content_list, tmp_path)

    assert [f.path.name for f in selected] == ["fig.png"]


@pytest.mark.parametrize(
    ("name", "image"),
    [
        ("tiny", _diagram((80, 60))),
        ("sliver", _diagram((900, 60))),
        ("solid", _solid()),
        ("blank", Image.new("RGB", (600, 400), "white")),
    ],
)
def test_page_furniture_and_undersized_crops_are_rejected(
    tmp_path: Path, name: str, image: Image.Image
):
    _write(tmp_path / "images" / f"{name}.png", image)
    content_list = [_image_block(f"images/{name}.png", 0)]

    assert figures.select_figures(content_list, tmp_path) == []


def test_a_figure_the_parser_already_described_is_not_recaptioned(tmp_path: Path):
    _write(tmp_path / "images" / "fig.png", _diagram())
    content_list = [
        _image_block("images/fig.png", 0, description="MinerU already said this")
    ]

    assert figures.select_figures(content_list, tmp_path) == []


def test_a_thumbnail_sized_bbox_is_rejected_even_when_the_crop_is_large(
    tmp_path: Path,
):
    """A high-DPI scan renders a 1cm icon as a perfectly large PNG. The bbox is
    what says how much of the page it actually occupies."""
    _write(tmp_path / "images" / "fig.png", _diagram())
    content_list = [_image_block("images/fig.png", 0, bbox=[10, 10, 60, 60])]

    assert figures.select_figures(content_list, tmp_path) == []


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


def test_an_image_recurring_across_pages_is_dropped_as_page_furniture(tmp_path: Path):
    """A crest in the corner of every slide. Distinct bytes per page (different
    JPEG noise, a shifted crop), so only the perceptual hash catches it."""
    content_list = []
    for page in range(8):
        crest = _diagram()
        crest.putpixel((page, page), (200, 30, 30))  # defeats the digest
        _write(tmp_path / "images" / f"crest{page}.png", crest)
        content_list.append(_image_block(f"images/crest{page}.png", page))

    assert figures.select_figures(content_list, tmp_path) == []


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

    async def _caption(_data_url: str, prompt: str) -> str:
        calls.append(prompt)
        return f"description {len(calls)}"

    monkeypatch.setattr(figures.models, "caption_image", _caption)
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
        "applied": 1,
        "key": _caption_key(),
    }
    assert second[0]["description"] == first[0]["description"]


async def test_a_bumped_caption_version_invalidates_the_cache(
    tmp_path: Path, captioning, monkeypatch
):
    _write(tmp_path / "images" / "a.png", _diagram(seed=1))
    await _caption_all(tmp_path, [_image_block("images/a.png", 0)])

    monkeypatch.setattr(figures.cfg, "caption_version", "v2")
    await _caption_all(tmp_path, [_image_block("images/a.png", 0)])

    assert len(captioning["calls"]) == 2
    assert set(captioning["store"]) == {
        _caption_key().replace("v2", "v1"),
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


async def test_nothing_to_caption_makes_no_calls(tmp_path: Path, captioning):
    _write(tmp_path / "images" / "logo.png", _solid((200, 200)))
    content_list = [_image_block("images/logo.png", 0), _text_block("Hello", 0)]

    stats = await _caption_all(tmp_path, content_list)

    assert stats["selected"] == 0
    assert captioning["calls"] == []
    assert "description" not in content_list[0]


async def test_the_caption_cache_follows_the_source_blob_not_the_parse_route(
    tmp_path: Path, captioning
):
    """Re-parsing the same bytes on a different MinerU route must not recaption."""
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
