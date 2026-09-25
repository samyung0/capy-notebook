"""Source-backed role corrections and occurrence filtering in shared packing."""

import copy
import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parser"))
from odl.headings import correct_roles, insert_outline_headings, promote_capitals

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


def _printed_heading(page, text, y, level, *, fontsize=11, html=False, x=60):
    if html:  # a Unicode font for glyphs outside Latin-1, such as bullets
        page.insert_htmlbox(pymupdf.Rect(x, y - 15, 500, y + 15), text)
    else:
        page.insert_text((x, y), text, fontsize=fontsize)
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


def _side(number):
    return 60 if number % 2 == 0 else 380


@pytest.mark.parametrize(
    ("case", "y", "titles", "removed"),
    [
        # Section running heads change title; one repeat proves the band.
        ("titles", 35, ["{} Motion", "Forces {}", "{} Motion", "Heat {}"], True),
        ("wide-bottom-band", 780, ["Chapter 1 | {}"] * 3, True),
        ("bare-top-folio", 35, ["{}"] * 3, True),
        ("numbered-slides", 35, ["{} Introduction", "{} Method", "{} Results"], False),
    ],
)
def test_page_tracking_folios_make_running_banners_whatever_their_title(
    case, y, titles, removed
):
    # Facing pages print the banner on alternate sides, which shows the offset.
    with pymupdf.open() as document:
        blocks = []
        for number, title in enumerate(titles):
            page = document.new_page()
            blocks.append(
                _printed_heading(
                    page, title.format(number + 12), y, 2, fontsize=10, x=_side(number)
                )
            )
        if case == "wide-bottom-band":
            assert all(900 < b["bbox"][1] < 935 for b in blocks)
        result = correct_roles(blocks, document)
        if removed:
            assert all(b["type"] == "discarded" for b in result)
            assert all(b["_heading_boundary_level"] == 2 for b in result)
            assert [(b["text"], b["bbox"]) for b in result] == [
                (b["text"], b["bbox"]) for b in blocks
            ]
            assert correct_roles(result, document) == result
        else:
            assert result == blocks


@pytest.mark.parametrize(
    "titles",
    [
        # OpenStax end matter: the page is the larger number at either end.
        ["4 • Chapter Review {}", "{} 4 • Chapter Review"] * 2,
        # A book title ending in a number keeps the leading folio.
        ["{} • MEDIA STUDIES 101"] * 4,
    ],
)
def test_running_heads_with_a_number_at_both_ends_take_either_folio(titles):
    with pymupdf.open() as document:
        blocks = []
        for number, title in enumerate(titles):
            page = document.new_page()
            x = 330 if number % 2 == 0 else 60  # facing pages
            text = title.format(number + 12)
            blocks.append(_printed_heading(page, text, 35, 2, html=True, x=x))
        result = correct_roles(blocks, document)
    assert all(b["_source_role"] == "running-banner" for b in result)


def test_removed_folio_banners_end_an_earlier_chart_label_scope():
    # The BOJ regression: dropping banners must not carry a label onward.
    with pymupdf.open() as document:
        page = document.new_page()
        blocks = [
            _printed_heading(page, "Financial system", 150, 1, fontsize=18),
            _printed_heading(page, "Chart label", 300, 3, fontsize=8),
        ]
        for number, title in enumerate(["Banks", "Markets", "Banks"], start=1):
            page = document.new_page()
            blocks.append(
                _printed_heading(page, f"{number + 4} {title}", 35, 3, x=_side(number))
            )
            blocks.append(
                {
                    "type": "text",
                    "text": f"Prose on page {number}.",
                    "page_idx": number,
                    "bbox": [100, 200, 800, 250],
                }
            )
        result = correct_roles(blocks, document)
        assert [b["type"] for b in result[2::2]] == ["discarded"] * 3
        chunks = pack_blocks(result, frozenset())
        for number in (1, 2, 3):
            chunk = next(c for c in chunks if f"Prose on page {number}." in c.text)
            assert chunk.section_path == "Financial system"


