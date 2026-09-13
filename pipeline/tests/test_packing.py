"""The production packer reproduces the lab's ``pack_odl`` on a refined bundle,
and the pieces the parser and pipeline both carry stay identical."""

from __future__ import annotations

import gzip
import inspect
import json
import sys
from dataclasses import asdict
from pathlib import Path

import pytest

PARSER_DIR = Path(__file__).resolve().parents[2] / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))

from odl import context as parser_context
from odl import furniture as parser_furniture
from odl import table_html as parser_table_html

from pipeline.retrieval import chunking, packing
from pipeline.retrieval.headings import retain_headings

FIXTURE = Path(__file__).parent / "fixtures" / "odl-hongkong-figures"


def _gz(name: str):
    with gzip.open(FIXTURE / name, "rt", encoding="utf-8") as f:
        return json.load(f)


def test_packer_reproduces_the_lab_chunks_for_a_refined_bundle() -> None:
    """hongkong-figures: 14 recovered tables, 69 native tables, and two
    furniture texts that only recur three times *before* table replacement."""
    blocks = _gz("content_list.json.gz")
    lab = _gz("chunks.json.gz")
    furniture = frozenset(
        json.loads((FIXTURE / "refinement.json").read_text())["furniture"]
    )

    chunks = packing.pack_blocks(blocks, furniture)
    chunks = retain_headings(blocks, FIXTURE / "source.pdf", chunks)

    ours = [
        {
            **{k: v for k, v in asdict(c).items() if k in lab[0]},
            "indexed_text": c.indexed_text(),
        }
        for c in chunks
    ]
    # Keep the golden intact; two page-45 chunks carried stale overlap across
    # intervening oversized tables. Only those duplicate prefixes are removed.
    expected = [dict(c) for c in lab]
    for index, prefix_blocks in ((165, 1), (168, 2)):
        old = lab[index]
        parts = old["text"].split("\n\n", prefix_blocks)
        prefix, remainder = "\n\n".join(parts[:-1]), parts[-1]
        assert old["page_start"] == old["page_end"] == 45
        assert any(prefix in c["text"] for c in ours[:index])
        expected[index] = {
            **old,
            "text": remainder,
            "indexed_text": old["section_path"] + "\n\n" + remainder,
            "regions": old["regions"][prefix_blocks:],
        }
    # The short source heading and exclusion note now survive on their own.
    extra = [c for c in ours if c not in expected]
    assert [(c["text"], c["page_start"], c["regions"]) for c in extra] == [
        ("性別 Sex", 13, [{"page": 13, "bbox": [78.857, 162.408, 233.866, 175.041]}]),
        (
            "數字不包括被拒入境者及司機。",
            45,
            [{"page": 45, "bbox": [123.608, 420.595, 309.86, 430.002]}],
        ),
    ]
    assert len(ours) == 202 and len(lab) == 200
    assert [c for c in ours if c not in extra] == expected
    # Both departures from plain chunk_content_list are live on this source:
    # recurrence re-inferred on the replaced list loses two furniture texts and
    # changes the chunks, and native tables carry their caption as section path.
    inferred = frozenset(chunking._repeated_across_pages(blocks))
    assert len(inferred) == len(furniture) - 2
    assert packing.pack_blocks(blocks, inferred) != packing.pack_blocks(
        blocks, furniture
    )
    titles = {b["_native_table_title"] for b in blocks if b.get("_native_table_title")}
    assert titles and titles <= {c.section_path for c in chunks}


def test_native_table_chunks_repeat_headers_and_note_merged_cells() -> None:
    block = {
        "type": "table",
        "page_idx": 3,
        "bbox": [100, 100, 900, 400],
        "table_caption": ["Table 2 Yield by plot"],
        "table_body": (
            "<table><thead><tr><th>Plot</th><th>Year</th><th>Yield</th></tr></thead>"
            '<tbody><tr><td rowspan="2">North</td><td>2022</td><td>10</td></tr>'
            "<tr><td>2023</td><td>12</td></tr></tbody></table>"
        ),
    }
    (prepared,) = packing.contextualize([block])
    assert prepared["_native_table_supported"] is True
    assert prepared["_table_spans"] == [
        {"row": 0, "column": 0, "rowspan": 2, "colspan": 1}
    ]
    (chunk,) = packing.table_chunks(prepared)
    assert chunk.text == (
        "Table 2 Yield by plot\nPlot | Year | Yield\n"
        "North [one merged source cell, rows 1-2; columns Plot] | 2022 | 10\n"
        "North [one merged source cell, rows 1-2; columns Plot] | 2023 | 12"
    )
    assert chunk.page_start == chunk.page_end == 4
    assert chunk.regions[0].bbox == [100.0, 100.0, 900.0, 400.0]


def test_oversized_table_headers_preserve_all_text_under_the_budget() -> None:
    header = "A long descriptive column heading with ordinary source words. " * 28
    block = {
        "type": "table",
        "page_idx": 0,
        "bbox": [10, 10, 990, 990],
        "table_caption": ["Table 1 Yields"],
        "table_body": (
            f"<table><tr><th>{header}</th><th>Value</th></tr>"
            '<tr><td rowspan="2">North</td><td>42</td></tr>'
            "<tr><td>43</td></tr></table>"
        ),
    }
    chunks = packing.pack_blocks([block], frozenset())
    assert len(chunks) > 1
    assert all(
        chunking.estimate_tokens(c.text) <= packing.cfg.chunk_tokens for c in chunks
    )
    joined = " ".join(c.text for c in chunks)
    # The source heading also names the merged cell's scope in each of two rows.
    assert (
        joined.count("A long descriptive column heading with ordinary source words.")
        == 84
    )
    assert "Value" in joined and "42" in joined and "43" in joined
    assert joined.count("[one merged source cell, rows 1-2;") == 2
    assert all(c.page_start == c.page_end == 1 and c.regions for c in chunks)


