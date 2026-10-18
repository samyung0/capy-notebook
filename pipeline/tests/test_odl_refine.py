"""Focused checks on the parser's native-repair rules (parser/odl).

These are the invariants the September 2026 parser lab proved on its corpus,
kept as small synthetic cases: each rule only fires with source evidence and
preserves every block it does not touch. The whole-corpus equality with the
lab's ``refined-final-r1`` outputs is checked against the ingest host, not here.
"""

from __future__ import annotations

import copy
import errno
import itertools
import json
import math
import random
import re
import sys
from collections import Counter
from pathlib import Path
from types import SimpleNamespace

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
    joins,
    lists,
    order,
    page_text,
    pictures,
    scripts,
    source_text,
    tables,
    textless,
)
from odl.adapter import node_text, odl_content_list
from odl.table_html import Table, table_html


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


def test_adapter_keeps_tables_nested_in_list_items_and_cells() -> None:
    nested = {
        "type": "table",
        "rows": [
            {"cells": [{"content": "(1,-1)"}, {"content": "(0,0)"}]},
            {"cells": [{"content": "(2,-2)"}, {"kids": [{"content": "(3,-3)"}]}]},
        ],
    }
    native = {
        "kids": [
            {"type": "list", "list items": [{"content": "Payoffs", "kids": [nested]}]},
            {"type": "table", "rows": [{"cells": [{"kids": [nested]}]}]},
        ]
    }
    rows = "(1,-1) | (0,0)\n(2,-2) | (3,-3)"
    blocks = odl_content_list(native, [])
    assert blocks[0]["list_items"] == [f"Payoffs {rows}"]
    assert blocks[1]["table_body"] == (
        f'<table><tr><td rowspan="1" colspan="1">{rows}</td></tr></table>'
    )


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


def _simple_font_pdf(text: str, differences: str, bfchar: str) -> bytes:
    """Helvetica with a /Differences encoding and the given ToUnicode entries."""
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((50, 50), text, fontname="helv")
        font = page.get_fonts()[0][0]
        document.xref_set_key(font, "Encoding", f"<</Differences[{differences}]>>")
        cmap = document.get_new_xref()
        document.update_object(cmap, "<<>>")
        document.update_stream(
            cmap,
            b"1 begincodespacerange <00> <FF> endcodespacerange\n"
            + f"{bfchar.count('<') // 2} beginbfchar {bfchar} endbfchar".encode(),
        )
        document.xref_set_key(font, "ToUnicode", f"{cmap} 0 R")
        return document.tobytes()


def _to_unicode(data: bytes) -> dict[int, str]:
    with pymupdf.open(stream=data, filetype="pdf") as document:
        font = document[0].get_fonts()[0][0]
        cmap = int(document.xref_get_key(font, "ToUnicode")[1].split()[0])
        return fonts._read_cmap(document.xref_stream(cmap).decode("latin-1"))


def test_font_repair_follows_glyph_names_over_a_contradicting_map() -> None:
    # A Quartz re-save of TeX output: /minus to NUL, Greek to ASCII letters.
    data = _simple_font_pdf(
        "d-a'",
        "39/quoteright 45/minus 97/alpha 100/delta",
        "<27> <0027> <2D> <0000> <61> <0061> <64> <0064>",
    )
    repaired, count = fonts.repair_fonts(data)
    assert count == 1
    # The quote mapped to ASCII stays; the maths follows its glyph names.
    assert _to_unicode(repaired) == {0x27: "'", 0x2D: "\u2212", 0x61: "α", 0x64: "δ"}
    with pymupdf.open(stream=repaired, filetype="pdf") as document:
        assert document[0].get_text().strip() == "δ\u2212α'"
    # One contradicted letter alone is not evidence enough.
    lone = _simple_font_pdf("d", "100/delta", "<64> <0064>")
    assert fonts.repair_fonts(lone) == (lone, 0)


def test_tex_negation_slash_maps_to_u0338_and_composes() -> None:
    # Ghostscript leaves /negationslash out of the map; veraPDF would blank it.
    data = _simple_font_pdf(
        "x6=y", "54/negationslash", "<78> <0078> <3D> <003D> <79> <0079>"
    )
    repaired, count = fonts.repair_fonts(data)
    assert count == 1 and _to_unicode(repaired)[0x36] == "\u0338"
    blocks = [
        {"type": "text", "text": "x\u0338 =y and z\u0338~"},
        {"type": "list", "list_items": ["a \u0338∈ B", "plain"]},
        {"type": "table", "table_body": "<td>\u0338≡</td>"},
    ]
    assert fonts.compose_negations(blocks) == [
        {"type": "text", "text": "x≠y and z\u0338~"},
        {"type": "list", "list_items": ["a ∉ B", "plain"]},
        {"type": "table", "table_body": "<td>≢</td>"},
    ]


def _builtin_type1_pdf(base_font: str) -> bytes:
    """A Type1 font with no ToUnicode and no /Encoding, only its program's array."""
    program = (
        b"%!PS-AdobeFont-1.0: CMSY10\n/Encoding 256 array\n"
        b"0 1 255 {1 index exch /.notdef put} for\n"
        b"dup 0 /minus put\ndup 54 /negationslash put\ndup 96 /turnstileleft put\n"
        b"dup 97 /a10 put\ndup 120 /x put\nreadonly def\ncurrentfile eexec\n"
    )
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((50, 50), "x", fontname="helv")
        font = page.get_fonts()[0][0]
        file = document.get_new_xref()
        document.update_object(file, f"<</Length1 {len(program)}/Length2 0/Length3 0>>")
        document.update_stream(file, program)
        descriptor = document.get_new_xref()
        document.update_object(
            descriptor,
            f"<</Type/FontDescriptor/FontName/{base_font}/FontFile {file} 0 R>>",
        )
        document.xref_set_key(font, "BaseFont", f"/{base_font}")
        document.xref_set_key(font, "Encoding", "null")
        document.xref_set_key(font, "FontDescriptor", f"{descriptor} 0 R")
        return document.tobytes()


def test_tex_fonts_without_to_unicode_map_their_builtin_encoding() -> None:
    repaired, count = fonts.repair_fonts(_builtin_type1_pdf("ABCDEF+CMSY10"))
    # The checked TeX list wins over pypdf's (⊣); a picture-font name stays out.
    assert count == 1
    assert _to_unicode(repaired) == {0: "−", 54: "̸", 96: "⊢", 120: "x"}
    # Only TeX's own font families: a LaTeX picture font is left as written.
    other = _builtin_type1_pdf("ABCDEF+LINE10")
    assert fonts.repair_fonts(other) == (other, 0)


def test_symbol_fonts_trade_private_use_for_the_symbol_encoding() -> None:
    # Word's SymbolMT: × at U+F0B4, π at U+F070, a paren piece at U+F0E6.
    mapping = {1: "\uf0b4", 2: "\uf070", 3: "\uf0e6", 4: "a", 5: "×"}
    assert fonts.symbol_values(mapping) == {1: "×", 2: "π", 3: "⎛"}


