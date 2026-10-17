"""Dense vector figures become one picture each before Java (parser/odl/
flatten.py), and their labels join the figure (pictures.flattened_figures)."""

from __future__ import annotations

import math
import sys
from pathlib import Path

import pymupdf

PARSER_DIR = Path(__file__).resolve().parents[2] / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))

from odl import flatten, pictures


def _scatter(page: pymupdf.Page, box: pymupdf.Rect, points: int = 900) -> None:
    """Plus markers, each a horizontal and a vertical stroke (empty boxes to
    pymupdf), as plotting tools draw them."""
    shape = page.new_shape()
    columns = 30
    for i in range(points):
        x = box.x0 + 3 + (i % columns) * (box.width - 6) / columns
        y = box.y0 + 3 + (i // columns) * (box.height - 6) / (points // columns)
        shape.draw_line((x - 1.5, y), (x + 1.5, y))
        shape.draw_line((x, y - 1.5), (x, y + 1.5))
    shape.finish(color=(0, 0.6, 0.6), width=0.4)
    shape.commit()


def _pdf(build) -> bytes:
    doc = pymupdf.open()
    build(doc.new_page())
    return doc.tobytes()


def test_a_scatter_plot_becomes_one_picture_and_its_text_stays() -> None:
    plot = pymupdf.Rect(300, 400, 560, 640)

    def build(page):
        page.insert_text((72, 100), "Body text above the figure.")
        _scatter(page, plot)
        page.insert_text((400, 660), "Age (days)", fontsize=8)
        page.draw_rect(pymupdf.Rect(36, 36, 576, 756), color=(0, 0, 0))  # page frame

    out, regions = flatten.flatten(_pdf(build))
    (box,) = regions[0]
    # The markers' extent, not the page frame's.
    assert (plot + (-2, -2, 2, 2)).contains(box) and box.width > 200
    page = pymupdf.open(stream=out, filetype="pdf")[0]
    assert len(page.get_images()) == 1
    assert len(page.get_cdrawings()) < 5  # markers gone, the frame kept
    assert "Body text above" in page.get_text() and "Age (days)" in page.get_text()


def test_two_plots_on_a_page_become_two_pictures() -> None:
    left, right = pymupdf.Rect(40, 400, 280, 640), pymupdf.Rect(330, 400, 570, 640)

    def build(page):
        _scatter(page, left)
        _scatter(page, right)

    out, regions = flatten.flatten(_pdf(build))
    assert len(regions[0]) == 2
    page = pymupdf.open(stream=out, filetype="pdf")[0]
    assert len(page.get_images()) == 2
    # Both plots' markers gone but the top row's strokes, which reach past
    # the path box pymupdf reports (it leaves out every moveto but the first).
    assert sum(len(d["items"]) for d in page.get_cdrawings()) < 100


def test_a_path_without_a_finite_box_is_left_out() -> None:
    doc = pymupdf.open()
    page = doc.new_page()
    _scatter(page, pymupdf.Rect(300, 400, 560, 640))
    # A skewed huge matrix: the stroke's box is NaN and minus infinity.
    huge = b"1000000000 0 -1000000000 1000000000 0 0 cm "
    huge += b"1000000000 0 0 1000000000 0 0 cm " * 3
    xref = doc.get_new_xref()
    doc.update_object(xref, "<<>>")
    doc.update_stream(xref, b"q " + huge + b"10000 10000 m 20000 20000 l S Q")
    refs = " ".join(f"{x} 0 R" for x in page.get_contents())
    doc.xref_set_key(page.xref, "Contents", f"[{refs} {xref} 0 R]")
    data = doc.tobytes()
    assert any(
        not all(map(math.isfinite, d["rect"]))
        for d in pymupdf.open(stream=data, filetype="pdf")[0].get_cdrawings()
    )
    _, regions = flatten.flatten(data)
    (box,) = regions[0]
    assert pymupdf.Rect(298, 398, 562, 642).contains(box)


def test_a_book_without_dense_figures_is_returned_byte_for_byte() -> None:
    def build(page):
        page.insert_text((72, 100), "Only text and a rule.")
        page.draw_line((72, 110), (500, 110))

    data = _pdf(build)
    assert flatten.flatten(data) == (data, {})


def test_a_ruled_table_full_of_text_is_kept() -> None:
    def build(page):
        shape = page.new_shape()
        for row in range(40):
            y = 100 + row * 15
            for col in range(8):
                x = 60 + col * 60
                # Each cell's border as separate short strokes.
                for dx in range(0, 60, 6):
                    shape.draw_line((x + dx, y), (x + dx + 6, y))
                page.insert_text((x + 3, y + 11), f"{row * 8 + col:05d}", fontsize=10)
        shape.finish(width=0.3)
        shape.commit()

    data = _pdf(build)
    assert flatten.flatten(data) == (data, {})


def test_flattened_figures_fold_labels_and_keep_sentences() -> None:
    doc = pymupdf.open()
    doc.new_page(width=1000, height=1000)  # page points equal the 0..1000 grid
    region = pymupdf.Rect(500, 400, 900, 800)
    blocks = [
        {
            "type": "text",
            "text": "Intro paragraph.",
            "bbox": [50, 50, 450, 90],
            "page_idx": 0,
        },
        {
            "type": "equation",
            "text": "",
            "_picture": "inline",
            "bbox": [520, 420, 540, 440],
            "page_idx": 0,
        },
        {"type": "image", "_native_id": 7, "bbox": [500, 400, 900, 800], "page_idx": 0},
        {
            "type": "text",
            "text": "Pregnancy Length",
            "bbox": [600, 760, 760, 790],
            "page_idx": 0,
        },
        {
            "type": "title",
            "text": "Legend",
            "text_level": 3,
            "bbox": [800, 420, 880, 440],
            "page_idx": 0,
        },
        {
            "type": "text",
            "text": "Source: national survey",
            "bbox": [520, 770, 700, 795],
            "page_idx": 0,
        },
        {
            "type": "text",
            "text": "This sentence inside the figure is long enough to stay.",
            "bbox": [520, 600, 890, 630],
            "page_idx": 0,
        },
        {
            "type": "text",
            "text": "Pregnancy Length (days)",
            "bbox": [600, 375, 800, 395],
            "page_idx": 0,
        },
        {
            "type": "text",
            "text": "After the figure.",
            "bbox": [50, 850, 450, 890],
            "page_idx": 0,
        },
    ]
    out = pictures.flattened_figures(blocks, doc, {0: [region]})
    assert [b["type"] for b in out] == ["text", "image", "text", "text"]
    figure = out[1]
    assert figure["_source_role"] == "flattened-figure" and figure["_native_id"] == 7
    assert figure["bbox"] == [500, 400, 900, 800]
    # The title just above the region is a label too.
    assert figure["figure_labels"] == [
        "Pregnancy Length",
        "Legend",
        "Pregnancy Length (days)",
    ]
    assert figure["image_footnote"] == ["Source: national survey"]
    assert out[2]["text"].startswith("This sentence")


def test_a_region_without_a_picture_gets_a_figure_at_its_page_end() -> None:
    doc = pymupdf.open()
    doc.new_page(width=1000, height=1000)
    blocks = [
        {"type": "text", "text": "Only text.", "bbox": [50, 50, 450, 90], "page_idx": 0}
    ]
    out = pictures.flattened_figures(
        blocks, doc, {0: [pymupdf.Rect(500, 400, 900, 800)]}
    )
    assert [b["type"] for b in out] == ["text", "image"]
    assert out[1]["figure_labels"] == []
