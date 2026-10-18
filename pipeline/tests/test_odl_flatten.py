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

    out, regions, _ = flatten.flatten(_pdf(build))
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

    out, regions, _ = flatten.flatten(_pdf(build))
    assert len(regions[0]) == 2
    page = pymupdf.open(stream=out, filetype="pdf")[0]
    assert len(page.get_images()) == 2
    # Every marker gone, the top row's too: their strokes reach past the path
    # box pymupdf reports (it leaves out every moveto but the first).
    assert not page.get_cdrawings()


def test_a_region_grows_to_its_axes_and_sparse_points() -> None:
    def build(page):
        _scatter(page, pymupdf.Rect(300, 400, 500, 560))
        shape = page.new_shape()
        shape.draw_line((295, 395), (295, 565))  # y axis
        shape.draw_line((295, 565), (560, 565))  # x axis
        for x in range(505, 560, 6):  # sparse points trailing off the core
            shape.draw_circle((x, 480), 1.5)
        shape.finish(color=(0, 0, 0), width=0.5)
        shape.commit()

    _, regions, _ = flatten.flatten(_pdf(build))
    (box,) = regions[0]
    assert box.x0 <= 295 and box.y1 >= 565 and box.x1 >= 559


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
    _, regions, _ = flatten.flatten(data)
    (box,) = regions[0]
    assert pymupdf.Rect(298, 398, 562, 642).contains(box)


def test_a_region_does_not_grow_into_a_frame_around_text() -> None:
    def build(page):
        _scatter(page, pymupdf.Rect(300, 400, 500, 560))
        page.insert_text(
            (90, 600), "This sentence inside the frame has well over eight words."
        )
        page.draw_rect(pymupdf.Rect(80, 395, 505, 620), color=(0, 0, 0), width=0.5)

    _, regions, _ = flatten.flatten(_pdf(build))
    (box,) = regions[0]
    assert box.x0 > 290 and box.y1 < 570


def _axes(page: pymupdf.Page, x0: float, y: float, x1: float) -> None:
    """A plot's axes reaching left from under it, one path close enough to
    join its cluster (a lone rule this wide would not)."""
    shape = page.new_shape()
    shape.draw_polyline([(x0, y - 300), (x0, y), (x1, y)])
    shape.finish(color=(0, 0, 0), width=0.5, closePath=False)
    shape.commit()


def test_a_region_does_not_grow_into_body_text_it_cuts_across() -> None:
    def build(page):
        _scatter(page, pymupdf.Rect(300, 400, 560, 640))
        _axes(page, 120, 645, 560)
        for y in (450, 470, 490):  # a body-text column the axis reaches into
            page.insert_text(
                (72, y), "Body text of the page runs on and on", fontsize=9
            )

    _, regions, _ = flatten.flatten(_pdf(build))
    (box,) = regions[0]
    assert box.x0 > 290

    def labels(page):  # the same words, short label lines, are taken in
        _scatter(page, pymupdf.Rect(300, 400, 560, 640))
        _axes(page, 120, 645, 560)
        for y in (450, 470, 490):
            page.insert_text((72, y), "Body text of the", fontsize=9)

    _, regions, _ = flatten.flatten(_pdf(labels))
    (box,) = regions[0]
    assert box.x0 < 125


def test_a_region_grows_over_a_run_of_axis_ticks() -> None:
    def build(page):
        _scatter(page, pymupdf.Rect(300, 400, 560, 640))
        _axes(page, 120, 645, 560)
        page.insert_text((72, 630), "0 10 20 30 40 50 60 70 80", fontsize=9)

    _, regions, _ = flatten.flatten(_pdf(build))
    (box,) = regions[0]
    assert box.x0 < 125


def test_a_region_stops_at_its_frame() -> None:
    def build(page):
        _scatter(page, pymupdf.Rect(300, 400, 560, 640))
        page.draw_rect(pymupdf.Rect(290, 390, 570, 650), color=(0, 0, 0), width=0.5)
        # A margin bar beside the frame joins its cluster.
        page.draw_rect(pymupdf.Rect(575, 200, 590, 750), color=(0, 0, 0), width=0.5)

    _, regions, _ = flatten.flatten(_pdf(build))
    (box,) = regions[0]
    assert pymupdf.Rect(280, 380, 580, 660).contains(box) and box.x1 > 568

    def panels(page):  # one figure's panels, each in its own frame
        for x in (60, 205, 350):
            page.draw_rect(pymupdf.Rect(x, 390, x + 140, 610), color=(0, 0, 0))
        for x in (60, 350):  # dense, the middle one empty
            _scatter(page, pymupdf.Rect(x + 10, 400, x + 130, 600))

    _, regions, _ = flatten.flatten(_pdf(panels))
    (box,) = regions[0]
    assert box.x0 < 61 and box.x1 > 489


