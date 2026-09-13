"""Source PDFs exercise mixed-grid recovery, emphasis and replacement boundaries."""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parser"))
from odl import geometry, source_grid, tables


def source_table(*, styled=False, wrapped=False, wrap_font=None, wrap_leading=1.1):
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text(
        (60, 55), "Table 1: Counts\nComplete caption continuation.", fontsize=10
    )
    page.insert_text((430, 92), "(percent)", fontsize=10)
    for y in [110, 140, 220]:
        page.draw_line((60, y), (540, y))
    for x, text in zip([65, 185, 310, 440], ["Name", "Kind", "Train", "Test"]):
        page.insert_text((x, 130), text, fontsize=10)
    for row, values in enumerate(
        [["Apples", "Fruit", "10", "12"], ["Pears", "Food", "8", "9"]]
    ):
        y = 165 + row * 30
        for column, (x, text) in enumerate(zip([65, 185, 310, 440], values)):
            if styled and (row, column) == (1, 3):
                page.draw_rect(
                    pymupdf.Rect(433, y - 15, 465, y + 5),
                    color=None,
                    fill=(0.85, 0.85, 0.85),
                )
            font = "hebo" if styled and (row, column) == (0, 2) else "helv"
            if wrapped and (row, column) == (1, 0):
                if wrap_font:
                    page.insert_text((x, y), text, fontsize=10)
                    page.insert_text(
                        (x, y + 10 * wrap_leading),
                        "Conference",
                        fontname=wrap_font,
                        fontsize=10,
                    )
                    continue
                text += "\nConference"
            page.insert_text(
                (x, y), text, fontname=font, fontsize=10, lineheight=wrap_leading
            )
    page.insert_text(
        (60, 238), "Note: Counts refer to the full source sample.", fontsize=9
    )
    lines = geometry.text_lines(page)
    region = tables.select_regions(geometry.horizontal_rules(page), lambda: lines)[0]
    body = {
        "type": "text",
        "page_idx": 0,
        "bbox": [
            region[0] / 600 * 1000,
            region[1] / 800 * 1000,
            region[2] / 600 * 1000,
            region[3] / 800 * 1000,
        ],
        "text": " ".join(
            line["text"] for line in lines if tables._in_body(line, region)
        ),
    }
    caption = {
        "type": "text",
        "page_idx": 0,
        "bbox": [60 / 600 * 1000, 40 / 800 * 1000, 560 / 600 * 1000, 100 / 800 * 1000],
        "text": "Table 1: Counts Complete caption continuation. (percent)",
    }
    return document, page, lines, region, [caption, body]


def test_mixed_columns_complete_caption_units_notes_and_styles():
    document, page, lines, region, blocks = source_table(styled=True)
    with document:
        bundle = tables.recover_mixed(page, region, lines)
        assert bundle["table"]["headers"] == ["Name", "Kind", "Train", "Test"]
        assert bundle["table"]["rows"] == [
            ["Apples", "Fruit", "10", "12"],
            ["Pears", "Food", "8", "9"],
        ]
        block = bundle["block"]
        assert "Complete caption continuation." in " ".join(block["table_caption"])
        assert "(percent)" in " ".join(block["table_caption"])
        assert block["table_footnote"] == [
            "Note: Counts refer to the full source sample."
        ]
        assert block["_table_source_styles"] == [
            {"row": 0, "column": 2, "styles": ["bold"]},
            {"row": 1, "column": 3, "styles": ["gray background"]},
        ]
        assert "[bold" not in block["table_body"]
        original = copy.deepcopy(blocks)
        result, count = tables.replace_tables(blocks, [bundle], [], document)
        assert count == 1
        assert result[0] == blocks[0]
        assert result[1] == block
        assert blocks == original
        assert block["bbox"][1] < blocks[1]["bbox"][1]
        assert block["bbox"][3] > blocks[1]["bbox"][3]


@pytest.mark.parametrize(
    "case",
    [
        "native_table",
        "footer",
        "header",
        "page_footnote",
        "page_number",
        "partial",
        "unpositioned",
        "missing_text",
        "unrepresented_source",
    ],
)
def test_body_replacement_preserves_native_evidence(case):
    document, page, lines, region, blocks = source_table()
    with document:
        bundle = tables.recover_mixed(page, region, lines)
        if case == "native_table":
            blocks[1]["type"] = "table"
            blocks[1]["table_body"] = bundle["block"]["table_body"]
        elif case in {"footer", "header", "page_footnote", "page_number"}:
            blocks[1]["type"] = case
        elif case == "partial":
            blocks[1]["bbox"][0] -= 20
        elif case == "unpositioned":
            blocks.append(
                {"type": "text", "page_idx": 0, "text": "Unpositioned source label"}
            )
        elif case == "unrepresented_source":
            page.insert_text((185, 212), "Extra", fontsize=10)
        else:
            blocks[1]["text"] += " An omitted source qualifier"
        original = copy.deepcopy(blocks)
        assert tables.replace_tables(blocks, [bundle], [], document) == (original, 0)