def test_table_styles_keep_raw_values_and_their_source_scope() -> None:
    block = {
        "type": "table",
        "page_idx": 2,
        "bbox": [100, 100, 900, 500],
        "table_caption": ["Table 2 Yield (kg)"],
        "table_footnote": ["Bold marks the selected estimate."],
        "table_body": "<table><tr><th>Plot</th><th>Yield</th></tr><tr><td>North</td><td>42</td></tr><tr><td>South</td><td>18</td></tr></table>",
        "_table_source_styles": [
            {"row": 0, "column": 1, "styles": ["bold", "gray background"]}
        ],
    }
    (chunk,) = packing.table_chunks(block)
    assert "North | 42 [bold in source] [gray background in source]" in chunk.text
    assert "South | 18\n\nBold marks the selected estimate." in chunk.text
    assert "Yield (kg)" in chunk.text
    assert "[bold" not in block["table_body"]
    assert chunk.page_start == 3 and chunk.regions[0].bbox == block["bbox"]
    for metadata in (
        None,
        [None],
        [{"row": True, "column": 1, "styles": ["bold"]}],
        [{"row": 8, "column": 1, "styles": ["bold"]}],
        [{"row": 0, "column": 1, "styles": ["best result"]}],
        [{"row": 0, "column": 1, "styles": [["bold"]]}],
        block["_table_source_styles"] * 2,
    ):
        with pytest.raises((TypeError, ValueError)):
            packing.table_chunks({**block, "_table_source_styles": metadata})


def test_pack_blocks_isolates_native_tables_and_keeps_the_heading_context() -> None:
    table = {
        "type": "table",
        "page_idx": 0,
        "bbox": [100, 300, 900, 500],
        "table_body": "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    }
    blocks = [
        {
            "type": "text",
            "text": "Chapter 1",
            "text_level": 1,
            "page_idx": 0,
            "bbox": [0, 0, 10, 10],
        },
        {
            "type": "text",
            "text": "Running header",
            "page_idx": 0,
            "bbox": [0, 0, 10, 10],
        },
        {
            "type": "text",
            "text": "Intro prose.",
            "page_idx": 0,
            "bbox": [0, 20, 10, 30],
        },
        {
            "type": "text",
            "text": "Table 1 Sizes",
            "page_idx": 0,
            "bbox": [100, 260, 400, 290],
        },
        table,
        {
            "type": "text",
            "text": "After the table.",
            "page_idx": 0,
            "bbox": [0, 600, 10, 610],
        },
    ]
    chunks = packing.pack_blocks(blocks, frozenset({"Running header"}))
    # The caption block stays prose too; the table chunk repeats it as title.
    assert [c.text for c in chunks] == [
        "Intro prose.\n\nTable 1 Sizes",
        "Table 1 Sizes\nA | B\n1 | 2",
        "After the table.",
    ]
    assert [c.section_path for c in chunks] == [
        "Chapter 1",
        "Table 1 Sizes",
        "Chapter 1",
    ]
    # Recurrence is never inferred again: one copy of the header would have
    # been body text, three copies furniture; the frozen set decides both.
    repeated = [dict(blocks[1], page_idx=i) for i in range(3)]
    assert [c.text for c in packing.pack_blocks(repeated, frozenset())] == [
        "Running header\n\nRunning header\n\nRunning header"
    ]
    assert packing.pack_blocks(repeated, frozenset({"Running header"})) == []


def test_parser_and_pipeline_copies_are_identical() -> None:
    """The parser cannot import the pipeline, so these are copied; keep them equal."""
    for parser_obj, pipeline_obj in [
        (parser_table_html.Cell, packing.Cell),
        (parser_table_html.Table, packing.Table),
        (parser_table_html.checked_spans, packing.checked_spans),
        (parser_context.native_spans, packing.native_spans),
        (parser_furniture.clean_inline, chunking.clean_inline),
    ]:
        assert inspect.getsource(parser_obj) == inspect.getsource(pipeline_obj), (
            parser_obj
        )
    assert parser_furniture.CJK_CLASS == chunking.CJK_CLASS
    assert parser_furniture._MARKER_SUP_RE.pattern == chunking._MARKER_SUP_RE.pattern
    assert parser_furniture.REPEATED_ON_PAGES == chunking._REPEATED_ON_PAGES
    assert parser_furniture.REPEATABLE_TYPES == chunking._REPEATABLE_TYPES
    # Same caption search, apart from the parser's strict flag the lab dropped.
    assert parser_context.CAPTION.pattern == packing.CAPTION.pattern
    assert parser_context.UNIT.pattern == packing.UNIT.pattern
    blocks = [
        {"type": "text", "text": "Head<sup>1</sup>er  x", "page_idx": i}
        for i in range(3)
    ] + [{"type": "text", "text": "once", "page_idx": 0}]
    assert (
        parser_furniture.repeated_across_pages(blocks)
        == sorted(chunking._repeated_across_pages(blocks))
        == ["Header x"]
    )