def test_furniture_keys_skip_texts_repeated_mostly_inside_the_page() -> None:
    def block(text: str, page: int, box: list[float]) -> dict:
        return {"type": "text", "text": text, "page_idx": page, "bbox": box}

    edge, inside = [100, 30, 900, 60], [100, 400, 900, 440]
    blocks = [block("Running title", page, edge) for page in range(3)]
    # A citation printed in four chapter source lists, once at a page top.
    blocks += [block("Head, Fister and MacMillan", p, inside) for p in range(3)]
    blocks.append(block("Head, Fister and MacMillan", 3, edge))
    # Half inside is still furniture.
    blocks += [block("Half", p, inside if p < 2 else edge) for p in range(4)]
    assert furniture.repeated_across_pages(blocks) == ["Half", "Running title"]


def test_split_ligature_spaces_drawn_inside_the_glyph_are_dropped(
    tmp_path: Path,
) -> None:
    with pymupdf.open() as document:
        page = document.new_page()
        writer = pymupdf.TextWriter(page.rect)
        font = pymupdf.Font("helv")
        writer.append((100, 100), "beneﬁ", font=font, fontsize=12)
        end = writer.last_point.x
        writer.append((end - 4, 100), " ", font=font, fontsize=12)  # inside the ﬁ
        writer.append((end, 100), "ts and staﬀ", font=font, fontsize=12)
        writer.append((writer.last_point.x + 4, 100), "is", font=font, fontsize=12)
        writer.write_text(page)
        pdf = tmp_path / "source.pdf"
        document.save(pdf)
    box = [0, 0, 1000, 1000]
    blocks = [
        {"type": "text", "text": "beneﬁ ts and staﬀ is", "page_idx": 0, "bbox": box},
        {"type": "list", "list_items": ["beneﬁ ts", "x"], "page_idx": 0, "bbox": box},
        # More splits than the glyphs prove: left as ODL wrote it.
        {"type": "text", "text": "beneﬁ ts, beneﬁ ts", "page_idx": 0, "bbox": box},
    ]
    revised, dropped = source_text.join_split_ligatures(blocks, pdf)
    assert dropped == 2
    assert revised[0]["text"] == "beneﬁts and staﬀ is"
    assert revised[1]["list_items"] == ["beneﬁts", "x"]
    assert revised[2] is blocks[2]


