from __future__ import annotations

import base64

import pytest
from PIL import Image

from pipeline.config import cfg
from pipeline.ingest import worker
from pipeline.retrieval import models


@pytest.mark.asyncio
async def test_caption_figures_filters_noise_and_ranks_by_page_area(
    monkeypatch, tmp_path
):
    images = tmp_path / "images"
    images.mkdir()
    for name, size in (
        ("tiny.bmp", (100, 100)),
        ("decoration.bmp", (400, 300)),
        ("medium.bmp", (500, 400)),
        ("large.bmp", (800, 600)),
    ):
        Image.new("RGB", size, "white").save(images / name)

    items = [
        {"type": "image", "img_path": "images/tiny.bmp", "bbox": [0, 0, 500, 500]},
        {
            "type": "image",
            "img_path": "images/decoration.bmp",
            "bbox": [0, 0, 100, 100],
        },
        {
            "type": "image",
            "img_path": "images/medium.bmp",
            "bbox": [100, 100, 500, 500],
        },
        {
            "type": "image",
            "img_path": "images/large.bmp",
            "bbox": [50, 50, 950, 850],
        },
    ]
    calls: list[int] = []

    async def caption(data_url: str, _context: str) -> str:
        calls.append(len(base64.b64decode(data_url.split(",", 1)[1])))
        return "Useful figure"

    monkeypatch.setattr(cfg, "caption_max_per_file", 1)
    monkeypatch.setattr(models, "caption_image", caption)

    await worker._caption_figures(items, tmp_path, "notes.pdf")

    assert len(calls) == 1
    assert items[3]["description"] == "Useful figure"
    assert all("description" not in item for item in items[:3])