def test_thin_odl_boxes_still_prove_running_heads():
    # Media's ODL boxes cover only the top 45% of the glyphs, so no span
    # centre falls inside; the thin-box retry must still find the evidence.
    with pymupdf.open() as document:
        blocks = []
        for number in range(3):
            page = document.new_page()
            title = f"{number + 2} Media, Society, Culture and You"
            block = _printed_heading(page, title, 35, 2, fontsize=10, x=_side(number))
            top, bottom = block["bbox"][1], block["bbox"][3]
            block["bbox"][3] = top + 0.45 * (bottom - top)
            span = page.get_text("dict")["blocks"][0]["lines"][0]["spans"][0]
            centre = (span["bbox"][1] + span["bbox"][3]) / 2 / page.rect.height * 1000
            assert centre > block["bbox"][3]
            blocks.append(block)
        result = correct_roles(blocks, document)
        assert all(b["type"] == "discarded" for b in result)
        assert all(b["_heading_boundary_level"] == 2 for b in result)


def _folio(label, page):
    return {
        "type": "text",
        "text": label,
        "page_idx": page,
        "bbox": [480, 955, 520, 970],
    }


@pytest.mark.parametrize(
    ("title", "y"),
    [("Exercise {}", 72), ("Question {}", 72), ("Step {}", 35), ("{}", 35)],
)
@pytest.mark.parametrize("folio_shift", [None, 0, 20])
def test_numbered_page_tops_are_banners_only_at_the_offset_the_book_shows(
    title, y, folio_shift
):
    # These numbers rise with the page like folios, one per page on one side.
    # Only printed page numbers with the same page offset make them banners.
    with pymupdf.open() as document:
        blocks = []
        for number in range(3):
            page = document.new_page()
            blocks.append(_printed_heading(page, title.format(number + 1), y, 2))
        if title.startswith("Exercise"):
            assert all(65 < b["bbox"][1] < b["bbox"][3] < 100 for b in blocks)
        if folio_shift is not None:
            blocks += [_folio(str(page + 1 + folio_shift), page) for page in range(3)]
        result = correct_roles(blocks, document)
        if folio_shift == 0:
            assert [b["type"] for b in result[:3]] == ["discarded"] * 3
            assert result[3:] == blocks[3:]
        else:
            assert result == blocks


@pytest.mark.parametrize(
    "split", ["paragraph", "no-evidence", "two-bands", "two-sizes"]
)
def test_a_numbered_series_cannot_prove_its_own_page_offset(split):
    # ODL can type one Exercise heading as a paragraph, lose its span evidence,
    # or split the series into families by band or size. The other part of the
    # series must not stand in for the page numbers the book shows.
    with pymupdf.open() as document:
        blocks = []
        for number in range(4 if split == "paragraph" else 6):
            page = document.new_page()
            y = 77 if split == "two-bands" and number % 2 else 72
            size = 13 if split == "two-sizes" and number >= 3 else 11
            blocks.append(
                _printed_heading(page, f"Exercise {number + 1}", y, 2, fontsize=size)
            )
        if split == "paragraph":
            blocks[-1].pop("text_level")
        elif split == "no-evidence":
            blocks[2]["bbox"][2] = blocks[2]["bbox"][0] + 5
        elif split == "two-bands":
            assert len({round(b["bbox"][1] / 10) for b in blocks}) == 2
        assert all(65 < b["bbox"][1] < b["bbox"][3] < 100 for b in blocks)
        assert correct_roles(blocks, document) == blocks


@pytest.mark.parametrize("layout", ["centred", "full-width"])
def test_bottom_footers_that_are_the_only_page_numbers_are_removed(layout):
    # The offset guard is for page-top headings. A centred or full-width footer
    # shows no side and is often the book's only page numbering.
    with pymupdf.open() as document:
        blocks = []
        for number in range(3):
            page = document.new_page()
            if layout == "centred":
                block = _printed_heading(page, f"Page | {number + 1}", 800, 3, x=280)
            else:
                page.insert_text((60, 800), "Innovation Toolkit", fontsize=10)
                page.insert_text((520, 800), str(number + 1), fontsize=10)
                rect = page.search_for("Innovation Toolkit")[0]
                rect |= page.search_for(str(number + 1))[-1]
                block = {
                    "type": "text",
                    "text": f"Innovation Toolkit {number + 1}",
                    "text_level": 3,
                    "page_idx": number,
                    "bbox": [
                        rect.x0 / page.rect.width * 1000,
                        rect.y0 / page.rect.height * 1000,
                        rect.x1 / page.rect.width * 1000,
                        rect.y1 / page.rect.height * 1000,
                    ],
                }
            blocks.append(block)
        assert all(b["bbox"][0] < 500 < b["bbox"][2] for b in blocks)
        assert all(b["bbox"][1] > 900 for b in blocks)
        result = correct_roles(blocks, document)
        assert all(b["type"] == "discarded" for b in result)
        assert all(b["_heading_boundary_level"] == 3 for b in result)


