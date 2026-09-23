"""Focused checks on the parser's native-repair rules (parser/odl).

These are the invariants the September 2026 parser lab proved on its corpus,
kept as small synthetic cases: each rule only fires with source evidence and
preserves every block it does not touch. The whole-corpus equality with the
lab's ``refined-final-r1`` outputs is checked against the ingest host, not here.
"""

from __future__ import annotations

import copy
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pymupdf
import pytest

PARSER_DIR = Path(__file__).resolve().parents[2] / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))

from odl import (
    columns,
    context,
    fonts,
    furniture,
    hidden,
    lists,
    ocr,
    order,
    refine,
    source_text,
    tables,
)
from odl.adapter import node_text, odl_content_list
from odl.table_html import Table, table_html


def test_image_dedup_keeps_every_occurrence_and_distinct_bytes(tmp_path):
    for name, data in (
        ("first.png", b"abcd"),
        ("copy.png", b"abcd"),
        ("other.png", b"abce"),
    ):
        (tmp_path / name).write_bytes(data)
    blocks = [
        {"type": "image", "img_path": name, "page_idx": page, "bbox": [1, 2, 3, 4]}
        for page, name in enumerate(("first.png", "copy.png", "other.png", "copy.png"))
    ]
    original = copy.deepcopy(blocks)
    images, paths = refine._check_images(blocks, tmp_path)
    assert images == {"first.png": b"abcd", "other.png": b"abce"}
    assert [b["img_path"] for b in blocks] == [
        "first.png",
        "first.png",
        "other.png",
        "first.png",
    ]
    assert [{k: v for k, v in b.items() if k != "img_path"} for b in blocks] == [
        {k: v for k, v in b.items() if k != "img_path"} for b in original
    ]
    for before, after in zip(original, blocks):
        assert images[after["img_path"]] == (tmp_path / before["img_path"]).read_bytes()
    markdown = "![](<copy.png>)\n![plot](<other.png>)\nA literal copy.png."
    assert refine._image_markdown(markdown, paths) == (
        "![](<images/first.png>)\n![plot](<images/other.png>)\nA literal copy.png."
    )
    with pytest.raises(ValueError, match="missing image"):
        refine._check_images([{"img_path": "missing.png"}], tmp_path)


def _pdf(tmp_path: Path, draw) -> Path:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    draw(page)
    path = tmp_path / "source.pdf"
    document.save(path)
    return path


@pytest.mark.parametrize("folio_y", [780, 40])
@pytest.mark.parametrize(
    "folios", [["| 7 |", "| 8 |", "| 9 |"], ["xvi", "xvii", "xviii"]]
)
def test_source_folios_require_isolation_and_repeated_page_offsets(
    folios, folio_y
) -> None:
    document = pymupdf.open()
    blocks = []
    for i, folio in enumerate(folios):
        page = document.new_page(width=600, height=800)
        page.insert_text((60, 100), "Keep this short prose.")
        page.insert_text((290, folio_y), folio, fontsize=10)
        for source in page.get_text("blocks"):
            blocks.append(
                {
                    "type": "text",
                    "text": source[4].strip(),
                    "page_idx": i,
                    "bbox": [
                        source[0] / 600 * 1000,
                        source[1] / 800 * 1000,
                        source[2] / 600 * 1000,
                        source[3] / 800 * 1000,
                    ],
                }
            )
    marked = furniture.mark_page_numbers(blocks, document)
    assert [b["text"] for b in marked if b["type"] == "page_number"] == folios
    assert [b for b in marked if b["type"] == "text"] == blocks[::2]
    headings = [dict(b, text_level=1) for b in blocks]
    assert all(
        "text_level" not in b
        for b in furniture.mark_page_numbers(headings, document)
        if b["type"] == "page_number"
    )
    assert furniture.mark_page_numbers(blocks[:4], document) == blocks[:4]
    # The same values beside a margin table label are not folios.
    for page in document:
        page.insert_text((60, folio_y), "Measured value", fontsize=10)
    assert furniture.mark_page_numbers(blocks, document) == blocks
    document.close()