def test_source_glyphs_are_kept_for_one_page_at_a_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only the current page's rawdict stays cached; a revisited page is read
    again and repaired exactly like a block read alone."""
    with pymupdf.open() as document:
        for _ in range(2):
            page = document.new_page()
            writer = pymupdf.TextWriter(page.rect)
            font = pymupdf.Font("helv")
            writer.append((100, 100), "beneﬁ", font=font, fontsize=12)
            end = writer.last_point.x
            writer.append((end - 4, 100), " ", font=font, fontsize=12)
            writer.append((end, 100), "ts", font=font, fontsize=12)
            writer.write_text(page)
        pdf = tmp_path / "source.pdf"
        document.save(pdf)
    box = [0, 0, 1000, 1000]
    blocks = [
        {"type": "text", "text": "beneﬁ ts", "page_idx": page, "bbox": box}
        for page in (0, 0, 1, 0)
    ]
    reads: list[int] = []
    get_text = pymupdf.Page.get_text

    def counted(page, option="text", **kwargs):
        if option == "rawdict":
            reads.append(page.number)
        return get_text(page, option, **kwargs)

    monkeypatch.setattr(pymupdf.Page, "get_text", counted)
    revised, dropped = source_text.join_split_ligatures(blocks, pdf)
    assert reads == [0, 1, 0]
    assert dropped == 4 and {b["text"] for b in revised} == {"beneﬁts"}
    assert revised == [source_text.join_split_ligatures([b], pdf)[0][0] for b in blocks]


def test_wide_to_unicode_ranges_split_at_byte_blocks() -> None:
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text((50, 50), "x", fontname="helv")
        cmap = document.get_new_xref()
        document.update_object(cmap, "<<>>")
        document.update_stream(
            cmap,
            b"2 beginbfrange\n<0000> <FFFF> <0000>\n"
            b"<0100> <0101> [<65E5> <5927>]\nendbfrange\n",
        )
        document.xref_set_key(page.get_fonts()[0][0], "ToUnicode", f"{cmap} 0 R")
        assert fonts.split_wide_ranges(document) == 1
        text = document.xref_stream(cmap).decode("latin-1")
        assert fonts.split_wide_ranges(document) == 0
    ranges = re.findall(r"<([0-9A-F]{4})> <([0-9A-F]{4})> <([0-9A-F]{4})>", text)
    assert len(ranges) == 256 and ranges[0] == ("0000", "00FF", "0000")
    assert ranges[-1] == ("FF00", "FFFF", "FF00")
    # An array entry is kept whole, never read as ranges of its elements.
    assert "<0100> <0101> [<65E5> <5927>]" in text
    assert text.count("beginbfrange") == 3


def _place_image(page: pymupdf.Page, rect: tuple, key: int) -> None:
    """A picture of three black bars (formula-like ink); ``key`` sets one pixel,
    so equal keys are the same image."""
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 12), False)
    pixmap.set_rect(pixmap.irect, (255, 255, 255))
    for y in (3, 6, 9):
        pixmap.set_rect(pymupdf.IRect(0, y, 40, y + 1), (0, 0, 0))
    pixmap.set_pixel(0, 0, (key, key, key))
    page.insert_image(rect, pixmap=pixmap, keep_proportion=False)


def test_picture_triage_drops_slivers_and_discards_repeats() -> None:
    document = pymupdf.open()
    for _ in range(6):
        document.new_page(width=600, height=800)

    objects: dict[int, int] = {}

    def image(name: str, key: int, page: int, rect: tuple) -> dict:
        # Badges by the image object ODL reports, the rest by the page's images.
        _place_image(document[page], rect, key)
        block = {"type": "image", "name": name, "page_idx": page, "bbox": _grid(rect)}
        if name == "badge":
            block["_native_id"] = len(objects)
            objects[len(objects)] = document[page].get_images()[-1][0]
        return block

    # Same picture on five pages is a repeat; on four it is not.
    badges = [image("badge", 1, p, (60, 80, 180, 160)) for p in range(5)]
    icons = [image("icon", 2, p, (300, 80, 420, 160)) for p in range(4)]
    figure = image("figure", 3, 5, (60, 80, 180, 160))
    text = {
        "type": "text",
        "text": "prose",
        "page_idx": 0,
        "bbox": [100, 100, 300, 200],
    }
    blocks = [
        text,
        image("rule", 4, 0, (60, 240, 300, 240.8)),  # 0.8 pt tall
        image("bar", 5, 0, (0, 320, 600, 324)),  # 4 x 600 pt
        *badges,
        *icons,
        figure,
    ]
    # Stored bytes are read from the file, as the parse opens it.
    document = pymupdf.open("pdf", document.tobytes())
    result = pictures.classify(blocks, document, objects)
    assert result == [
        text,
        *({**badge, "type": "discarded"} for badge in badges),
        *icons,
        figure,
    ]


def test_separate_image_objects_with_the_same_stored_bytes_repeat() -> None:
    # Six one-page documents each store a badge as their own object; merged,
    # five hold identical bytes and the sixth differs in its last pixel, past
    # the first read chunk.
    noise = random.Random(0).randbytes(200 * 200 * 3)
    merged = pymupdf.open()
    for samples in [noise] * 5 + [noise[:-1] + bytes([noise[-1] ^ 1])]:
        with pymupdf.open() as one:
            badge = pymupdf.Pixmap(pymupdf.csRGB, 200, 200, samples, False)
            page = one.new_page(width=600, height=800)
            page.insert_image((60, 80, 180, 160), pixmap=badge)
            merged.insert_pdf(one)
    document = pymupdf.open("pdf", merged.tobytes())
    xrefs = [page.get_images()[0][0] for page in document]
    assert len(set(xrefs)) == 6
    assert len(document.xref_stream_raw(xrefs[0])) > pictures.HASH_CHUNK
    blocks = [
        {**_picture("badge", p, (60, 80, 180, 160)), "_native_id": p} for p in range(6)
    ]
    result = pictures.classify(blocks, document, dict(enumerate(xrefs)))
    assert [block["type"] for block in result] == ["discarded"] * 5 + ["image"]


def test_a_stored_image_hashes_its_palette_by_content_not_object_number() -> None:
    # The same index bytes in each image; palettes are separate objects.
    document = pymupdf.open()
    document.new_page()
    images = []
    for colour in (b"\xff\x00\x00", b"\xff\x00\x00", b"\x00\x00\xff"):
        palette = document.get_new_xref()
        document.update_object(palette, "<<>>")
        document.update_stream(palette, colour)
        image = document.get_new_xref()
        document.update_object(
            image,
            "<</Type/XObject/Subtype/Image/Width 4/Height 4/BitsPerComponent 8"
            f"/ColorSpace[/Indexed/DeviceRGB 0 {palette} 0 R]>>",
        )
        document.update_stream(image, bytes(16))
        images.append(image)
    document = pymupdf.open("pdf", document.tobytes())
    memo: dict[int, bytes | None] = {}
    red, copy, blue = (pictures._stored_hash(document, x, memo) for x in images)
    assert red == copy != blue


def _handwritten_pdf(objects: list[bytes]) -> bytes:
    """A PDF written by hand (object n is ``objects[n - 1]``, 1 the catalog),
    for what MuPDF would rewrite on saving."""
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    start = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        start,
    )
    return bytes(out)


def _badges(document: pymupdf.Document, xrefs: list[int]) -> list[dict]:
    """Each image object a picture on its own page, as ODL reports it."""
    blocks = [
        {**_picture("badge", p, (60, 80, 180, 160)), "_native_id": p}
        for p in range(len(xrefs))
    ]
    return pictures.classify(blocks, document, dict(enumerate(xrefs)))


def test_copies_whose_length_is_written_differently_are_one_repeat() -> None:
    # Five pages, then five copies of one image: /Length direct, indirect
    # (objects 13 and 14), too long and too short. MuPDF reads to endstream.
    def image(length: bytes) -> bytes:
        return (
            b"<</Type/XObject/Subtype/Image/Width 4/Height 4/BitsPerComponent 8"
            b"/ColorSpace/DeviceGray/Length %s>>\nstream\n%s\nendstream"
            % (length, bytes(range(16)))
        )

    pages = [b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 800]>>"] * 5
    lengths = [b"16", b"13 0 R", b"14 0 R", b"99999", b"5"]
    document = pymupdf.open(
        "pdf",
        _handwritten_pdf(
            [
                b"<</Type/Catalog/Pages 2 0 R>>",
                b"<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R 6 0 R 7 0 R]/Count 5>>",
                *pages,
                *map(image, lengths),
                b"16",
                b"16",
            ]
        ),
    )
    result = _badges(document, [8, 9, 10, 11, 12])
    assert [block["type"] for block in result] == ["discarded"] * 5


def test_a_reference_chain_past_the_depth_is_no_identity_and_read_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Five copies of one image, each referencing one chain deeper than
    # STORED_DEPTH: no copy has an identity, and the chain is read once.
    document = pymupdf.open()
    for _ in range(5):
        document.new_page(width=600, height=800)
    chain = [document.get_new_xref() for _ in range(pictures.STORED_DEPTH + 2)]
    for link, after in itertools.pairwise(chain):
        document.update_object(link, f"[{after} 0 R]")
    document.update_object(chain[-1], "[]")
    images = []
    for _ in range(5):
        image = document.get_new_xref()
        document.update_object(
            image,
            "<</Type/XObject/Subtype/Image/Width 4/Height 4/BitsPerComponent 8"
            f"/ColorSpace/DeviceGray/Chain {chain[0]} 0 R>>",
        )
        document.update_stream(image, bytes(16))
        images.append(image)
    document = pymupdf.open("pdf", document.tobytes())
    reads: Counter = Counter()
    read = pymupdf.Document.xref_object
    monkeypatch.setattr(
        pymupdf.Document,
        "xref_object",
        lambda self, xref, *args, **kwargs: (
            reads.update([xref]) or read(self, xref, *args, **kwargs)
        ),
    )
    assert [block["type"] for block in _badges(document, images)] == ["image"] * 5
    assert reads[chain[0]] == 1


def test_a_reference_cycle_hashes_and_ends() -> None:
    document = pymupdf.open()
    document.new_page()
    first, second, image = (document.get_new_xref() for _ in range(3))
    document.update_object(first, f"[{second} 0 R]")
    document.update_object(second, f"[{first} 0 R]")
    document.update_object(
        image,
        "<</Type/XObject/Subtype/Image/Width 4/Height 4/BitsPerComponent 8"
        f"/ColorSpace/DeviceGray/Cycle {first} 0 R>>",
    )
    document.update_stream(image, bytes(16))
    document = pymupdf.open("pdf", document.tobytes())
    assert len(pictures._stored_hash(document, image, {})) == 32


@pytest.mark.parametrize(
    ("error", "fails_the_parse"),
    [
        (OSError("read failed"), False),
        (MemoryError(), True),
        (OSError(errno.ENOMEM, "Cannot allocate memory"), True),
        (RuntimeError("code=2: malloc (400000000 bytes) failed"), True),
    ],
    ids=["broken", "python", "enomem", "mupdf"],
)
def test_a_failed_hash_is_no_identity_but_running_out_of_memory_still_raises(
    monkeypatch: pytest.MonkeyPatch, error: BaseException, fails_the_parse: bool
) -> None:
    """Running out of memory (as the parse's ParseOOM path reads it) goes on;
    any other error is no identity."""
    document = pymupdf.open()
    for _ in range(5):
        document.new_page(width=600, height=800)

    def fail(*args: object) -> bytes:
        raise error

    monkeypatch.setattr(pictures, "_stored_hash", fail)
    if fails_the_parse:
        with pytest.raises(type(error)):
            _badges(document, [7] * 5)
    else:
        assert [block["type"] for block in _badges(document, [7] * 5)] == (
            ["image"] * 5
        )


def test_vector_figures_become_image_blocks_and_ruled_grids_do_not() -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    # A chart: axes and a 20-segment curve, labelled inside and below.
    page.draw_line((100, 100), (100, 300))
    page.draw_line((100, 300), (400, 300))
    points = [(100 + 15 * i, 300 - 180 * (i % 5) / 4) for i in range(21)]
    page.draw_polyline(points)
    page.insert_text((200, 150), "Peak")
    page.insert_text((230, 320), "Time (t)")
    # A ruled 6 x 2 grid of text: a table ODL did not recognise.
    for row in range(7):
        page.draw_line((100, 450 + 40 * row), (400, 450 + 40 * row))
    for x in (100, 250, 400):
        page.draw_line((x, 450), (x, 690))
    cells = []
    for row in range(6):
        for col in range(2):
            x, y = 110 + 150 * col, 470 + 40 * row
            page.insert_text((x, y), f"cell {row}{col}")
            cells.append(
                {
                    "type": "text",
                    "text": f"cell {row}{col}",
                    "page_idx": 0,
                    "bbox": _grid((x, y - 10, x + 60, y + 2)),
                }
            )
    intro = {
        "type": "text",
        "text": "The chart below.",
        "page_idx": 0,
        "bbox": _grid((100, 60, 400, 80)),
    }
    peak = {
        "type": "title",
        "text": "Peak",
        "text_level": 2,
        "page_idx": 0,
        "bbox": _grid((200, 140, 230, 152)),
    }
    axis = {
        "type": "text",
        "text": "Time (t)",
        "page_idx": 0,
        "bbox": _grid((230, 310, 280, 322)),
    }
    # A formula beside the chart is not one of its labels.
    gain = {
        "type": "text",
        "text": "Gain = 4.3",
        "page_idx": 0,
        "bbox": _grid((300, 330, 360, 342)),
    }
    blocks = [intro, peak, axis, gain, *cells]
    result = pictures.add_vector_figures(blocks, document)
    figure = result[1]
    assert result[0] == intro and figure["type"] == "image"
    assert figure["_source_role"] == "vector-figure"
    x0, y0, x1, y1 = figure["bbox"]
    assert (
        x0 < 100 / 0.6 + 1
        and y0 < 100 / 0.8 + 1
        and x1 > 400 / 0.6 - 1
        and y1 > 322 / 0.8 - 1
    )
    # Its labels are its own text, not body text or headings; the formula
    # stays in the body and the grid is untouched.
    assert figure["figure_labels"] == ["Peak", "Time (t)"]
    assert result[2:] == [gain, *cells]


def _pairwise_clusters(page: pymupdf.Page) -> list[tuple[pymupdf.Rect, int, int]]:
    """Vector-figure grouping as it ran before the grid: every path against
    every cluster, then a merge pass restarted after each merge."""
    width, height = page.rect.width, page.rect.height
    clusters: list[list] = []
    for path in page.get_cdrawings():
        x0, y0, x1, y1 = path["rect"]
        w, h = x1 - x0, y1 - y0
        if (w < 0.5 and h < 0.5) or (w >= 0.9 * width and h >= 0.9 * height):
            continue
        if (h <= 1.5 and w >= 0.3 * width) or (w <= 1.5 and h >= 0.3 * height):
            continue
        if path.get("fill") == (1.0, 1.0, 1.0) and not path.get("color"):
            continue
        rect = pymupdf.Rect(x0, y0, max(x1, x0 + 0.5), max(y1, y0 + 0.5))
        grown = rect + (-8, -8, 8, 8)
        hits = [c for c in clusters if c[0].intersects(grown)]
        items = path.get("items") or ()
        merged = [rect, len(items) or 1, sum(map(pictures._axis_aligned, items))]
        for cluster in hits:
            merged[0] |= cluster[0]
            merged[1] += cluster[1]
            merged[2] += cluster[2]
            clusters.remove(cluster)
        clusters.append(merged)
    changed = True
    while changed:
        changed = False
        for a in clusters:
            for b in clusters:
                if a is not b and a[0].intersects(b[0]):
                    a[0] |= b[0]
                    a[1] += b[1]
                    a[2] += b[2]
                    clusters.remove(b)
                    changed = True
                    break
            if changed:
                break
    return [tuple(cluster) for cluster in clusters]


def _strokes(page: pymupdf.Page, lines: list[tuple]) -> None:
    """Each line its own drawing path."""
    shape = page.new_shape()
    for start, end in lines:
        shape.draw_line(start, end)
        shape.finish(closePath=False)
    shape.commit()


def _merging_late(dots: int, groups: int) -> pymupdf.Document:
    """A page of separate dots, then groups whose merged box covers a stroke
    the path-by-path pass left alone, so the last pass must merge them."""
    side = int(dots**0.5) + 1
    document = pymupdf.open()
    page = document.new_page(width=2700, height=side * 12 + 140 * (groups // 20 + 2))
    _strokes(
        page,
        [
            ((x, y), (x + 1, y + 1))
            for x, y in (
                (10 + 12 * (i % side), 10 + 12 * (i // side)) for i in range(dots)
            )
        ],
    )
    for k in range(groups):
        ox, oy = 10 + 130 * (k % 20), side * 12 + 30 + 130 * (k // 20)
        # Two tall strokes, one between them, then one joining their tops.
        _strokes(
            page,
            [
                ((ox + a, oy + b), (ox + c, oy + d))
                for a, b, c, d in (
                    (0, 0, 2, 100),
                    (100, 0, 102, 100),
                    (50, 50, 51, 51),
                    (2, 0, 100, 2),
                )
            ],
        )
    return document


def _chart_page(document: pymupdf.Document, segments: int = 20) -> pymupdf.Page:
    page = document.new_page(width=600, height=800)
    page.draw_line((100, 100), (100, 300))
    page.draw_line((100, 300), (400, 300))
    step = 300 / segments
    _strokes(
        page,
        [
            (
                (100 + step * i, 300 - 90 * (i % 5) / 4),
                (100 + step * (i + 1), 300 - 90 * ((i + 1) % 5) / 4),
            )
            for i in range(segments)
        ],
    )
    return page


def _clusters(found: list[tuple]) -> list[tuple]:
    return [(tuple(rect), segments, aligned) for rect, segments, aligned in found]


def test_grid_clusters_equal_the_pairwise_grouping() -> None:
    document = pymupdf.open()
    _chart_page(document)
    # Frames holding marks, an L whose box takes in a mark the path-by-path
    # pass reaches only through the box, and separate marks in reading order.
    page = document.new_page(width=600, height=800)
    page.draw_rect((50, 50, 250, 150))
    page.draw_rect((70, 70, 90, 90), fill=(0, 0, 0))
    _strokes(
        page,
        [((300, 50), (302, 250)), ((302, 250), (500, 252)), ((480, 60), (481, 61))],
    )
    _strokes(page, [((60 + 30 * i, 600), (70 + 30 * i, 610)) for i in range(12)])
    page.draw_rect((0, 0, 600, 800), color=None, fill=(1, 1, 1))  # white fill
    _strokes(page, [((20, 700), (580, 700.5))])  # a page-wide rule
    # Strokes off the page, separate and merging, each in its own cells.
    page = document.new_page(width=600, height=800)
    _strokes(
        page,
        [
            ((-20 * i, 40 * j), (2 - 20 * i, 2 + 40 * j))
            for i in range(1, 9)
            for j in range(8)
        ],
    )
    _strokes(
        page,
        [
            ((-300, 500), (-298, 600)),
            ((-200, 500), (-198, 600)),
            ((-250, 550), (-249, 551)),
            ((-298, 500), (-200, 502)),
        ],
    )
    late = _merging_late(60, 12)
    for page in [*document, *late]:
        assert _clusters(pictures._figure_clusters(page, pictures.Drawings())) == (
            _clusters(_pairwise_clusters(page))
        )


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ((9e6, 0, 9e6 + 0.5, 1), (0, 0, 10, 10)),
        ((0, 0, 10, 10), (9e6, 0, 9e6 + 0.5, 1)),
        ((1, 1, 1.5, 2), (3, 3, 4, 4)),
    ],
)
def test_cluster_boxes_merge_as_pymupdf_merges_them(a: tuple, b: tuple) -> None:
    # A box that rounds to zero width as C floats is still a box to MuPDF.
    assert pictures._union(a, b) == tuple(pymupdf.Rect(a) | b)


def test_clusters_that_keep_merging_take_steps_linear_in_the_paths() -> None:
    page = _merging_late(400, 40)[0]
    drawings = pictures.Drawings()
    found = pictures._figure_clusters(page, drawings)
    spent = pictures.VECTOR_MAX_STEPS - drawings.left
    # 560 paths; the pairwise grouping compares millions of boxes here.
    assert spent < 50 * 560
    assert len(found) == 400 + 40 and sum(s for _, s, _ in found) == 560


def test_drawings_off_the_page_take_steps_linear_in_the_paths() -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    # 4,000 separate 2 pt strokes, 20 pt apart, left of the page.
    _strokes(
        page,
        [
            ((-20 - 20 * i, 20 * j), (-18 - 20 * i, 2 + 20 * j))
            for i in range(80)
            for j in range(50)
        ],
    )
    drawings = pictures.Drawings()
    found = pictures._figure_clusters(page, drawings)
    assert len(found) == 4000 and drawings.spent < 50 * 4000


def test_drawings_with_nan_or_infinite_boxes_are_left_out() -> None:
    # Content under a huge matrix gives NaN or infinite path boxes; beside
    # ordinary strokes they are left out in few steps, as the pairwise test
    # never let them meet anything, and the rest group as before.
    nan, inf = math.nan, math.inf
    paths = [{"rect": (100 + 4 * i, 100, 102 + 4 * i, 102)} for i in range(30)]
    paths += [{"rect": (300, 300, 330, 340)}, {"rect": (305, 310, 320, 330)}]
    odd = [
        (nan, nan, nan, nan),
        (inf, nan, inf, nan),
        (110, nan, 150, 101),
        (inf, 100, inf, 110),
        (-inf, 300, -inf, 320),
    ]
    for k, rect in enumerate(odd):
        paths.insert(6 * k + 3, {"rect": rect})
    page = SimpleNamespace(
        rect=pymupdf.Rect(0, 0, 600, 800), get_cdrawings=lambda: paths
    )
    drawings = pictures.Drawings()
    found = _clusters(pictures._figure_clusters(page, drawings))
    expected = _clusters(_pairwise_clusters(page))
    assert found == [c for c in expected if all(map(math.isfinite, c[0]))]
    assert drawings.spent < 50 * len(paths)


def test_drawing_steps_are_a_backstop_for_the_whole_document() -> None:
    """Past the document's steps, that page and every later one have no
    clusters, for vector figures and heading recall alike; text is kept."""
    document = _merging_late(100, 4)
    _chart_page(document)
    blocks = [
        {
            "type": "text",
            "text": "Intro.",
            "page_idx": 1,
            "bbox": _grid((100, 60, 400, 80)),
        }
    ]
    assert len(pictures.add_vector_figures(blocks, document)) == 2

    drawings = pictures.Drawings(steps=200)
    assert pictures.add_vector_figures(blocks, document, drawings) == blocks
    # Where the steps ran out and how many were taken, for the parse's log line.
    assert drawings.stopped_at == 0 and drawings.spent > 200
    assert drawings.clusters(document[0]) == drawings.clusters(document[1]) == []


@pytest.mark.parametrize(
    ("inside", "figure"),
    [
        ("Source: Federal statistics office.", True),  # a chart's note
        ("Which changes did your school make to the curriculum?", False),  # callout
        ("view := ROView new. view addAll: edges; open", False),  # a code frame
        (
            "Net interest income: Euro $ 324 $ 247 Total income $ 328 $ 246",
            False,
        ),  # rows
        ("2016 2017 2018 2019 2020 2021 2022 2023 2024 2025 2026 2027", True),  # ticks
    ],
)
def test_vector_clusters_holding_prose_code_or_table_rows_stay_text(
    inside, figure
) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.draw_line((100, 100), (100, 300))
    page.draw_line((100, 300), (400, 300))
    page.draw_polyline([(100 + 15 * i, 300 - 36 * (i % 5)) for i in range(21)])
    page.insert_text((110, 290), inside, fontsize=8)
    block = {
        "type": "text",
        "text": inside,
        "page_idx": 0,
        "bbox": _grid((110, 282, 390, 292)),
    }
    result = pictures.add_vector_figures([block], document)
    if figure and inside.startswith("Source"):
        assert (
            result[0]["image_footnote"] == [inside] and result[0]["figure_labels"] == []
        )
    elif figure:
        assert result[0]["figure_labels"] == [inside]
    else:
        assert result == [block]


# Formula pictures: 10 pt Helvetica lines are 13.8 pt tall on a 600 x 800 page.
def _grid(rect: tuple) -> list[float]:
    return [rect[0] / 0.6, rect[1] / 0.8, rect[2] / 0.6, rect[3] / 0.8]


def _bars(page: pymupdf.Page, rect: tuple, colour=(0, 0, 0)) -> None:
    """Formula-like ink: three 1 pt bars across the picture."""
    x0, y0, x1, y1 = rect
    for i in (1, 2, 3):
        y = y0 + i * (y1 - y0) / 4
        page.draw_rect((x0, y - 0.5, x1, y + 0.5), color=None, fill=colour)


def _picture(name: str, page: int, rect: tuple) -> dict:
    return {"type": "image", "name": name, "page_idx": page, "bbox": _grid(rect)}


INLINE = (130, 90, 168, 102)  # between "be" (ends x 124.5) and "per" on y 89-103


@pytest.mark.parametrize(
    "case", ["formula", "caption", "colour", "blank", "small", "text", "mid-tone"]
)
def test_formula_pictures_pass_the_six_precision_tests(
    tmp_path: Path, case: str
) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((60, 100), "Let the rate be", fontsize=10)
    page.insert_text((175, 100), "per hour today.", fontsize=10)
    rect = (130, 96, 168, 98.5) if case == "small" else INLINE
    if case == "caption":
        page.insert_text((60, 114), "Figure 3 The rate", fontsize=10)
    if case == "mid-tone":
        page.draw_rect(rect, color=None, fill=(0.7, 0.7, 0.7))
    if case == "text":
        page.insert_text((140, 100), "dx", fontsize=10)
    if case == "small":
        page.draw_rect((130, 97, 168, 98), color=None, fill=(0, 0, 0))
    elif case != "blank":
        _bars(page, rect, (1, 0, 0) if case == "colour" else (0, 0, 0))
    block = _picture("p.png", 0, rect)
    [result] = pictures.classify([block], document, {})
    if case == "formula":
        assert result == {**block, "type": "equation", "text": "", "_picture": "inline"}
    else:
        assert result == block


def test_formula_pictures_skip_tall_lines_and_tall_pictures(tmp_path: Path) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    for y in (600, 614, 628, 642):
        page.insert_text((60, y), "Body text sets the line height.", fontsize=10)
    # MuPDF merges a diagram's labels into one tall "line" (MIT Strang).
    page.insert_text((60, 300), "Label", fontsize=30)
    beside_tall_line = (140, 276, 200, 300)
    # Three body lines tall, between two body lines.
    page.insert_text((60, 400), "Text above the picture here.", fontsize=10)
    page.insert_text((60, 460), "Text below the picture here.", fontsize=10)
    tall = (80, 408, 180, 448)
    for rect in (beside_tall_line, tall):
        _bars(page, rect)
    blocks = [
        _picture("a.png", 0, beside_tall_line),
        _picture("b.png", 0, tall),
    ]
    assert pictures.classify(blocks, document, {}) == blocks


def test_formula_pictures_are_placed_in_text_or_as_their_own_block(
    tmp_path: Path,
) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((60, 100), "Let the rate be", fontsize=10)
    page.insert_text((175, 100), "per hour today.", fontsize=10)
    page.insert_text((60, 200), "Text above the display formula", fontsize=10)
    page.insert_text((60, 250), "Text below the display formula", fontsize=10)
    page.insert_text((60, 400), "So we be", fontsize=10)
    page.insert_text((110, 400), "per plan, we be per hour.", fontsize=10)
    page.insert_text((60, 500), "Cell value", fontsize=10)  # no paragraph block
    inline, display = INLINE, (100, 210, 200, 232)
    repeated_pair, no_host = (100, 390, 108, 402), (110, 490, 130, 502)
    for rect in (inline, display, repeated_pair, no_host):
        _bars(page, rect)
    placed = {"type": "text", "text": "Let the rate be per hour today."}
    ambiguous = {"type": "text", "text": "So we be per plan, we be per hour."}
    blocks = [
        {**placed, "page_idx": 0, "bbox": _grid((60, 89, 243, 103))},
        _picture("inline.png", 0, inline),
        _picture("display.png", 0, display),
        _picture("cell.png", 0, no_host),
        _picture("pair.png", 0, repeated_pair),
        {**ambiguous, "page_idx": 0, "bbox": _grid((60, 389, 240, 403))},
    ]
    result = pictures.classify(blocks, document, {})
    result = pictures.place_inline(result, document)
    # The unplaced pair carries its own placeholder after its paragraph; the
    # hostless one keeps its place in reading order.
    assert [(b["type"], b["text"], b.get("name")) for b in result] == [
        ("text", "Let the rate be [formula] per hour today.", None),
        ("equation", "", "inline.png"),
        ("equation", "[formula]", "display.png"),
        ("equation", "[formula]", "cell.png"),
        ("text", ambiguous["text"], None),
        ("equation", "[formula]", "pair.png"),
    ]


def test_formula_pictures_in_list_items_match_whole_words(tmp_path: Path) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((60, 100), "Set x to", fontsize=10)
    page.insert_text((123, 100), "zero now.", fontsize=10)
    page.insert_text((60, 114), "and the", fontsize=10)
    page.insert_text((123, 114), "is known.", fontsize=10)
    first, second = (98, 90, 118, 102), (98, 104, 118, 116)
    for rect in (first, second):
        _bars(page, rect)
    # "the is" occurs only inside "atheist": the second picture is not spliced
    # mid-word but carries its own placeholder after the list. Spacing away
    # from the splice is kept.
    items = ["Set x to zero now.  Next.", "An atheist view."]
    listed = {"type": "list", "list_items": items, "page_idx": 0}
    blocks = [
        _picture("first.png", 0, first),
        _picture("second.png", 0, second),
        {**listed, "bbox": _grid((60, 89, 170, 117))},
    ]
    result = pictures.classify(blocks, document, {})
    result = pictures.place_inline(result, document)
    assert [(b["type"], b.get("text"), b.get("name")) for b in result] == [
        ("equation", "", "first.png"),
        ("list", None, None),
        ("equation", "[formula]", "second.png"),
    ]
    assert result[1]["list_items"] == ["Set x to [formula] zero now.  Next.", items[1]]


def test_formula_pictures_skip_rotated_pages(tmp_path: Path) -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((60, 100), "Let the rate be", fontsize=10)
    page.insert_text((175, 100), "per hour today.", fontsize=10)
    page.set_rotation(90)
    # Ink where a clip of INLINE renders on the rotated page.
    _bars(page, tuple(pymupdf.Rect(INLINE) * page.derotation_matrix))
    # PyMuPDF's text stays unrotated while page.rect turns 800 x 600; a box that
    # lands on the line and on ink in that mixed frame must not become a formula.
    x0, y0, x1, y1 = INLINE
    block = {
        **_picture("p.png", 0, INLINE),
        "bbox": [x0 / 0.8, y0 / 0.6, x1 / 0.8, y1 / 0.6],
    }
    assert pictures.classify([block], document, {}) == [block]


def test_repeated_pictures_stay_formulas_only_when_glyph_sized_among_new_words() -> (
    None
):
    document = pymupdf.open()
    glyph, badge, tall = (105, 91, 125, 101), (260, 91, 290, 101), (385, 86, 405, 106)
    blocks, objects = [], {}
    for p in range(5):
        page = document.new_page(width=600, height=800)
        page.insert_text((60, 100), f"alpha{p} is", fontsize=10)
        page.insert_text((130, 100), f"beta{p} and", fontsize=10)
        page.insert_text((190, 100), "licensed under", fontsize=10)
        page.insert_text((295, 100), "CC BY", fontsize=10)
        page.insert_text((340, 100), f"gamma{p}", fontsize=10)
        page.insert_text((410, 100), f"delta{p}", fontsize=10)
        for key, (name, rect) in enumerate(
            (("glyph", glyph), ("badge", badge), ("tall", tall))
        ):
            _place_image(page, rect, key)
            # ODL reports the image object each picture draws: one per key.
            objects[len(objects)] = page.get_images()[-1][0]
            blocks.append({**_picture(name, p, rect), "_native_id": len(objects) - 1})
    document = pymupdf.open("pdf", document.tobytes())
    result = pictures.classify(blocks, document, objects)
    assert [(b["type"], b["name"]) for b in result] == [
        (kind, name)
        for _ in range(5)
        for kind, name in (
            ("equation", "glyph"),
            ("discarded", "badge"),
            ("discarded", "tall"),
        )
    ]


def test_pages_without_a_text_layer_are_listed_for_the_vlm() -> None:
    with pymupdf.open() as document:
        document.new_page().insert_text(
            (50, 50), "a page with enough native characters to keep"
        )
        document.new_page()
        assert textless.textless_pages(document) == [1]


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


def test_page_text_extracts_each_page_once_and_rebuilds_mupdf_dicts(
    tmp_path, monkeypatch
):
    path = tmp_path / "two.pdf"
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((72, 72), "one two", fontname="helv")
    page.insert_text((140, 72), "three", fontname="tiro", fontsize=9)
    page.insert_text((72, 300), "turned", rotate=90)
    document.new_page().insert_text(
        (72, 72), "four five six seven eight nine ten eleven twelve thirteen"
    )
    document.save(path)
    original = pymupdf.Page.get_text
    reads = []

    def counted(self, *args, **kwargs):
        reads.append(self.number)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(pymupdf.Page, "get_text", counted)
    with pymupdf.open(path) as document, page_text.session(path):
        for page in document:
            for _ in range(2):  # key for key, float for float, every time
                assert repr(page_text.page_dict(page)) == repr(
                    original(page, "dict", flags=page_text.TEXT_FLAGS)
                )
                assert repr(page_text.page_raw(page)) == repr(
                    original(page, "rawdict", flags=page_text.TEXT_FLAGS)
                )
        assert reads == [0, 1]
        # Plain text holds every kept character: page 1's 48 need no read.
        assert textless.textless_pages(document) == [0]
        assert reads == [0, 1, 0]
    assert page_text._session is None  # nothing outlives the parse
    with pymupdf.open(path) as document:  # outside a session, MuPDF reads it
        page_text.page_dict(document[0])
    assert reads == [0, 1, 0, 0]


def test_page_text_reads_pages_past_the_budget_from_mupdf(tmp_path, monkeypatch):
    path = tmp_path / "two.pdf"
    document = pymupdf.open()
    for text in ("first page", "second page"):
        document.new_page().insert_text((72, 72), text)
    document.save(path)
    original = pymupdf.Page.get_text
    reads = []

    def counted(self, *args, **kwargs):
        reads.append(self.number)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(pymupdf.Page, "get_text", counted)
    monkeypatch.setattr(page_text, "CHAR_BUDGET", 1)
    with pymupdf.open(path) as document, page_text.session(path):
        for page in document:
            for _ in range(2):
                assert repr(page_text.page_dict(page)) == repr(
                    original(page, "dict", flags=page_text.TEXT_FLAGS)
                )
    # The first page spends the budget; the second is read on each call.
    assert reads == [0, 1, 1]


def _joined_page(lines: list[tuple[str, float]], fontname: str = "helv"):
    """A page with (text, x) lines from y = 100 and one block over them all."""
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    for row, (text, x) in enumerate(lines):
        page.insert_text((x, 100 + 14 * row), text, fontsize=10, fontname=fontname)
    return document, [100.0, 100.0, 1000.0, (110 + 14 * len(lines)) / 0.8]


def test_wrapped_cjk_lines_join_without_the_space_odl_adds() -> None:
    # The first line wraps at the block's right edge; the third ends short.
    document, box = _joined_page(
        [
            ("地域住民にとって地域住民にとって", 60),
            ("身近な学習拠点で", 60),
            ("主席：", 60),
        ],
        fontname="japan",
    )
    block = {"type": "text", "page_idx": 0, "bbox": box}
    text = "地域住民にとって地域住民にとって 身近な学習拠点で 主席："
    with document:
        [result] = joins.repair_joins([{**block, "text": text}], document)
    assert result["text"] == "地域住民にとって地域住民にとって身近な学習拠点で 主席："


@pytest.mark.parametrize(
    ("second", "elsewhere", "expected"),
    [
        ("1950s jazz", "", "mid-1950s jazz"),  # a digit follows
        ("term use", "", "longterm use"),  # a syllable break by default
        ("term use", "long-term care", "long-term use"),  # the document hyphenates
        ("Named:do: x", "", "forceNewFileNamed:do: x"),  # camel case is code
    ],
)
def test_line_end_hyphens_odl_dropped_return_on_evidence(
    second: str, elsewhere: str, expected: str
) -> None:
    head = {"1950s": "mid", "term u": "long", "Named": "forceNewFile"}
    first = next(v for k, v in head.items() if second.startswith(k))
    document, box = _joined_page([(f"Body text {first}-", 60), (second, 60)])
    joined = f"Body text {first}{second}"
    blocks = [{"type": "text", "page_idx": 0, "bbox": box, "text": joined}]
    if elsewhere:
        blocks.append(
            {"type": "text", "page_idx": 0, "bbox": [0, 0, 1, 1], "text": elsewhere}
        )
    with document:
        result = joins.repair_joins(blocks, document)
    assert result[0]["text"] == f"Body text {expected}"


def test_figure_captions_beside_a_picture_move_into_it() -> None:
    def text(t: str, y0: float) -> dict:
        return {
            "type": "text",
            "text": t,
            "page_idx": 0,
            "bbox": [100, y0, 900, y0 + 20],
        }

    figure = {"type": "image", "page_idx": 0, "bbox": [100, 100, 900, 400]}
    blocks = [
        text("Body before.", 60),
        figure,
        text("Figure 7.10: Branching (left) and merging (right).", 410),
        {**figure, "bbox": [100, 500, 900, 700]},
        text("Figure 2.18 illustrates active transport.", 710),  # a sentence
        {**figure, "bbox": [100, 750, 900, 850]},
        text("Fig. 3 Far below it.", 950),  # too far
    ]
    result = pictures.attach_captions(blocks)
    assert [b.get("image_caption") for b in result if b["type"] == "image"] == [
        ["Figure 7.10: Branching (left) and merging (right)."],
        None,
        None,
    ]
    assert [b["text"] for b in result if b["type"] == "text"] == [
        "Body before.",
        "Figure 2.18 illustrates active transport.",
        "Fig. 3 Far below it.",
    ]


# Formula structure (scripts.py): synthetic lines as (text, role) pieces, role
# "" base text, "^" raised, "_" lowered, "^_" stacked; the words that change.
SCRIPT_CASES = [
    ([("called a derivative in calculus", ""), ("3", "^"), (".", "")], []),
    ([("oxidation of diatomic hydrogen.", ""), ("13", "^"), (" Since", "")], []),
    ([("risk of cancer", ""), ("1,2", "^"), (" in adults", "")], []),
    ([("patients", ""), ("12–14", "^"), (" were excluded", "")], []),
    ([("(see Smith)", ""), ("4", "^"), (" for details", "")], []),
    ([("the 1", ""), ("st", "^"), (" and 2", ""), ("nd", "^"), (" rows", "")], []),
    ([("Total", ""), ("a", "^"), (" 1,200", "")], []),
    ([("in 2019", ""), ("7", "^"), (" the rate fell", "")], []),
    ([("Brand", ""), ("TM", "^"), (" products", "")], []),
    ([("see [MJS", ""), ("+", "^"), ("00] for", "")], []),
    ([("an area of 12 m", ""), ("2", "^"), (" of land", "")], ["m^2"]),
    ([("Volume = 10,597.5 ft", ""), ("3", "^")], ["ft^3"]),
    ([("= 0.785 × (3 ft)", ""), ("2", "^")], ["ft)^2"]),
    ([("so that x", ""), ("2", "^"), (" + y = 4", "")], ["x^2"]),
    ([("the value e", ""), ("−x", "^"), (" decays", "")], ["e^{−x}"]),
    ([("strain of 1.0 × 10", ""), ("−21", "^")], ["10^{−21}"]),
    ([("the redshift z = 0.09", ""), ("+0.03|−0.04", "^_")], ["0.09^{+0.03}_{−0.04}"]),
    ([("dissolved Ca", ""), ("2+", "^"), (" ions", "")], ["Ca^{2+}"]),
    ([("water is H", ""), ("2", "_"), ("O and", "")], ["H_2O"]),
    ([("the term x", ""), ("i", "_"), (" here", "")], ["x_i"]),
    ([("ammonium NH", ""), ("4", "_"), ("+", "^"), (" ions", "")], ["NH_4^+"]),
]


def _script_line(pieces) -> list:
    """Glyphs for one synthetic line: 10 pt text on baseline 100, 7 pt
    scripts raised 3.5 pt or lowered 2 pt, 5 pt advances."""
    line, x, spaced = [], 72.0, False

    def glyph(c, size, base):
        nonlocal x, spaced
        w = 0.5 * size
        g = scripts.Glyph(
            c, x, base - 0.8 * size, x + w, base + 0.2 * size, size, base, spaced=spaced
        )
        x += w
        spaced = False
        return g

    for text, role in pieces:
        if role == "^_":
            up, down = text.split("|")
            start = x
            line += [glyph(c, 7, 96.5) for c in up]
            x = start
            line += [glyph(c, 7, 102) for c in down]
            continue
        for c in text:
            if c == " ":
                x += 3
                spaced = True
                continue
            line.append(
                glyph(c, 7 if role else 10, {"": 100, "^": 96.5, "_": 102}[role])
            )
    return line


@pytest.mark.parametrize(("pieces", "expected"), SCRIPT_CASES)
def test_scripts_rebuild_units_and_variables_but_not_footnote_markers(
    pieces, expected
) -> None:
    words = scripts._linear([], _script_line(pieces), math=None)
    changed = [
        scripts._render_word(w) for w in words if any(a.sups or a.subs for a in w)
    ]
    assert changed == expected


def test_a_raised_unit_exponent_is_restored_in_the_block_text() -> None:
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    page.insert_text((60, 100), "The tank holds 10,597.5 ft", fontsize=10)
    x = 60 + pymupdf.get_text_length("The tank holds 10,597.5 ft", fontsize=10)
    page.insert_text((x, 96.5), "3", fontsize=7)
    page.insert_text((x + 4, 100), " of water.", fontsize=10)
    block = {
        "type": "text",
        "text": "The tank holds 10,597.5 ft3 of water.",
        "page_idx": 0,
        "bbox": [90, 110, 600, 135],
    }
    with document:
        [result] = scripts.restore_structure([block], document)
    assert result["text"] == "The tank holds 10,597.5 ft^3 of water."


def test_center_inside_answers_as_pymupdfs_own_test() -> None:
    # MuPDF compares single-precision floats with the right and bottom edges
    # open, and its binding refuses finite coordinates past the float range.
    def binding(box, area):
        centre = pymupdf.Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        try:
            return bool(area.contains(centre))
        except (TypeError, OverflowError) as exc:
            return type(exc)

    def ours(box, area):
        try:
            return source_text.center_inside(box, area)
        except (TypeError, OverflowError) as exc:
            return type(exc)

    values = [0.0, 10.0, 9.99999999, 10.00000001, 1e39, math.inf, math.nan, -0.0]
    area = pymupdf.Rect(0, 0, 10, 10)
    for x in values:
        for y in (5.0, 0.0, 10.0):
            assert ours((x, y, x, y), area) == binding((x, y, x, y), area)
    for edge in (1e39, math.inf, 9.99999999):
        wide = pymupdf.Rect(0, 0, edge, 10)
        assert ours((5, 5, 5, 5), wide) == binding((5, 5, 5, 5), wide)


def test_the_line_grid_returns_every_box_a_query_meets(monkeypatch) -> None:
    # The index behind _lines_for_words and _needs_page: boxes across cell
    # edges, touching the query, or without cells (not finite, wider than a
    # page) come back; a box it cannot meet stays out.
    monkeypatch.setattr(scripts, "ROW_INDEX", 1)
    boxes = [
        (15.9, 15.9, 16.1, 16.1),
        (40.0, 40.0, 50.0, 50.0),
        (math.nan, 0.0, 1.0, 1.0),
        (0.0, 0.0, 2000.0, 1.0),
        (200.0, 200.0, 210.0, 210.0),
    ]
    index = scripts._box_index(boxes)
    assert scripts._beside(index, (16.0, 16.0, 40.0, 40.0), 5) == [0, 1, 2, 3]
    assert scripts._beside(index, (math.inf, 0.0, 1.0, 1.0), 5) == range(5)


def test_empty_tables_are_only_tables_without_any_cell_text_or_caption() -> None:
    empty = {
        "type": "table",
        "table_body": "<table><tr><td></td><td> </td></tr></table>",
    }
    assert pictures.empty_table(empty)
    assert not pictures.empty_table({**empty, "table_caption": ["Table 1"]})
    assert not pictures.empty_table(
        {"type": "table", "table_body": "<table><tr><td>0</td></tr></table>"}
    )


def test_font_repair_skips_font_references_past_the_xref_table(monkeypatch) -> None:
    # A Google Books scan names font objects its xref table does not hold;
    # MuPDF raises "bad xref" when such a reference is read.
    document = pymupdf.open()
    document.new_page().insert_text((72, 72), "Scanned page", fontname="helv")
    data = document.tobytes()
    real = pymupdf.Page.get_fonts

    def with_broken(self, full=False):
        return [*real(self, full=full), (10_000, "n/a", "Type1", "Ghost", "F9", "")]

    monkeypatch.setattr(pymupdf.Page, "get_fonts", with_broken)
    assert fonts.repair_fonts(data) == (data, 0)