@pytest.mark.parametrize("front", ["roman", "arabic"])
def test_front_matter_numbered_apart_proves_its_own_running_heads(front):
    # Front matter i-iii (or 1-3), then the body restarts at 1 on page 4.
    with pymupdf.open() as document:
        blocks = []
        for index in range(6):
            page = document.new_page()
            if index < 3:
                label = (
                    ["i", "ii", "iii"][index] if front == "roman" else str(index + 1)
                )
                title = f"{label} Preface"
            else:
                label = str(index - 2)
                title = f"{label} Motion"
            blocks.append(_printed_heading(page, title, 35, 2))
            blocks.append(_folio(label, index))
        result = correct_roles(blocks, document)
        assert [b["type"] for b in result[::2]] == ["discarded"] * 6
        assert result[1::2] == blocks[1::2]


def test_headings_that_start_with_a_bullet_become_body_text():
    with pymupdf.open() as document:
        page = document.new_page()
        bullet = _printed_heading(page, "• Safety", 150, 3, html=True)
        plain = _printed_heading(page, "Safety", 250, 3)
        result = correct_roles([bullet, plain], document)
        assert result[0]["_source_role"] == "bullet-item"
        assert "text_level" not in result[0]
        assert result[0]["text"] == "• Safety" and result[0]["type"] == "text"
        assert result[1] == plain


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
        page.insert_text((_side(i), 25), text)  # facing pages show the offset
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


def test_running_heads_typed_as_paragraphs_join_the_banner_rules():
    # College Research: ODL typed half its running heads as paragraphs.
    with pymupdf.open() as document:
        blocks = []
        for number, title in enumerate(["{} Motion", "Forces {}", "{} Motion"]):
            page = document.new_page()
            head = _printed_heading(
                page, title.format(number + 12), 35, 2, fontsize=10, x=_side(number)
            )
            if number:
                head.pop("text_level")
            body = _printed_heading(page, "Motion is change of place.", 300, 2)
            body.pop("text_level")
            blocks += [head, body]
        result = correct_roles(blocks, document)
        assert [b["type"] for b in result[::2]] == ["discarded"] * 3
        assert all(b["_source_role"] == "running-banner" for b in result[::2])
        # Only the former heading keeps a scope boundary.
        assert [b.get("_heading_boundary_level") for b in result[::2]] == [
            2,
            None,
            None,
        ]
        assert result[1::2] == blocks[1::2]
        assert correct_roles(result, document) == result


def test_facing_paragraph_heads_still_prove_the_heading_heads():
    # Open Research: even pages' running heads are headings, odd pages' are
    # paragraphs, and both span the page, so only the other side's heads show
    # the page offset. Joining the family must not take that proof away.
    with pymupdf.open() as document:
        blocks = []
        for number in range(6):
            page = document.new_page()
            text = (
                f"{number + 1} Open research in practice / An introduction to the whole field"
                if number % 2 == 0
                else f"An introduction to the whole field / Open research in practice {number + 1}"
            )
            head = _printed_heading(page, text, 35, 7, fontsize=10)
            if number % 2:
                head.pop("text_level")
            blocks.append(head)
        assert all(b["bbox"][0] < 500 < b["bbox"][2] for b in blocks)
        result = correct_roles(blocks, document)
        assert all(b["type"] == "discarded" for b in result)
        assert [b.get("_heading_boundary_level") for b in result] == [7, None] * 3


@pytest.mark.parametrize(
    ("y", "titles", "level", "removed"),
    [
        # Java, Java, Java: facing running heads at y = 0.107.
        (0.107, ["{} CHAPTER 4 Input/Output", "SECTION 4.4 Output {}"] * 3, 2, True),
        # Compressible Flow: "250 CHAPTER 9. NORMAL SHOCK" at y = 0.123.
        (0.123, ["{} CHAPTER 9. NORMAL SHOCK"] * 6, 2, True),
        # A body paragraph at y = 0.15 on three pages: under five pages.
        (0.15, ["{} Motion is change of place."] * 3, None, False),
    ],
)
def test_running_heads_below_the_margin_band_are_banners_on_five_pages(
    y, titles, level, removed
):
    with pymupdf.open() as document:
        blocks = []
        for number, title in enumerate(titles):
            page = document.new_page()
            head = _printed_heading(
                page,
                title.format(number + 12),
                y * page.rect.height + 10,
                level or 2,
                fontsize=10,
                x=_side(number),
            )
            if level is None:
                head.pop("text_level")
            blocks.append(head)
        # Outside the margin band, inside the top fifth.
        assert all(100 < b["bbox"][3] < 200 for b in blocks)
        result = correct_roles(blocks, document)
        if removed:
            assert all(b["_source_role"] == "running-banner" for b in result)
            assert [b["_heading_boundary_level"] for b in result] == [level] * len(
                blocks
            )
        else:
            assert result == blocks