def test_adapter_maps_bottom_left_points_to_page_1000_top_left() -> None:
    native = {
        "number of pages": 1,
        "kids": [
            {
                "type": "heading",
                "id": 1,
                "heading level": 2,
                "content": "Results",
                "page number": 1,
                "bounding box": [50, 700, 250, 720],
            },
            {
                "type": "table",
                "id": 2,
                "page number": 1,
                "bounding box": [0, 0, 500, 400],
                "rows": [
                    {
                        "cells": [
                            {"is_header": True, "content": "a"},
                            {"content": "b", "column span": 2},
                        ]
                    }
                ],
            },
            {
                "type": "list",
                "id": 3,
                "list items": [{"content": "x"}, {"content": "y"}],
            },
        ],
    }
    blocks = odl_content_list(native, [{"width": 500, "height": 800}])
    assert blocks[0] == {
        "_native_type": "heading",
        "_native_id": 1,
        "page_idx": 0,
        "bbox": [100.0, 100.0, 500.0, 125.0],
        "type": "text",
        "text": "Results",
        "text_level": 2,
    }
    assert blocks[1]["table_body"] == (
        '<table><tr><th rowspan="1" colspan="1">a</th>'
        '<td rowspan="1" colspan="2">b</td></tr></table>'
    )
    assert blocks[2] == {
        "_native_type": "list",
        "_native_id": 3,
        "type": "list",
        "list_items": ["x", "y"],
    }


def test_table_html_round_trips_explicit_spans() -> None:
    html = table_html(
        ["", "2019", "2020"],
        [["Total", "1", "2"], ["Sub", "3", ""]],
        [{"row": 1, "column": 1, "rowspan": 1, "colspan": 2}],
    )
    parser = Table()
    parser.feed(html)
    parser.close()
    headers, rows = parser.grid()
    assert headers == ["", "2019", "2020"]
    assert rows == [["Total", "1", "2"], ["Sub", "3", "3"]]
    with pytest.raises(ValueError):
        table_html(["a"], [["x", "y"]])


def test_contextualize_attaches_only_adjacent_captions_above() -> None:
    table = {
        "type": "table",
        "page_idx": 0,
        "bbox": [100, 300, 900, 600],
        "table_body": "<table><tr><th>Year</th><th>Value</th></tr><tr><td>2020</td><td>1</td></tr></table>",
    }
    caption = {
        "type": "text",
        "text": "Table 3 Growth",
        "page_idx": 0,
        "bbox": [100, 250, 400, 280],
    }
    unit = {
        "type": "text",
        "text": "(percent)",
        "page_idx": 0,
        "bbox": [700, 280, 900, 298],
    }
    out = context.contextualize([caption, unit, table])
    assert out[2]["table_caption"] == ["Table 3 Growth", "(percent)"]
    assert out[2]["bbox"] == [100, 250, 900, 600]
    assert out[2]["_native_table_supported"] is True
    far = {**caption, "bbox": [100, 100, 400, 130]}
    assert "table_caption" not in context.contextualize([far, table])[1]
    headerless = {**table, "table_body": "<table><tr><td>1</td></tr></table>"}
    assert (
        "_native_table_supported" not in context.contextualize([caption, headerless])[1]
    )


def test_footer_tables_need_unique_identity_page_and_content() -> None:
    table = {
        "id": 2,
        "type": "table",
        "page number": 1,
        "rows": [{"cells": [{"content": "Page footer"}]}],
    }
    native = {"kids": [{"type": "footer", "kids": [table]}]}
    block = {
        **odl_content_list(table, [])[0],
        "page_idx": 0,
        "bbox": [10, 950, 90, 980],
    }
    revised, marked = tables.mark_footer_tables([block], native)
    assert marked == 1 and revised[0]["type"] == "footer"
    assert (
        tables.mark_footer_tables(
            [block], {"kids": [{"type": "header", "kids": [table]}]}
        )[1]
        == 0
    )
    assert (
        tables.mark_footer_tables([block], {"kids": [table, *native["kids"]]})[1] == 0
    )
    for changed in [{**block, "table_body": "changed"}, {**block, "page_idx": 1}]:
        assert tables.mark_footer_tables([changed], native)[0] == [changed]
    assert block["type"] == "table"