@pytest.mark.parametrize("joined", [False, True])
def test_ambiguous_header_scope_stays_native(joined):
    document = pymupdf.open()
    with document:
        page = document.new_page(width=600, height=800)
        for y in [100, 135, 220]:
            page.draw_line((50, y), (550, y))
        if joined:
            page.insert_text((55, 125), "System", fontsize=10)
            page.insert_text((210, 125), "Alpha Beta Gamma Delta", fontsize=18)
        else:
            for x, text in zip(
                [55, 180, 290, 400, 505], ["System", "Count", "%", "Count", "%"]
            ):
                page.insert_text((x, 125), text, fontsize=10)
        for row, name in enumerate(["First", "Second"]):
            for x, text in zip(
                [55, 180, 290, 400, 505], [name, "11", "22", "33", "44"]
            ):
                page.insert_text((x, 165 + row * 30), text, fontsize=10)
        lines = geometry.text_lines(page)
        region = tables.select_regions(geometry.horizontal_rules(page), lambda: lines)[
            0
        ]
        with pytest.raises(source_grid.AmbiguousGrid):
            tables.recover_mixed(page, region, lines)


def test_partial_cell_emphasis_abstains():
    document, page, lines, region, _ = source_table()
    with document:
        table = source_grid.recover(page, region, lines)
        # A single source cell containing both bold and plain values cannot
        # truthfully receive one whole-cell style marker.
        page.insert_text((324, 165), "x", fontname="hebo", fontsize=10)
        table["assignments"][2]["bbox"][2] = 331
        with pytest.raises(source_grid.AmbiguousGrid, match="partial bold"):
            source_grid.cell_styles(page, table)


@pytest.mark.parametrize("label", ["*", "Source", "Note"])
@pytest.mark.parametrize("baseline", [208, 215])
def test_loose_body_text_has_no_row_owner(label, baseline):
    document, page, _, region, _ = source_table()
    with document:
        # Even a close, aligned, same-font line is independent source text.
        page.insert_text((65, baseline), label, fontsize=10)
        with pytest.raises(source_grid.AmbiguousGrid, match="row continuation"):
            tables.recover_mixed(page, region, geometry.text_lines(page))


def test_wrapped_cell_requires_source_line_continuity():
    document, page, lines, region, _ = source_table(wrapped=True)
    with document:
        table = tables.recover_mixed(page, region, lines)["table"]
        assert table["rows"][1] == ["Pears Conference", "Food", "8", "9"]
        page.draw_line((60, 201), (540, 201))
        with pytest.raises(source_grid.AmbiguousGrid, match="row continuation"):
            tables.recover_mixed(page, region, lines)


@pytest.mark.parametrize("leading,font", [(2.5, None), (1.1, "hebo")])
def test_wrapped_cell_cannot_cross_style_or_line_height(leading, font):
    document, page, lines, region, _ = source_table(
        wrapped=True, wrap_font=font, wrap_leading=leading
    )
    with document, pytest.raises(source_grid.AmbiguousGrid, match="row continuation"):
        source_grid.recover(page, region, lines)


def test_caption_does_not_absorb_separate_intervening_paragraph():
    document, page, _, region, _ = source_table()
    with document:
        page.insert_text((60, 87), "This paragraph discusses a caveat.", fontsize=10)
        bundle = tables.recover_mixed(page, region, geometry.text_lines(page))
        assert "Complete caption continuation." in bundle["table"]["title"]
        assert "(percent)" in bundle["table"]["title"]
        assert "caveat" not in bundle["table"]["title"]
        assert not any(
            "caveat" in line["text"] for line in bundle["table"]["context_lines"]
        )


def test_explicit_unit_span_keeps_its_scope_beside_unrelated_prose():
    document, page, _, region, _ = source_table()
    with document:
        prose = "Unrelated source prose.       "
        page.insert_text((60, 90), prose, fontsize=10)
        unit_x = 60 + pymupdf.get_text_length(prose, fontsize=10)
        page.insert_text((unit_x, 90), "Units:", fontname="hebo", fontsize=10)
        value_x = unit_x + pymupdf.get_text_length(
            "Units:", fontname="hebo", fontsize=10
        )
        page.insert_text((value_x, 90), " kg", fontsize=10)
        lines = geometry.text_lines(page)
        assert any(
            "prose." in line["text"] and "Units:" in line["text"] for line in lines
        )
        result = tables.recover_mixed(page, region, lines)["table"]
        assert "Units: kg" in result["captions"]
        assert "Unrelated" not in result["title"]
        unit = next(
            line for line in result["context_lines"] if line["text"] == "Units: kg"
        )
        assert unit["bbox"][0] == pytest.approx(unit_x)


@pytest.mark.parametrize("label", ["註:", "註：", "注:", "注：", "註釋："])
def test_explicit_chinese_source_note_labels(label):
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=800)
        page.draw_line((60, 220), (540, 220))
        page.insert_text(
            (60, 238), label + "完整來源樣本。", fontname="china-t", fontsize=9
        )
        lines = geometry.text_lines(page)
        note = next(line for line in lines if line["text"].startswith(label))
        assert 0 < note["bbox"][1] - 220 < 18
        table = tables.mixed_context(page, [60, 110, 540, 220], lines, {})
        assert label + "完整來源樣本。" in table["notes"]