@pytest.mark.parametrize(
    ("text", "pages", "every", "removed"),
    [
        # Papuan Malay: a folio-less head at y = 0.07-0.09 repeats a chapter
        # title printed larger earlier.
        ("1 Introduction", 4, 1, True),
        # A label at the top of three pages stays a heading.
        ("Example", 4, 1, False),
        # Accounting Principles: a licence line on a quarter of the pages.
        ("This book is licensed under a Creative Commons licence", 20, 4, True),
    ],
)
def test_running_heads_just_below_the_margin_band_need_a_title_or_a_quarter(
    text, pages, every, removed
):
    with pymupdf.open() as document:
        blocks = []
        for number in range(pages):
            page = document.new_page()
            if number == 0:
                blocks.append(
                    _printed_heading(page, "1 Introduction", 200, 1, fontsize=18)
                )
            elif (number - 1) % every == 0:
                blocks.append(_printed_heading(page, text, 70, 5, fontsize=10))
            blocks.append(_line("Body text.", number, 500))
        heads = [
            i for i, b in enumerate(blocks) if b["text"] == text and b["bbox"][1] < 100
        ]
        assert all(
            65 < blocks[i]["bbox"][1] < blocks[i]["bbox"][3] < 100 for i in heads
        )
        result = correct_roles(blocks, document)
    if removed:
        assert all(result[i]["_source_role"] == "running-banner" for i in heads)
        assert result[0] == blocks[0]
    else:
        assert result == blocks


@pytest.mark.parametrize(
    ("text", "size", "outline", "demoted"),
    [
        ("It carried over from the page before.", 11, False, True),
        ("Why This Book?", 16, False, False),
        ("A title that ends with a stop.", 11, True, False),
        ("An unfinished line in body type", 11, False, False),
    ],
)
def test_sentence_headings_set_in_the_body_style_are_demoted(
    text, size, outline, demoted
):
    with pymupdf.open() as document:
        page = document.new_page()
        heading = _printed_heading(page, text, 100, 11, fontsize=size)
        for y in (150, 170, 190):
            page.insert_text((60, y), "Ordinary prose fills the page in body type.")
        if outline:
            document.set_toc([[1, text, 1]])
        result = correct_roles([heading], document)
        if demoted:
            assert "text_level" not in result[0]
            assert result[0]["_source_role"] == "body-style-heading"
            assert result[0]["type"] == "text" and result[0]["text"] == text
        else:
            assert result[0]["text_level"] in (1, 11)


def _line(text, page, y, level=None, height=20):
    block = {
        "type": "text",
        "text": text,
        "page_idx": page,
        "bbox": [100, y, 900, y + height],
    }
    if level:
        block["text_level"] = level
    return block