def test_column_reorder_only_on_two_clear_columns() -> None:
    def block(x, y, title):
        return {
            "type": "text",
            "page_idx": 0,
            "bbox": [x, y, x + 350, y + 180],
            "text": title + " ordinary prose" * 20,
        }

    a, b, c, d = (
        block(x, y, n)
        for x, y, n in [
            (50, 100, "a"),
            (500, 100, "b"),
            (50, 400, "c"),
            (500, 400, "d"),
        ]
    )
    result, reordered = order.repair([a, b, c, d])
    assert result == [a, c, b, d] and reordered == {0}
    assert order.repair(result)[0] == result
    mixed = [a, b, c, d, {"type": "image", "page_idx": 0, "bbox": [0, 0, 100, 100]}]
    assert order.repair(mixed) == (mixed, set())


def test_hidden_ocr_pages_are_read_column_by_column() -> None:
    blocks = [
        {"type": "text", "page_idx": 0, "bbox": box, "text": label * 40}
        for box, label in [
            ([20, 10, 430, 40], "left top "),
            ([500, 10, 910, 40], "right top "),
            ([20, 50, 430, 80], "left bottom "),
            ([500, 50, 910, 80], "right bottom "),
        ]
    ]
    ordered = hidden.recover_hidden_ocr_order(blocks, {0})
    assert ordered == [blocks[0], blocks[2], blocks[1], blocks[3]]
    assert hidden.recover_hidden_ocr_order(ordered, {0}) == ordered
    assert hidden.recover_hidden_ocr_order(blocks, set()) == blocks


def test_overprint_deletion_needs_matching_source_runs() -> None:
    assert (
        source_text.delete_supported_repeats(
            "AAABBB book 1000", "AB book 1000", Counter(A=2, B=2)
        )[0]
        == "AB book 1000"
    )
    assert (
        source_text.delete_supported_repeats("AAABBB", "AB", Counter())[0] == "AAABBB"
    )
    assert source_text.delete_supported_repeats("book", "bok", Counter())[0] == "book"
    for original, source in [("100000 0", "1000 0"), ("AAABBB B", "AB B")]:
        assert source_text.delete_supported_repeats(
            original, source, Counter(original)
        ) == (original, {})
    trace = {
        "opacity": 1,
        "type": 0,
        "dir": (1, 0),
        "font": "Test",
        "size": 10,
        "chars": [(65, 1, (x, 10), (x, 0, x + 10, 10)) for x in [0, 0.15, 0.3, 15, 30]],
    }
    assert source_text.overprints([trace], pymupdf.Rect(0, 0, 50, 20)) == Counter(A=2)
    assert not source_text.overprints(
        [{**trace, "opacity": 0}], pymupdf.Rect(0, 0, 50, 20)
    )


def test_list_items_keep_their_boundaries_through_a_repair() -> None:
    assert lists.restore_items(["AAABBB\nCCC", "DDDEEE"], "AB\nC\nDE") == [
        "AB\nC",
        "DE",
    ]
    assert lists.restore_items(
        ["book 1000", "www.example"], "book 1000\nwww.example"
    ) == ["book 1000", "www.example"]
    with pytest.raises(ValueError):
        lists.restore_items(["AAA", "AAA"], "AA\n")


