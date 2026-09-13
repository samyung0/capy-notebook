"""Shared parser boxes narrow only on a complete, unique native-text match."""

import pymupdf
import pytest

from pipeline.retrieval import citation_regions
from pipeline.retrieval.search import Passage


def passage(text, **kwargs):
    return Passage(
        chunk_id=text,
        file_id="f",
        file_name="source.pdf",
        chunk_idx=0,
        section_path="",
        text=text,
        **kwargs,
    )


def test_split_box_unicode_wrapping_ambiguity_and_rotation(tmp_path):
    pdf = tmp_path / "source.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page(width=400, height=600)
        page.insert_text((0, 6), "Edge")
        page.insert_text((40, 80), "First passage\nwraps here.")
        page.insert_text((40, 150), "Second passage.")
        page.insert_text((40, 200), "Repeated")
        page.insert_text((40, 250), "Repeated")
        page.insert_text((40, 300), "日本語の文章。", fontname="japan")
        rotated = doc.new_page(width=400, height=600)
        rotated.insert_text((40, 80), "Rotated passage.")
        rotated.set_rotation(90)
        doc.save(pdf)
    box = [{"page": 1, "bbox": [0, 0, 1000, 1000], "space": citation_regions.SPACE}]
    items = [
        passage(text, regions=box)
        for text in (
            "First passage wraps here.",
            "Second passage.",
            "Repeated",
            "missing text",
            "日本語の文章。",
        )
    ]
    items.append(passage("Rotated passage.", regions=[{**box[0], "page": 2}]))
    result = citation_regions.resolve(pdf, items)
    assert result[0][0]["bbox"][3] < result[1][0]["bbox"][1]
    assert result[2] == box and result[3] == box
    assert result[4][0]["bbox"][0] == pytest.approx(100)
    assert result[5][0]["bbox"][0] > 800
    # A unique occurrence elsewhere on the page cannot move an existing box.
    restricted = passage("Second passage.", regions=result[0])
    assert citation_regions.resolve(pdf, [restricted]) == [result[0]]
    edge = citation_regions.resolve(pdf, [passage("Edge", regions=box)])[0][0]["bbox"]
    assert edge[0] == 0 and edge[1] == 0


async def test_unavailable_pdf_preserves_citation(monkeypatch):
    async def unavailable(*_):
        raise citation_regions.capture.CaptureUnavailable("not a PDF")

    monkeypatch.setattr(citation_regions.capture, "pdf_path", unavailable)
    item = passage(
        "Original",
        regions=[{"page": 1, "bbox": [1, 2, 3, 4], "space": citation_regions.SPACE}],
    )
    assert await citation_regions.refine("ws", [item]) == [item.as_citation()]


def test_illustrated_page_resolves_without_extracting_images(tmp_path, monkeypatch):
    pdf = tmp_path / "illustrated.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page(width=400, height=600)
        page.insert_text((40, 80), "Illustrated passage.")
        pixmap = pymupdf.Pixmap(pymupdf.csRGB, (0, 0, 8, 8), False)
        pixmap.clear_with(200)
        page.insert_image((200, 200, 350, 350), pixmap=pixmap)
        doc.save(pdf)

    original = pymupdf.Page.get_text
    image_blocks = []

    def extract(page, *args, **kwargs):
        result = original(page, *args, **kwargs)
        image_blocks.extend(block for block in result["blocks"] if block["type"] == 1)
        return result

    monkeypatch.setattr(pymupdf.Page, "get_text", extract)
    item = passage(
        "Illustrated passage.",
        regions=[
            {"page": 1, "bbox": [0, 0, 1000, 1000], "space": citation_regions.SPACE}
        ],
    )
    region = citation_regions.resolve(pdf, [item])[0][0]
    assert region["bbox"][0] == pytest.approx(100)
    assert region["bbox"][3] < 200
    assert image_blocks == []
