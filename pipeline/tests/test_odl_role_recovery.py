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


def _printed_heading(page, text, y, level, *, fontsize=11):
    page.insert_text((60, y), text, fontsize=fontsize)
    rects = page.search_for(text)
    rect = rects[-1]
    if "\n" in text:
        for part in rects:
            rect |= part
    return {
        "type": "text",
        "text": text,
        "text_level": level,
        "page_idx": page.number,
        "bbox": [
            rect.x0 / page.rect.width * 1000,
            rect.y0 / page.rect.height * 1000,
            rect.x1 / page.rect.width * 1000,
            rect.y1 / page.rect.height * 1000,
        ],
    }


@pytest.mark.parametrize("seed_pages", [2, 3])
def test_alternating_banners_need_a_proven_band_and_larger_source_titles(seed_pages):
    with pymupdf.open() as document:
        page = document.new_page(width=600, height=800)
        blocks = [
            _printed_heading(page, "Chapter alpha", 200, 2, fontsize=18),
            _printed_heading(page, "Methods and results", 240, 3, fontsize=16),
        ]
        for _ in range(seed_pages):
            page = document.new_page(width=600, height=800)
            blocks.append(
                _printed_heading(page, "Learning journal", 35, 2, fontsize=10)
            )
        page = document.new_page(width=600, height=800)
        variant = len(blocks)
        blocks.append(
            _printed_heading(
                page, "Chapter alpha\nMethods and results", 35, 2, fontsize=10
            )
        )
        protected = len(blocks)
        page = document.new_page(width=600, height=800)
        blocks.append(_printed_heading(page, "Chapter alpha", 35, 2, fontsize=10))
        document.set_toc([[1, "Chapter alpha", page.number + 1]])
        for title, size, rotation in [
            ("Unconfirmed title", 10, 0),
            ("Chapter alpha", 12, 0),
            ("Chapter alpha", 10, 90),
        ]:
            page = document.new_page(width=600, height=800)
            blocks.append(_printed_heading(page, title, 35, 2, fontsize=size))
            page.set_rotation(rotation)
        before = copy.deepcopy(blocks)
        result = correct_roles(blocks, document)
        removed = {i for i, b in enumerate(result) if b["type"] == "discarded"}
        assert removed == (set(range(2, variant + 1)) if seed_pages == 3 else set())
        assert all(result[i]["_heading_boundary_level"] == 2 for i in removed)
        assert result[protected] == blocks[protected]
        assert result[protected + 1 :] == blocks[protected + 1 :]
        assert [(b["text"], b["page_idx"], b["bbox"]) for b in result] == [
            (b["text"], b["page_idx"], b["bbox"]) for b in before
        ]
        assert blocks == before
        assert correct_roles(result, document) == result


@pytest.mark.parametrize("entrypoint", ["chunker", "plain-packer", "table-packer"])
@pytest.mark.parametrize("boundary", [1, 2])
def test_removed_banner_closes_former_scope_without_losing_prose_or_citations(
    entrypoint, boundary
):
    def text(value, page, level=None):
        block = {
            "type": "text",
            "text": value,
            "page_idx": page,
            "bbox": [100, 200, 800, 250],
        }
        if level is not None:
            block["text_level"] = level
        return block

    blocks = [
        text("Chapter", 0, 1),
        text("Chart label", 0, 3),
        text("Before the page boundary.", 0),
        {
            "type": "discarded",
            "text": "Running banner",
            "page_idx": 1,
            "bbox": [100, 20, 800, 40],
            "_source_role": "running-banner",
            "_heading_boundary_level": boundary,
        },
        text("Following page prose.", 1),
    ]
    if entrypoint == "table-packer":
        blocks.extend(
            [
                {
                    "type": "table",
                    "page_idx": 1,
                    "bbox": [100, 300, 800, 400],
                    "table_body": "<table><tr><th>Year</th><th>Value</th></tr><tr><td>2024</td><td>12</td></tr></table>",
                },
                text("Prose after the table.", 1),
            ]
        )
    before = copy.deepcopy(blocks)
    chunks = (
        chunk_content_list(blocks)
        if entrypoint == "chunker"
        else pack_blocks(blocks, frozenset())
    )
    assert chunks[0].section_path == "Chapter › Chart label"
    expected = "Chapter" if boundary == 2 else ""
    for phrase in ["Following page prose."] + (
        ["Prose after the table."] if entrypoint == "table-packer" else []
    ):
        matching = [c for c in chunks if phrase in c.text]
        assert len(matching) == 1 and matching[0].section_path == expected
        assert matching[0].regions[0].page == 2
        assert matching[0].regions[0].bbox == [100, 200, 800, 250]
    assert all("Running banner" not in c.indexed_text() for c in chunks)
    assert blocks == before


def test_neutral_banner_does_not_split_unchanged_scope_or_consume_body_metadata():
    blocks = [
        {"type": "text", "text": "Chapter", "text_level": 1},
        {"type": "text", "text": "First paragraph.", "page_idx": 0},
        {
            "type": "discarded",
            "text": "Banner",
            "page_idx": 1,
            "_source_role": "running-banner",
            "_heading_boundary_level": 2,
        },
        {
            "type": "text",
            "text": "Second paragraph.",
            "page_idx": 1,
            "_source_role": "running-banner",
            "_heading_boundary_level": 1,
        },
    ]
    for chunks in [chunk_content_list(blocks), pack_blocks(blocks, frozenset())]:
        assert len(chunks) == 1
        assert chunks[0].text == "First paragraph.\n\nSecond paragraph."
        assert chunks[0].section_path == "Chapter"