def test_capitals_lines_between_blank_space_become_sibling_headings():
    body = "The habitat model follows from field surveys."
    blocks = [
        # A half-title, then the title page with its author line.
        _line("Conservation Techniques", 0, 100, level=1),
        _line("Conservation Techniques", 1, 100, level=1),
        _line("LEE A. SWANSON AND OTHERS", 1, 300),
        _line(body, 1, 350),
        _line("Chapter one", 2, 100, level=2),
        _line(body, 2, 130),
        _line("LIMITATIONS OF HABITAT MAPPING", 2, 180),
        _line(body, 2, 230),
        _line("FIELD SURVEY METHODS", 2, 280),
        _line(body, 2, 330),
        _line("PV = (PMT, I/Y, N, FV) VALUES", 2, 380),  # a formula
        _line(body, 2, 430),
        _line("CHAPTER ONE", 2, 480),  # an existing heading in capitals
        _line(body, 2, 530),
        _line("TOO CLOSE TO ITS BODY", 2, 580),
        _line(body, 2, 605),
        _line("A LONG TWO-LINE CAPITALS PARAGRAPH", 2, 650, height=45),
        _line(body, 2, 720),
        _line("NOTHING BUT CAPITALS", 2, 770),
        _line("UPPER CASE ALL THE WAY", 2, 820),
    ]
    blocks += [_line("LINK TO LEARNING", p, 200) for p in (3, 4, 5)]
    blocks += [_line(body, p, 250) for p in (3, 4, 5)]
    # A running head with a Roman folio carries a folio too.
    blocks += [_line("TITLE PAGE | XI", 6, 40, height=15), _line(body, 6, 100)]
    with pymupdf.open() as document:
        for _ in range(7):
            document.new_page()
        result = promote_capitals(blocks, document)
    promoted = {i: b["text_level"] for i, b in enumerate(result) if b != blocks[i]}
    assert promoted == {6: 3, 8: 3}
    assert all(result[i]["_source_role"] == "capitals-heading" for i in promoted)


def test_chapter_titles_printed_only_in_running_heads_come_from_the_outline():
    # College Research: the chapter title is in the outline and in running heads
    # that ODL typed as paragraphs, which the banner rules discard.
    with pymupdf.open() as document:
        page = document.new_page()
        blocks = [_printed_heading(page, "Algorithms", 120, 1, fontsize=18)]
        for number in range(3):
            page = document.new_page()
            folio = number + 11
            head = _printed_heading(
                page,
                f"WHAT ARE ALGORITHMS? | {folio}"
                if number % 2 == 0
                else f"{folio} | WHAT ARE ALGORITHMS?",
                35,
                2,
                fontsize=9,
                x=380 if number % 2 == 0 else 60,
            )
            head.pop("text_level")
            blocks.append(head)
            if number == 0:
                blocks.append(_printed_heading(page, "Why It Matters", 200, 4))
            body = _printed_heading(page, f"Prose on page {folio}.", 300, 4)
            body.pop("text_level")
            blocks.append(body)
        document.set_toc([[1, "Algorithms", 1], [2, "What are Algorithms?", 2]])
        result = correct_roles(blocks, document)
        assert correct_roles(result, document) == result
    # Inserted at the outline destination, after the page's running head.
    assert result[1]["type"] == "discarded"
    inserted = result[2]
    assert inserted == {
        "type": "text",
        "text": "What are Algorithms?",
        "text_level": 2,
        "page_idx": 1,
        "bbox": blocks[1]["bbox"],
        "_source_role": "outline-heading",
    }
    chunk = next(c for c in pack_blocks(result, frozenset()) if "page 11" in c.text)
    assert chunk.section_path == "Algorithms › What are Algorithms? › Why It Matters"


@pytest.mark.parametrize(
    ("toc", "level"),
    [
        # The level of matched siblings under the same parent wins.
        ([[1, "Part", 1], [2, "Matched", 1], [2, "Missing", 2]], 5),
        # Else one below the parent entry's heading.
        ([[1, "Part", 1], [2, "Missing", 2]], 3),
        # Else level 1.
        ([[1, "Missing", 2]], 1),
        # A heading on the page already carries the title.
        ([[1, "Part", 1], [2, "Present", 2]], None),
    ],
)
def test_outline_heading_levels_follow_siblings_then_parent(toc, level):
    def block(text, page, **extra):
        return {
            "type": "text",
            "text": text,
            "page_idx": page,
            "bbox": [100, 40, 900, 60],
            **extra,
        }

    banner = {"type": "discarded", "_source_role": "running-banner"}
    blocks = [
        block("Part", 0, text_level=2),
        block("Matched", 0, text_level=5),
        block("MISSING | 7", 1, **banner),
        block("PRESENT | 7", 1, **banner),
        block("Present", 1, text_level=5),
        block("Missing is repeated in the body.", 1),
    ]
    with pymupdf.open() as document:
        for _ in range(2):
            document.new_page()
        document.set_toc(toc)
        result = insert_outline_headings(blocks, document)
    new = [b for b in result if b.get("_source_role") == "outline-heading"]
    assert [b for b in result if b not in new] == blocks
    if level is None:
        assert new == []
    else:
        assert [(b["text"], b["text_level"]) for b in new] == [("Missing", level)]