def test_list_geometry_unions_flattened_descendants_only(tmp_path: Path) -> None:
    path = _pdf(tmp_path, lambda page: None)
    with pymupdf.open() as document:
        document.new_page(width=100, height=100)
        document.save(path)
    native = {
        "kids": [
            {
                "id": 1,
                "type": "list",
                "page number": 1,
                "bounding box": [10, 10, 30, 80],
                "list items": [
                    {
                        "id": 2,
                        "content": "Title",
                        "page number": 1,
                        "bounding box": [10, 70, 30, 80],
                        "kids": [
                            {
                                "id": 3,
                                "content": "Included body",
                                "page number": 1,
                                "bounding box": [10, 10, 80, 65],
                            },
                            {
                                "id": 4,
                                "type": "table",
                                "rows": [
                                    {
                                        "id": 5,
                                        "content": "Not flattened",
                                        "page number": 1,
                                        "bounding box": [0, 0, 100, 100],
                                    }
                                ],
                            },
                        ],
                    }
                ],
            }
        ]
    }
    blocks = [
        {
            "type": "list",
            "_native_id": 1,
            "page_idx": 0,
            "bbox": [100, 200, 300, 900],
            "list_items": [node_text(native["kids"][0]["list items"][0])],
        }
    ]
    revised, expanded = lists.repair_list_geometry(blocks, native, path)
    assert revised[0]["bbox"] == [100, 200, 800, 900] and expanded == 1
    assert lists.repair_list_geometry(revised, native, path)[0] == revised
    changed = copy.deepcopy(blocks)
    changed[0]["list_items"] = ["Changed text"]
    assert lists.repair_list_geometry(changed, native, path)[0] == changed


def test_column_continuation_moves_only_past_smaller_print(tmp_path: Path) -> None:
    texts = [
        "An ordinary body paragraph continues from",
        "1 A footnote preserves independent facts.",
        "Another source finishes the sentence.",
    ]
    for small in (True, False):
        document = pymupdf.open()
        page = document.new_page(width=600, height=800)
        for position, value, size in zip(
            [(60, 720), (60, 755), (330, 200)], texts, [10, 8 if small else 10, 10]
        ):
            page.insert_text(position, value, fontsize=size)
        blocks = []
        for value in texts:
            box = page.search_for(value)[0]
            blocks.append(
                {
                    "type": "text",
                    "page_idx": 0,
                    "text": value,
                    "bbox": [
                        box.x0 / 600 * 1000,
                        box.y0 / 800 * 1000,
                        box.x1 / 600 * 1000,
                        box.y1 / 800 * 1000,
                    ],
                }
            )
        path = tmp_path / f"{small}.pdf"
        document.save(path)
        result, moves = columns.repair_columns(blocks, path)
        if small:
            assert moves == 1 and [b["text"] for b in result] == [
                texts[0],
                texts[2],
                texts[1],
            ]
        else:
            assert moves == 0 and result == blocks


def test_font_repair_only_rebuilds_a_contradictory_type1_map() -> None:
    encoding = fonts.explicit_encoding(
        b"/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\n"
        + b"\n".join(f"dup {ord(c)} /{c} put".encode() for c in "ABCDEFGH")
        + b"\nreadonly def currentfile eexec"
    )
    assert fonts.contradiction(encoding, "1 beginbfrange <00> <FF> <7500> endbfrange")[
        "eligible"
    ]
    assert not fonts.contradiction(
        encoding, "1 beginbfrange <00> <FF> <0000> endbfrange"
    )["eligible"]
    assert not fonts.contradiction(
        {65: "A"}, "1 beginbfrange <00> <FF> <7500> endbfrange"
    )["eligible"]
    assert fonts.explicit_encoding(b"/Encoding StandardEncoding def") == {}
    with pymupdf.open() as document:
        document.new_page().insert_text((50, 50), "plain")
        data = document.tobytes()
    assert fonts.repair_fonts(data) == (data, 0)


