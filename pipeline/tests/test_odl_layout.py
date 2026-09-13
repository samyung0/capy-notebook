"""Ordering must preserve OCR evidence and abstain on partially mapped pages."""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parser"))
from odl import layout, ocr


def test_frozen_source_geometry_preserves_strict_order_and_negative_controls() -> None:
    with gzip.open(
        Path(__file__).parent / "fixtures/odl-layout-order.json.gz", "rt"
    ) as file:
        cases = json.load(file)["cases"]
    assert len(cases) == 17
    for case in cases:
        ordered, _ = layout.order_blocks(case["blocks"], case["regions"])
        assert [int(b["text"]) for b in ordered] == case["expected_order"], case["id"]
        assert sorted(map(id, ordered)) == sorted(map(id, case["blocks"])), case["id"]


def test_competing_regions_abstain_without_an_arbitrary_nested_region_winner() -> None:
    blocks = [
        {"text": "first in source", "bbox": [10, 10, 20, 20]},
        {"text": "second in source", "bbox": [40, 10, 50, 20]},
    ]
    regions = [[0, 0, 100, 100], [5, 5, 25, 25]]
    assert layout.order_blocks(blocks, regions) == (blocks, "ambiguous-regions")
    assert layout.order_blocks(blocks, regions[::-1]) == (blocks, "ambiguous-regions")


def test_layout_orders_columns_without_reordering_table_cells_or_losing_lines() -> None:
    blocks = [
        {"text": text, "bbox": box, "page_idx": 3, "_ocr_score": 0.8}
        for text, box in (
            ("Left first", [10, 10, 40, 20]),
            ("Right first", [60, 10, 90, 20]),
            ("Left second", [10, 30, 40, 40]),
            ("Right second", [60, 30, 90, 40]),
            ("Dose (mg)", [10, 70, 40, 80]),
            ("Response (%)", [60, 70, 90, 80]),
            ("10", [10, 90, 40, 100]),
            ("42", [60, 90, 90, 100]),
        )
    ]
    regions = [[0, 0, 50, 50], [50, 0, 100, 50], [0, 60, 100, 110]]
    ordered, reason = layout.order_blocks(blocks, regions)
    assert reason == "layout"
    assert ordered == [blocks[i] for i in [0, 2, 1, 3, 4, 5, 6, 7]]
    assert sorted(map(id, ordered)) == sorted(map(id, blocks))
    for bad_regions, reason in (
        (regions[:-1], "unmapped-line"),
        ([], "no-regions"),
        ([[0, 0, float("nan"), 10]], "invalid-geometry"),
        ([[0, 0, 0, 0]], "invalid-geometry"),
    ):
        assert layout.order_blocks(blocks, bad_regions) == (blocks, reason)


def test_fresh_ocr_applies_layout_only_to_routed_pages(monkeypatch) -> None:
    doc = pymupdf.open()
    doc.new_page(width=100, height=100).insert_text(
        (10, 30), "Native text " * 8, fontsize=4
    )
    doc.new_page(width=100, height=100)
    lines = [
        {
            "box": [[x, y], [x + 20, y], [x + 20, y + 10], [x, y + 10]],
            "text": text,
            "score": 0.9,
        }
        for text, x, y in [("Left", 10, 10), ("Right", 60, 10), ("Continued", 10, 30)]
    ]
    from PIL import Image

    monkeypatch.setattr(ocr, "render", lambda page: Image.new("RGB", (100, 100)))
    monkeypatch.setattr(ocr, "ocr_lines", lambda image: lines)
    monkeypatch.setattr(
        layout, "regions", lambda image, path: [[0, 0, 500, 500], [500, 0, 1000, 500]]
    )
    native = {"type": "text", "page_idx": 0, "text": "Existing native text"}
    blocks, pages = ocr.add_ocr_text([native], doc)
    assert pages == [1] and blocks[0] is native
    assert [b["text"] for b in blocks[1:]] == ["Left", "Continued", "Right"]
    assert all(b["page_idx"] == 1 and b["_ocr_score"] == 0.9 for b in blocks[1:])
    doc.close()