def _toc(document, rows, y):
    """set_toc with every destination at height ``y`` (0-1000); None makes them
    named destinations, which carry no usable height."""
    document.set_toc(
        [
            [
                level,
                title,
                page,
                {"kind": pymupdf.LINK_GOTO, "page": page - 1, "to": top},
            ]
            for level, title, page in rows
            for top in [
                pymupdf.Point(0, (y or 0) / 1000 * document[page - 1].rect.height)
            ]
        ]
    )
    if y is None:
        names = " ".join(
            f"(d{n}) [{document[page - 1].xref} 0 R /Fit]"
            for n, (_, _, page) in enumerate(rows)
        )
        document.xref_set_key(
            document.pdf_catalog(), "Names", f"<</Dests <</Names [{names}]>>>>"
        )
        for n, row in enumerate(document.get_toc(simple=False)):
            document.xref_set_key(row[3]["xref"], "A", f"<</S /GoTo /D (d{n})>>")


@pytest.mark.parametrize("case", ["line", "height", "no-height"])
def test_outline_headings_go_to_the_outline_destination(case):
    # OpenStax Chemistry: the Key Terms glossary runs into the top of the page
    # where the outline points "Key Equations" (y = 0.223).
    def block(text, page, y, **extra):
        box = [100, y, 900, y + 15]
        return {"type": "text", "text": text, "page_idx": page, "bbox": box, **extra}

    banner = {"type": "discarded", "_source_role": "running-banner"}
    blocks = [
        block("Key Terms", 0, 100, text_level=2),
        block("4 • Key Equations 61", 1, 30, **banner),
        block("molarity: moles of solute per litre of solution", 1, 60),
        block("M = n / V" if case == "height" else "Key Equations", 1, 223),
    ]
    heading = {
        "type": "text",
        "text": "Key Equations",
        "text_level": 2,
        "page_idx": 1,
        "bbox": blocks[1]["bbox"],
        "_source_role": "outline-heading",
    }
    with pymupdf.open() as document:
        for _ in range(2):
            document.new_page()
        rows = [[1, "Key Terms", 1], [1, "Key Equations", 2]]
        _toc(document, rows, None if case == "no-height" else 223)
        result = insert_outline_headings(blocks, document)
    if case == "line":  # the printed line at the destination becomes the heading
        promoted = {"text_level": 2, "_source_role": "outline-heading"}
        assert result == [*blocks[:3], {**blocks[3], **promoted}]
    elif case == "height":
        assert result == [*blocks[:3], heading, blocks[3]]
    else:  # today's place: before the page's first block
        assert result == [blocks[0], heading, *blocks[1:]]


@pytest.mark.parametrize(
    ("rows", "line", "promoted"),
    [
        # ReStorying Education: a chapter that opens under the book-title
        # running head prints its title as body text where the outline points.
        (
            [[1, "1 Why ReStory", 1], [1, "2 Stories of Schooling", 2]],
            "Stories of Schooling",
            True,
        ),
        # Media Studies: an author tag after every chapter is not a title.
        (
            [
                row
                for n in (1, 2, 3)
                for row in ([1, f"Chapter {n}", n], [1, "mediatexthack", n])
            ],
            "mediatexthack",
            False,
        ),
        # A byline listed under its parent entry on the same page.
        ([[1, "About", 2], [2, "media texthack", 2]], "media texthack", False),
    ],
)
def test_a_body_line_at_the_destination_alone_makes_an_outline_heading(
    rows, line, promoted
):
    blocks = [
        {
            "type": "discarded",
            "_source_role": "running-banner",
            "text": "26 RESTORYING EDUCATION",
            "page_idx": 1,
            "bbox": [100, 30, 900, 45],
        },
        {"type": "text", "text": "2", "page_idx": 1, "bbox": [480, 151, 520, 180]},
        {"type": "text", "text": line, "page_idx": 1, "bbox": [100, 260, 900, 280]},
        {
            "type": "text",
            "text": "Schools tell stories about who belongs.",
            "page_idx": 1,
            "bbox": [100, 300, 900, 320],
        },
    ]
    with pymupdf.open() as document:
        for _ in range(3):
            document.new_page()
        _toc(document, rows, 260)
        result = insert_outline_headings(blocks, document)
    if promoted:
        heading = {"text_level": 1, "_source_role": "outline-heading"}
        assert result == [*blocks[:2], {**blocks[2], **heading}, blocks[3]]
    else:
        assert result == blocks