def test_a_rotated_page_is_flattened_and_keeps_its_rotation() -> None:
    plot = pymupdf.Rect(300, 400, 560, 640)
    for rotation in (90, 180, 270):
        doc = pymupdf.open()
        page = doc.new_page()
        _scatter(page, plot)
        page.set_rotation(rotation)
        out, regions, _ = flatten.flatten(doc.tobytes())
        flat = pymupdf.open(stream=out, filetype="pdf")[0]
        assert flat.rotation == rotation
        assert len(flat.get_images()) == 1 and not flat.get_cdrawings()
        # Reported as the rotated page shows the plot.
        (box,) = regions[0]
        shown = plot * flat.rotation_matrix
        assert (shown + (-4, -4, 4, 4)).contains(box) and flat.rect.contains(box)


def _ticks(page: pymupdf.Page, y: float, x0: float, x1: float) -> None:
    """A ruled answer blank as some books draw it: a 0.4 pt butt-capped tick
    as long as it is wide every 0.4 pt, each its own path."""
    x = x0
    while x < x1:
        shape = page.new_shape()
        shape.draw_line((x, y), (x, y + 0.4))
        shape.finish(color=(0, 0, 0), width=0.4, closePath=False)
        shape.commit()
        x += 0.4


def test_answer_blank_ticks_become_one_rectangle_and_no_picture() -> None:
    def build(page):
        # Two rows 1.3 pt apart: their redactions overlap.
        for y in (300, 301.3, 330, 360):
            _ticks(page, y, 150, 450)

    data = _pdf(build)
    out, regions, _ = flatten.flatten(data)
    assert out != data and regions == {}
    page = pymupdf.open(stream=out, filetype="pdf")[0]
    drawings = page.get_cdrawings()
    assert len(drawings) == 4 and all(d["type"] == "f" for d in drawings)
    assert not page.get_images()
    before = pymupdf.open(stream=data, filetype="pdf")[0].get_pixmap(dpi=150)
    after = page.get_pixmap(dpi=150)
    off = sum(abs(a - b) > 64 for a, b in zip(before.samples, after.samples))
    assert off < 0.001 * len(before.samples)


def _glyph_outlines(page: pymupdf.Page, x0: float, y0: float) -> None:
    """A formula drawn as filled glyph outlines: 8-segment shapes 4 pt apart
    in 12 pt lines."""
    for row in range(6):
        for col in range(30):
            x, y = x0 + col * 4, y0 + row * 12
            shape = page.new_shape()
            shape.draw_polyline(
                [(x, y), (x + 1, y - 2), (x + 2, y - 3), (x + 3, y - 2),
                 (x + 3, y), (x + 2, y + 1), (x + 1, y + 1), (x, y + 0.5), (x, y)]
            )  # fmt: skip
            shape.finish(fill=(0, 0, 0), color=None)
            shape.commit()


def test_a_quiet_region_grows_to_nothing_and_makes_no_figure() -> None:
    def build(page):
        _glyph_outlines(page, 100, 300)
        # A small box beside the formula, in its cluster: a figure's region
        # would grow to it.
        page.draw_rect(pymupdf.Rect(225, 300, 260, 360), color=(0, 0, 0), width=0.5)

    _, regions, quiet = flatten.flatten(_pdf(build))
    assert quiet == regions
    (box,) = regions[0]
    assert box.x1 < 224


def _ink(page: pymupdf.Page, rect: pymupdf.Rect, color=(0, 0, 0)) -> None:
    """A rendered formula's ink: a few strokes across its box."""
    shape = page.new_shape()
    for k in range(4):
        y = rect.y0 + (k + 0.5) * rect.height / 4
        shape.draw_line((rect.x0, y), (rect.x1, y))
    shape.finish(color=color, width=1)
    shape.commit()


def _block(kind: str, rect: pymupdf.Rect, page: pymupdf.Page, **extra) -> dict:
    """An ODL block over ``rect`` (bbox in thousandths of the page)."""
    w, h = page.rect.width / 1000, page.rect.height / 1000
    bbox = [rect.x0 / w, rect.y0 / h, rect.x1 / w, rect.y1 / h]
    return {"type": kind, "bbox": bbox, "page_idx": 0, **extra}