@pytest.mark.parametrize("appendix_level", [3, 6])
def test_complete_outline_roots_end_frontmatter_ancestry_and_preserve_split_title(
    appendix_level,
):
    with pymupdf.open() as document:
        blocks = []
        for title, level in [
            ("Contents", 1),
            ("Motion", 5),
            ("APPENDIX A", appendix_level),
        ]:
            page = document.new_page()
            blocks.append(_printed_heading(page, title, 120, level))
            if title == "APPENDIX A":
                blocks.append(_printed_heading(page, "Reference Tables", 145, 4))
            blocks.append(
                {
                    "type": "text",
                    "text": f"Prose under {title}.",
                    "page_idx": page.number,
                }
            )
        document.set_toc(
            [
                [1, "Contents", 1],
                [1, "Motion", 2],
                [1, "APPENDIX A Reference Tables", 3],
            ]
        )
        result = correct_roles(blocks, document)
        assert [b["text_level"] for b in result if b.get("text_level")] == [1, 1, 1, 4]
        chunks = pack_blocks(result, frozenset())
        assert any(
            c.section_path == "Motion" and "Prose under Motion." in c.text
            for c in chunks
        )
        assert all(
            "Contents" not in c.section_path for c in chunks if "Motion" in c.text
        )
        assert [{k: v for k, v in b.items() if k != "text_level"} for b in result] == [
            {k: v for k, v in b.items() if k != "text_level"} for b in blocks
        ]


@pytest.mark.parametrize("following_level", [2, 6])
def test_outline_root_does_not_expand_past_an_unmatched_existing_heading_boundary(
    following_level,
):
    with pymupdf.open() as document:
        page = document.new_page()
        opening = _printed_heading(page, "Opening statement", 120, 6)
        page = document.new_page()
        following = _printed_heading(page, "Contents", 120, following_level)
        body = {"type": "text", "text": "Chapter listing follows.", "page_idx": 1}
        document.set_toc([[1, "Opening statement", 1]])
        blocks = [opening, following, body]
        result = correct_roles(blocks, document)
        chunks = pack_blocks(result, frozenset())
        assert (
            next(c for c in chunks if body["text"] in c.text).section_path == "Contents"
        )
        assert [(b["text"], b.get("page_idx"), b.get("bbox")) for b in result] == [
            (b["text"], b.get("page_idx"), b.get("bbox")) for b in blocks
        ]


def test_outline_root_can_include_a_uniquely_confirmed_lower_level_child():
    with pymupdf.open() as document:
        page = document.new_page()
        root = _printed_heading(page, "Thermodynamics", 120, 6)
        page = document.new_page()
        child = _printed_heading(page, "Overview", 120, 2)
        body = {"type": "text", "text": "Heat moves between systems.", "page_idx": 1}
        document.set_toc([[1, "Thermodynamics", 1], [2, "Overview", 2]])
        result = correct_roles([root, child, body], document)
        assert result[0]["text_level"] == 1
        assert (
            next(
                c for c in pack_blocks(result, frozenset()) if body["text"] in c.text
            ).section_path
            == "Thermodynamics › Overview"
        )


def test_outline_root_cannot_outlive_a_newly_removed_banner_boundary():
    with pymupdf.open() as document:
        page = document.new_page()
        blocks = [_printed_heading(page, "Systems", 120, 6, fontsize=18)]
        for _ in range(3):
            page = document.new_page()
            blocks.append(
                _printed_heading(page, "Learning journal", 35, 6, fontsize=10)
            )
            blocks.append(
                {
                    "type": "text",
                    "text": f"Following page {page.number} prose.",
                    "page_idx": page.number,
                }
            )
        document.set_toc([[1, "Systems", 1]])
        result = correct_roles(blocks, document)
        assert result[0]["text_level"] == 6
        assert all(result[i]["_heading_boundary_level"] == 6 for i in (1, 3, 5))
        chunks = pack_blocks(result, frozenset())
        assert chunks and all(not c.section_path for c in chunks)
        assert all(
            f"Following page {p} prose." in "\n".join(c.text for c in chunks)
            for p in (1, 2, 3)
        )


@pytest.mark.parametrize(
    "case",
    [
        "missing",
        "mismatch",
        "ambiguous",
        "duplicate-root",
        "direct-destination",
        "direct-destination-peer",
    ],
)
def test_outline_root_matching_abstains_as_a_whole_unless_unique(case):
    with pymupdf.open() as document:
        page = document.new_page()
        blocks = [
            _printed_heading(page, "Contents", 100, 1),
            _printed_heading(page, "Motion", 250, 5),
        ]
        toc = [[1, "Contents", 1], [1, "Motion", 1]]
        if case == "missing":
            toc.append([1, "Missing chapter", 1])
        elif case == "mismatch":
            blocks[1]["text"] = "Unprinted title"
        elif case == "duplicate-root":
            toc.append([1, "Motion", 1])
        else:
            y = 260 if case == "ambiguous" else 500
            level = 6 if case == "direct-destination" else 3
            blocks.append(_printed_heading(page, "Motion", y, level))
            toc[1].append(
                {"kind": pymupdf.LINK_GOTO, "page": 0, "to": pymupdf.Point(60, 250)}
            )
        document.set_toc(toc)
        result = correct_roles(blocks, document)
        if case == "direct-destination":
            assert result[1]["text_level"] == 1
            assert result[2] == blocks[2]
        else:
            assert result == blocks


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
    assert result[4] == blocks[4]
    assert result[5:7] == blocks[5:7]
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
