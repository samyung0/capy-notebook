"""Source-backed role corrections and occurrence filtering in shared packing."""

import copy
import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parser"))
from odl.headings import correct_roles

from pipeline.retrieval.chunking import chunk_content_list
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks


@pytest.mark.parametrize("prefix", ["II", "iv.", "A.", "B)", "1)", "(2)", "(iii)"])
def test_separated_section_prefix_retains_heading_ancestry(prefix, tmp_path):
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=800)
        page.insert_text((60, 200), prefix)
        page.insert_text((250, 200), "Integration")
        page.insert_text((60, 240), "A worked example follows.")
        rect = page.search_for(prefix)[0] | page.search_for("Integration")[0]
        heading = {
            "type": "text",
            "text": f"{prefix} Integration",
            "text_level": 2,
            "page_idx": 0,
            "bbox": [
                rect.x0 / 600 * 1000,
                rect.y0 / 800 * 1000,
                rect.x1 / 600 * 1000,
                rect.y1 / 800 * 1000,
            ],
        }
        body = {
            "type": "text",
            "text": "A worked example follows.",
            "page_idx": 0,
            "bbox": [100, 280, 600, 310],
        }
        source = tmp_path / "source.pdf"
        document.save(source)
        revised = correct_roles([heading, body], document)
        assert revised == [heading, body]
        chunks = retain_headings(revised, source, pack_blocks(revised, frozenset()))
        assert any(
            c.section_path == heading["text"] and body["text"] in c.text for c in chunks
        )


def test_repeated_body_text_survives_both_shared_entrypoints_with_its_region():
    blocks = []
    for page in range(3):
        blocks.extend(
            [
                {
                    "type": "text",
                    "text": "s = sqrt(25.52)",
                    "page_idx": page,
                    "bbox": [50, 100, 950, 900],
                },
                {
                    "type": "header",
                    "text": "s = sqrt(25.52)",
                    "page_idx": page,
                    "bbox": [50, 10, 950, 30],
                },
            ]
        )
    blocks.extend(
        [
            {
                "type": "text",
                "text": "s = sqrt(25.52)",
                "page_idx": 3,
                "bbox": [0, 100, 40, 900],
            },
            {
                "type": "text",
                "text": "s = sqrt(25.52)",
                "page_idx": 4,
                "bbox": [50, 99, 950, 900],
            },
            {"type": "text", "text": "s = sqrt(25.52)", "page_idx": 5, "bbox": None},
            {
                "type": "footer",
                "text": "Explicit footer",
                "page_idx": 0,
                "bbox": [50, 100, 950, 900],
            },
        ]
    )
    before = copy.deepcopy(blocks)
    for chunks in (
        chunk_content_list(blocks),
        pack_blocks(blocks, frozenset({"s = sqrt(25.52)"})),
    ):
        assert all("Explicit footer" not in c.text for c in chunks)
        assert {(r.page, tuple(r.bbox)) for c in chunks for r in c.regions} == {
            (p + 1, (50, 100, 950, 900)) for p in range(3)
        }
        assert any("s = sqrt(25.52)" in c.text for c in chunks)
    assert blocks == before


def test_source_roles_abstain_on_outline_mismatch_and_preserve_body(tmp_path):
    document = pymupdf.open()
    blocks = []

    def block(page, text, rect):
        blocks.append(
            {
                "type": "text",
                "text": text,
                "text_level": 2,
                "page_idx": page.number,
                "bbox": [
                    rect.x0 / 600 * 1000,
                    rect.y0 / 800 * 1000,
                    rect.x1 / 600 * 1000,
                    rect.y1 / 800 * 1000,
                ],
            }
        )

    for i in range(3):
        page = document.new_page(width=600, height=800)
        text = f"{i + 1} CHAPTER 1. SCIENCE"
        page.insert_text((60, 25), text)
        block(page, text, page.search_for(text)[0])
    page = document[0]
    for y, text in [
        (160, "Figure 2.1 Results"),
        (190, "Table 3 Protected"),
        (210, "1.2 Real section"),
        (280, "Table 5 Mismatch"),
    ]:
        page.insert_text((60, y), text)
        block(page, text, page.search_for(text)[0])
    # The mismatched source box covers another real span; it must abstain.
    page.insert_text((300, 280), "extra")
    blocks[-1]["bbox"][2] = 800
    page.insert_text((60, 240), "Event")
    page.insert_text((300, 240), "Garage full")
    block(
        page,
        "Event Garage full",
        page.search_for("Event")[0] | page.search_for("Garage full")[0],
    )
    page.insert_text((60, 340), "The worked example remains here.")
    block(
        page,
        "The worked example remains here.",
        page.search_for("The worked example remains here.")[0],
    )
    blocks[-1].pop("text_level")
    document.set_toc([[1, "Table 3 Protected", 1]])
    source = tmp_path / "source.pdf"
    document.save(source)
    before = copy.deepcopy(blocks)
    result = correct_roles(blocks, document)
    assert [b["type"] for b in result[:3]] == ["discarded"] * 3
    assert result[3]["_source_role"] == "numbered-caption"
    assert result[4:7] == blocks[4:7]
    assert result[7]["_source_role"] == "diagram-label"
    assert all(result[i].get("text_level") is None for i in (0, 1, 2, 3, 7))
    assert [(b["text"], b["page_idx"], b["bbox"]) for b in result] == [
        (b["text"], b["page_idx"], b["bbox"]) for b in before
    ]
    assert correct_roles(result, document) == result
    assert correct_roles(blocks[:2], document) == blocks[:2]
    chunks = retain_headings(result, source, pack_blocks(result, frozenset()))
    assert any("Event Garage full" in c.text for c in chunks)
    assert any("The worked example remains here." in c.text for c in chunks)
    assert all(
        "CHAPTER" not in c.indexed_text() and "Event Garage full" not in c.section_path
        for c in chunks
    )
    document.close()
    assert blocks == before