def test_a_quiet_formula_carries_the_formula_placeholder() -> None:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 200), "Solution", fontsize=10)
    page.insert_text((72, 300), "The force on the cart is", fontsize=10)
    display = pymupdf.Rect(100, 310, 300, 330)
    _ink(page, display)
    page.insert_text((72, 350), "which gives the answer.", fontsize=10)
    page.insert_text((72, 420), "the mass is", fontsize=10)
    inline = pymupdf.Rect(130, 410, 160, 422)
    _ink(page, inline)
    page.insert_text((165, 420), "and so on", fontsize=10)
    cell = pymupdf.Rect(300, 500, 340, 512)
    _ink(page, cell)
    table = pymupdf.Rect(72, 480, 540, 560)
    heading = _block("text", pymupdf.Rect(72, 190, 120, 202), page, text="Solution")
    paragraph = _block(
        "text", pymupdf.Rect(72, 410, 220, 422), page, text="the mass is and so on"
    )
    blocks = [
        heading,
        _block("text", pymupdf.Rect(72, 290, 200, 302), page, text="The force"),
        _block("image", display, page),
        _block("text", pymupdf.Rect(72, 340, 200, 352), page, text="which gives"),
        paragraph,
        _block("image", inline, page),
        _block("table", table, page),
    ]
    quiet = {0: [display, inline, cell]}
    out = pictures.flattened_figures(blocks, doc, quiet, quiet)
    # A display formula is its own block where ODL's picture was, a heading
    # beside it stays, and a table holds no paragraph: its formula follows it.
    assert [b["type"] for b in out] == [
        "text", "text", "equation", "text", "text", "equation", "table", "equation"
    ]  # fmt: skip
    assert out[0] is heading and out[2]["text"] == out[7]["text"] == "[formula]"
    assert out[5]["_picture"] == "inline"
    # An inline one is spliced between the words beside it.
    pictures.place_inline(out, doc)
    assert paragraph["text"] == "the mass is [formula] and so on"


def test_a_quiet_region_in_colour_gets_no_placeholder() -> None:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 300), "University Press", fontsize=10)
    logo = pymupdf.Rect(100, 310, 300, 330)
    _ink(page, logo, color=(0.1, 0.2, 0.8))  # a coloured wordmark
    page.insert_text((72, 350), "All rights reserved.", fontsize=10)
    blocks = [_block("image", logo, page)]
    out = pictures.flattened_figures(blocks, doc, {0: [logo]}, {0: [logo]})
    assert out == []


def test_a_formula_of_glyph_outlines_makes_no_figure_but_a_diagram_label_does() -> None:
    _, regions, quiet = flatten.flatten(
        _pdf(lambda page: _glyph_outlines(page, 100, 300))
    )
    assert quiet == regions

    def diagram(page):
        _glyph_outlines(page, 100, 300)
        _scatter(page, pymupdf.Rect(100, 380, 400, 630))  # the diagram beside it

    _, regions, quiet = flatten.flatten(_pdf(diagram))
    assert len(regions[0]) == 2 and not quiet


def test_a_book_without_dense_figures_is_returned_byte_for_byte() -> None:
    def build(page):
        page.insert_text((72, 100), "Only text and a rule.")
        page.draw_line((72, 110), (500, 110))

    data = _pdf(build)
    assert flatten.flatten(data) == (data, {}, {})


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
    assert flatten.flatten(data) == (data, {}, {})


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


def test_a_heading_above_a_region_joins_it_only_when_centred() -> None:
    doc = pymupdf.open()
    doc.new_page(width=1000, height=1000)
    region = pymupdf.Rect(100, 330, 500, 420)  # figure-sized: 3.6% of the page
    margin = {"type": "text", "text": "Solution", "text_level": 3}
    title = {"type": "text", "text": "Pregnancy Length", "text_level": 3}
    out = pictures.flattened_figures(
        [
            {**margin, "bbox": [100, 300, 180, 320], "page_idx": 0},
            {**title, "bbox": [240, 425, 360, 440], "page_idx": 0},
        ],
        doc,
        {0: [region]},
    )
    assert out[0]["text"] == "Solution" and out[0]["text_level"] == 3
    figure = next(b for b in out if b["type"] == "image")
    assert figure["figure_labels"] == ["Pregnancy Length"]


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