def test_ocr_lines_become_page_blocks_after_the_page(tmp_path: Path) -> None:
    blocks = [
        {"page_idx": 0, "type": "image", "bbox": [0, 0, 1000, 1000]},
        {"page_idx": 1, "type": "text", "text": "b", "bbox": [0, 0, 1, 1]},
    ]
    lines = [
        {
            "box": [[10, 500], [90, 500], [90, 520], [10, 520]],
            "text": "second",
            "score": 0.9,
        },
        {
            "box": [[10, 10], [90, 10], [90, 30], [10, 30]],
            "text": "first",
            "score": 0.9,
        },
    ]
    new = ocr.line_blocks(lines, (100, 1000), 0)
    assert [b["text"] for b in new] == ["first", "second"]
    assert (
        new[0]["bbox"] == [100.0, 10.0, 900.0, 30.0]
        and new[0]["_recovery"] == "rapidocr-line"
    )
    merged = ocr.merge(blocks, 0, new)
    assert [b.get("text", b["type"]) for b in merged] == [
        "image",
        "first",
        "second",
        "b",
    ]
    with pymupdf.open() as document:
        document.new_page().insert_text(
            (50, 50), "a page with enough native characters to keep"
        )
        document.new_page()
        assert ocr.textless_pages(document) == [1]


def test_font_repair_abstains_for_an_unknown_unused_glyph() -> None:
    fixture = Path(__file__).parent / "fixtures" / "odl-ccl-feedback-p1" / "source.pdf"
    with pymupdf.open(fixture) as document:
        original_pixels = document[0].get_pixmap().samples
        selected = fonts.eligible_fonts(document)[0]
        descriptor = int(
            document.xref_get_key(selected["xref"], "FontDescriptor")[1].split()[0]
        )
        font_file = int(document.xref_get_key(descriptor, "FontFile")[1].split()[0])
        insertion = b"dup 255 /custom_glyph put\n"
        revised, count = re.subn(
            rb"(/Encoding 256 array\s+.*?)(readonly def)",
            lambda m: m[1] + insertion + m[2],
            document.xref_stream(font_file),
            count=1,
            flags=re.DOTALL,
        )
        assert count == 1 and 255 not in selected["encoding"]
        length1 = int(document.xref_get_key(font_file, "Length1")[1])
        document.update_stream(font_file, revised)
        document.xref_set_key(font_file, "Length1", str(length1 + len(insertion)))
        candidate = document.tobytes()
    with pymupdf.open(stream=candidate, filetype="pdf") as document:
        assert document[0].get_pixmap().samples == original_pixels
    assert fonts.repair_fonts(candidate) == (candidate, 0)


def test_recovered_table_block_carries_spans_and_citation_box() -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((60, 80), "Table 1 Counts", fontsize=10)
    page.draw_line((60, 100), (540, 100))
    page.insert_text((200, 115), "2019", fontsize=10)
    page.insert_text((400, 115), "2020", fontsize=10)
    page.draw_line((60, 120), (540, 120))
    for row, (label, a, b) in enumerate(
        [("Apples", "10", "12"), ("Pears", "3", "4"), ("Plums", "7", "9")]
    ):
        y = 140 + row * 20
        page.insert_text((60, y), label, fontsize=10)
        page.insert_text((200, y), a, fontsize=10)
        page.insert_text((400, y), b, fontsize=10)
    page.draw_line((60, 210), (540, 210))
    lines = tables.geometry.text_lines(page)
    regions = tables.select_regions(
        tables.geometry.horizontal_rules(page), lambda: lines
    )
    assert len(regions) == 1
    bundle = tables.recover(page, regions[0], lines)
    assert bundle["table"]["headers"] == ["", "2019", "2020"]
    assert bundle["table"]["rows"][0] == ["Apples", "10", "12"]
    block = bundle["block"]
    assert block["type"] == "table" and block["_recovery"] == "source-geometry"
    assert "Table 1 Counts" in json.dumps(block["table_caption"])
    assert block["bbox"][1] < 100 / 800 * 1000
