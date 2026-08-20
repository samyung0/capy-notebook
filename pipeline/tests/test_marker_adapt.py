"""Offline tests for Marker → content_list and the scan-vs-figure probe."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MODAL_DIR = REPO_ROOT / "modal"
if str(MODAL_DIR) not in sys.path:
    sys.path.insert(0, str(MODAL_DIR))

from marker_adapt import (
    drop_scan_rasters,
    from_marker,
    html_to_text,
    merge_ocr_lines,
    ocr_line_bbox,
)
from scan_pages import _object_bounds, job_needs_rapidocr, page_needs_ocr


def _page(
    *children: dict, page: int = 0, width: float = 612, height: float = 792
) -> dict:
    return {
        "id": f"/page/{page}/Page/0",
        "block_type": "Page",
        "bbox": [0, 0, width, height],
        "children": list(children),
    }


def test_from_marker_keeps_heading_depth_and_scales_bbox():
    rendered = {
        "block_type": "Document",
        "children": [
            _page(
                {
                    "id": "/page/0/SectionHeader/1",
                    "block_type": "SectionHeader",
                    "html": "<h1>Metabolic Pathways</h1>",
                    "bbox": [50, 40, 300, 80],
                    "heading_level": 1,
                    "children": None,
                },
                {
                    "id": "/page/0/Text/2",
                    "block_type": "Text",
                    "html": "<p>Glycolysis Step 1</p>",
                    "bbox": [50, 100, 400, 140],
                    "children": None,
                },
                {
                    "id": "/page/0/Equation/3",
                    "block_type": "Equation",
                    "html": "<math>\\Delta G</math>",
                    "bbox": [50, 160, 120, 200],
                    "children": None,
                },
            )
        ],
    }

    items = from_marker(rendered)

    assert [i["type"] for i in items] == ["text", "text", "equation"]
    assert items[0]["text"] == "Metabolic Pathways"
    assert items[0]["text_level"] == 1
    assert items[1]["text"] == "Glycolysis Step 1"
    assert items[2]["text"] == "\\Delta G"
    # 50/612 * 1000 ≈ 81.7, origin stays top-left (y=40 stays near the top)
    assert items[0]["bbox"][0] == pytest.approx(81.7, abs=0.5)
    assert items[0]["bbox"][1] == pytest.approx(50.51, abs=0.5)
    assert all(0 <= v <= 1000 for item in items for v in item["bbox"])


def test_from_marker_drops_running_headers_and_names_figure_crops():
    rendered = {
        "children": [
            _page(
                {
                    "id": "/page/0/PageHeader/1",
                    "block_type": "PageHeader",
                    "html": "<p>31st Conference on NIPS</p>",
                    "bbox": [10, 10, 400, 30],
                    "children": None,
                },
                {
                    "id": "/page/0/Figure/2",
                    "block_type": "Figure",
                    "html": "",
                    "bbox": [100, 200, 400, 500],
                    "children": [
                        {
                            "id": "/page/0/Caption/3",
                            "block_type": "Caption",
                            "html": "<p>Figure 1. The transformer.</p>",
                            "bbox": [100, 510, 400, 540],
                            "children": None,
                        }
                    ],
                },
            )
        ]
    }

    items = from_marker(rendered)

    assert [i["type"] for i in items] == ["image"]
    assert items[0]["img_path"] == "images/page_0_Figure_2.jpg"
    assert items[0]["image_caption"] == ["Figure 1. The transformer."]


def test_html_to_text_strips_tags_without_eating_words():
    assert html_to_text("<p>It Ain't Always Glucose!</p>") == "It Ain't Always Glucose!"


@pytest.mark.parametrize(
    ("chars", "coverage", "want", "reason"),
    [
        # Paper with a figure: lots of text, even a big image, is not a scan.
        (2400, 0.45, False, "text_layer"),
        (2400, 0.92, False, "text_layer"),
        # Newspaper scan: almost no text, page is the image.
        (0, 0.95, True, "scan"),
        (120, 0.80, True, "scan"),
        # Lecture slide: thin text, figures that do not cover the page.
        (146, 0.30, True, "thin_text"),
        (363, 0.10, True, "thin_text"),
        # Medium text, modest image: digital page, leave it.
        (500, 0.25, False, "enough_text"),
    ],
)
def test_scan_probe_separates_figures_from_scans(chars, coverage, want, reason):
    needs, got = page_needs_ocr(chars, coverage)
    assert needs is want
    assert got == reason


def test_txt_parse_skips_the_ocr_lane_even_on_scans():
    from scan_pages import PageProbe

    scans = [PageProbe(0, 0, 0.95, True, "scan")]
    assert job_needs_rapidocr(scans, "ocr") is True
    assert job_needs_rapidocr(scans, "txt") is False
    assert (
        job_needs_rapidocr([PageProbe(0, 2400, 0.1, False, "text_layer")], "ocr")
        is False
    )


def test_drop_scan_rasters_keeps_small_figures_on_ocr_pages():
    items = [
        {
            "type": "image",
            "page_idx": 0,
            "bbox": [10, 10, 990, 990],
            "img_path": "images/scan.jpg",
        },
        {
            "type": "image",
            "page_idx": 0,
            "bbox": [100, 200, 400, 500],
            "img_path": "images/chart.jpg",
        },
        {"type": "text", "page_idx": 0, "text": "hello", "bbox": [10, 10, 20, 20]},
    ]

    kept = drop_scan_rasters(items, {0})

    assert [i.get("img_path") for i in kept if i["type"] == "image"] == [
        "images/chart.jpg"
    ]


def test_merge_ocr_lines_skips_text_marker_already_has():
    items = [{"type": "text", "page_idx": 0, "text": "Glycolysis Step 1", "bbox": None}]
    ocr = {
        0: [
            {"text": "Glycolysis Step 1", "bbox": [10, 10, 20, 20]},
            {"text": "It Ain't Always Glucose!", "bbox": [10, 40, 80, 50]},
        ]
    }

    merged = merge_ocr_lines(items, ocr)

    texts = [i["text"] for i in merged if i["type"] == "text"]
    assert texts == ["Glycolysis Step 1", "It Ain't Always Glucose!"]


def test_object_bounds_uses_get_bounds_instead_of_crashing():
    class _Obj:
        def get_bounds(self):
            return (0.0, 10.0, 100.0, 200.0)

    assert _object_bounds(_Obj()) == (0.0, 10.0, 100.0, 200.0)


def test_ocr_line_bbox_scales_polygon_onto_the_page():
    box = ocr_line_bbox([[10, 20], [110, 20], [110, 40], [10, 40]], 200, 400)
    assert box is not None
    assert box[0] == pytest.approx(50.0)
    assert box[1] == pytest.approx(50.0)
    assert box[2] == pytest.approx(550.0)
    assert box[3] == pytest.approx(100.0)


def test_ocr_line_bbox_accepts_numpy_shaped_polygons():
    """RapidOCR boxes are ndarrays; treating them as opaque dropped every bbox."""

    class _Array:
        def tolist(self):
            return [[10, 20], [110, 20], [110, 40], [10, 40]]

    box = ocr_line_bbox(_Array(), 200, 400)
    assert box == ocr_line_bbox([[10, 20], [110, 20], [110, 40], [10, 40]], 200, 400)
