"""Parser v9 heading levels (parser/odl/levels.py): fragments, contents lines and
the chapter backbone, on synthetic block lists."""

import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parser"))
from odl.layout_headings import recall_headings
from odl.levels import backbone_levels, demote_contents_lines, demote_fragments
from odl.list_headings import numbered_heading, split_headings


def _doc(pages: int, toc=None) -> pymupdf.Document:
    document = pymupdf.open()
    for _ in range(pages):
        document.new_page()
    if toc:
        document.set_toc(toc)
    return document


def _block(text, page, level=None, y=100, **extra):
    block = {
        "type": "text",
        "text": text,
        "page_idx": page,
        "bbox": [100, y, 900, y + 20],
    }
    if level:
        block["text_level"] = level
    return {**block, **extra}


@pytest.mark.parametrize(
    ("text", "role"),
    [
        ("∫ b", "formula-fragment"),
        ("= ∫ 2π", "formula-fragment"),
        ("ℝ𝑛 ℝ𝑛", "formula-fragment"),
        ("0 B @", "formula-fragment"),
        ("Example 9.1.2: Let", "run-in-label"),
        ("Proposition 8.2.8.", "run-in-label"),
        ("Proof.", "run-in-label"),
        ("Page 31 of 179", "page-footer"),
        ("π", "formula-fragment"),
        ("Pipe Volume = 0.785 × (15 ft)2 × 42 ft = 7,418.3 ft3", "calculation"),
        ("Total Gallons = 128,271.5 gal + 55,488.5 gal = 183,760 gal", "calculation"),
        # Titles stay: an index letter, a grammar headword, an ordinary heading,
        # a law stated in symbols.
        ("A", None),
        ("10.1.1 di 'at, in'", None),
        ("Introduction to sets", None),
        ("Ohm's Law: V = IR", None),
        # Figure and table captions are body text; titles that only start
        # with the label word stay.
        ("Figure 4.10: Effects of gate imperfections", "caption"),
        ("Abbildung 3: Struktureller Primärsaldo", "caption"),
        ("Table A-2. Evidence Base for KQs", "caption"),
        ("Table II", "caption"),
        ("Übersicht 2: Wesentliche Kennziffern", "caption"),
        ("Notes:", "caption"),
        ("Sources:", "caption"),
        ("圖 2.1 學會學習", "caption"),
        ("Table of Contents", None),
        ("Tableaux", None),
        ("Chart Gallery", None),
    ],
)
def test_formula_fragments_and_run_in_labels_become_body_text(text, role):
    blocks = [_block(text, 0, 3), _block("Body text follows here.", 0, y=200)]
    with _doc(1) as document:
        result = demote_fragments(blocks, document)
    assert result[1] == blocks[1]
    if role is None:
        assert result[0] == blocks[0]
    else:
        assert "text_level" not in result[0] and result[0]["_source_role"] == role
        assert result[0]["type"] == "text" and result[0]["text"] == text


def test_headings_the_outline_lists_are_never_demoted():
    # R's operator sections ("!", "%"): listed on page 1, not on page 2.
    blocks = [_block("!", 0, 3), _block("%", 1, 3)]
    with _doc(2, [[1, "!", 1]]) as document:
        result = demote_fragments(blocks, document)
    assert result[0] == blocks[0] and result[1]["_source_role"] == "formula-fragment"


@pytest.mark.parametrize("label", ["5.", "CHAPTER 3"])
def test_a_label_above_its_title_becomes_the_titles_label(label):
    blocks = [_block(label, 0, 2), _block("Arguments", 0, 3, y=150), _block("7.", 1, 2)]
    with _doc(2) as document:
        result = demote_fragments(blocks, document)
    assert result[0]["type"] == "discarded"
    assert result[0]["_source_role"] == "chapter-label"
    assert result[1]["_chapter_label"] == label and result[1]["text_level"] == 2
    # A bare number with no title after it is only demoted.
    assert result[2]["_source_role"] == "bare-number" and result[2]["type"] == "text"


@pytest.mark.parametrize(
    ("titles", "pages", "series"),
    [
        (
            [
                "Technology Insight 5.1",
                "Technology Insight 5.2",
                "Technology Insight 6.1",
            ],
            [3, 9, 20],
            True,
        ),
        (["Figure 1", "Figure 2", "Figure 3", "Figure 1"], [3, 4, 5, 20], True),
        (["World Music 57", "World Music 58", "World Music 59"], [56, 57, 58], True),
        (
            ["Problem Set 1", "Problem Set 2", "Problem Set 3", "Problem Set 4"],
            [3, 9, 14, 30],
            False,
        ),
    ],
)
def test_numbered_callout_series_are_demoted_but_clean_runs_stay(titles, pages, series):
    blocks = [_block(t, p, 3) for t, p in zip(titles, pages, strict=True)]
    with _doc(60) as document:
        result = demote_fragments(blocks, document)
    if series:
        assert all(b["_source_role"] == "callout-series" for b in result)
    else:
        assert result == blocks


def test_headings_on_printed_contents_pages_are_demoted():
    entries = [f"{n} Radiation and Spectra {100 + n}" for n in range(1, 6)]
    blocks = [_block("Contents", 1, 1), _block("List of Figures", 1, 2, y=120)]
    blocks += [_block(t, 1, 3, y=150 + 20 * n) for n, t in enumerate(entries)]
    # The same shape past the first fifth of the book is an index, not contents.
    blocks += [_block("Contents", 40, 1)]
    blocks += [_block(t, 40, 3, y=150 + 20 * n) for n, t in enumerate(entries)]
    with _doc(50) as document:
        result = demote_contents_lines(blocks, document)
    assert result[:2] == blocks[:2]
    assert all(b["_source_role"] == "contents-line" for b in result[2:7])
    assert result[7:] == blocks[7:]


def _book(parts=False, key_takeaways=False, openers=True):
    """Three chapters over 60 pages with front and back matter."""
    blocks = [
        _block("Preface", 0, 2),
        _block("About this book", 0, 3, y=200),
        _block("Contents", 1, 2),
        _block("Chapter 1 Motion", 1, 4, y=150),
        _block("Chapter 2 Forces", 1, 4, y=180),
    ]
    for number, (title, page) in enumerate(
        [("Motion", 2), ("Forces", 20), ("Energy", 40)], start=1
    ):
        if parts and number in (1, 3):
            blocks.append(
                _block(f"Part {1 if number == 1 else 2} Mechanics", page - 1, 2)
            )
        if not openers:
            blocks.append(_block("A line printed above the chapter title.", page, y=50))
        blocks.append(_block(f"Chapter {number} {title}", page, 3))
        blocks.append(_block(f"{number}.1 Basics", page, 5, y=200))
        blocks.append(_block("Body text of the section.", page, y=250))
        blocks.append(_block("Worked problems", page + 1, 5))
        blocks.append(_block("A note", page + 1, 7, y=200))
        blocks.append(
            {
                "type": "discarded",
                "text": "Running head",
                "page_idx": page + 1,
                "bbox": [100, 20, 900, 40],
                "_source_role": "running-banner",
                "_heading_boundary_level": 5,
            }
        )
        if key_takeaways:
            blocks.append(_block(f"Chapter {number} Key Takeaways", page + 15, 3))
    blocks.append(_block("Glossary", 59, 2))
    return blocks


def _by_text(blocks):
    return {
        b["text"]: b.get("text_level", b.get("_heading_boundary_level")) for b in blocks
    }


def test_backbone_levels_chapters_sections_front_matter_and_boundaries():
    blocks = _book()
    with _doc(60) as document:
        result = backbone_levels(blocks, document)
    levels = _by_text(result)
    assert levels["Chapter 3 Energy"] == 1 and levels["1.1 Basics"] == 2
    # Front matter never parents chapter 1; smaller headings nest under it.
    assert levels["Preface"] == 1 and levels["About this book"] == 2
    # Contents entries before the body are not the chapter chain.
    assert [b["text_level"] for b in result[3:5]] == [3, 3]
    # Styled like numbered sections: a sibling. Smaller: nested under them.
    assert [b["text_level"] for b in result if b["text"] == "Worked problems"] == [
        2
    ] * 3
    assert [b["text_level"] for b in result if b["text"] == "A note"] == [10] * 3
    assert levels["Glossary"] == 1
    # A removed banner's scope boundary is rescaled under the section in force.
    assert [
        b["_heading_boundary_level"] for b in result if b["type"] == "discarded"
    ] == [8] * 3
    assert [b["text"] for b in result] == [b["text"] for b in blocks]


def test_parts_rank_above_chapters():
    with _doc(60) as document:
        result = backbone_levels(_book(parts=True), document)
    levels = [
        (b["text"], b.get("text_level"))
        for b in result
        if b["text"][:4] in ("Part", "Chap")
    ]
    assert ("Part 1 Mechanics", 1) in levels and ("Chapter 3 Energy", 2) in levels
    assert _by_text(result)["1.1 Basics"] == 3


def test_repeated_chapter_callouts_are_not_the_chapter_chain():
    with _doc(60) as document:
        result = backbone_levels(_book(key_takeaways=True), document)
    # With "Chapter N Key Takeaways" as the chain, 1.1 would be front matter.
    assert [b["text_level"] for b in result if b["text"] == "1.1 Basics"] == [2]


def test_chapters_that_do_not_open_pages_are_found_by_style():
    with _doc(60) as document:
        result = backbone_levels(_book(openers=False), document)
    assert _by_text(result)["Chapter 2 Forces"] == 1
    assert [b["text_level"] for b in result if b["text"] == "2.1 Basics"] == [2]


def test_chapters_with_a_merged_part_tab_stay_chapters():
    # Conservation Techniques: ODL merged the part tab into some chapter titles.
    blocks = [_block("Conservation Techniques", 0, 1)]
    titles = [
        "Chapter 1 - Science and Practice",
        "Chapter 2 - Rewilding",
        "Habitat-Focused Techniques Chapter 3 - Restoration",
        "Chapter 4 - Ecosystem-Based Management",
        "Holistic Techniques Chapter 5 - Adaptive Management",
    ]
    for number, title in enumerate(titles):
        page = 2 + 10 * number
        blocks.append(_block(title, page, 2))
        blocks.append(_block("SECTION IN CAPITALS", page, 3, y=200))
        blocks.append(_block("Body text of the section.", page, y=250))
    with _doc(60) as document:
        result = backbone_levels(blocks, document)
    assert [b["text_level"] for b in result if b["text"] in titles] == [1] * 5
    # Each section nests under its own chapter, none under the chapter before.
    sections = [b["text_level"] for b in result if b["text"] == "SECTION IN CAPITALS"]
    assert sections == [5] * 5


def _list_page(lines):
    """One page with (text, size) lines from y = 100, and its list block. A line
    given as several texts sets them apart on one row."""
    document = pymupdf.open()
    page = document.new_page(width=600, height=800)
    y = 100
    for texts, size in lines:
        x = 60
        for text in [texts] if isinstance(texts, str) else texts:
            page.insert_text((x, y), text, fontsize=size)
            x += pymupdf.get_text_length(text, fontsize=size) + 20
        y += size + 8
    box = [60 / 0.6, 85 / 0.8, 560 / 0.6, (y + 5) / 0.8]
    return document, box


def test_a_numbered_heading_folded_into_a_list_item_splits_it():
    # Caltech: "1.5 Noise models" and its paragraph read as one list item; the
    # number is set apart from the title on the same row.
    document, box = _list_page(
        [
            ("Body text of the previous section ends here.", 10),
            ("Another body line keeps the page body style.", 10),
            (["1.5", "Noise models for quantum computing"], 14),
            ("In this section we explore noise models.", 10),
        ]
    )
    item = (
        "Body text of the previous section ends here. Another body line keeps the "
        "page body style. 1.5 Noise models for quantum computing In this section "
        "we explore noise models."
    )
    blocks = [{"type": "list", "list_items": [item], "page_idx": 0, "bbox": box}]
    with document:
        result = split_headings(blocks, document)
    assert [b["type"] for b in result] == ["list", "text", "text"]
    assert result[1]["text"] == "1.5 Noise models for quantum computing"
    assert result[1]["text_level"] == 2 and result[1]["_source_role"] == "list-heading"
    assert result[2]["text"] == "In this section we explore noise models."


def test_a_list_of_numbered_heading_styled_lines_stays_a_list():
    document, _ = _list_page(
        [("Body text sets the page body style here.", 10)] * 3
        + [("1. Gather the materials", 14), ("2. Mix them well", 14), ("3. Bake", 14)]
    )
    blocks = [
        {
            "type": "text",
            "text": "Body text sets the page body style here.",
            "page_idx": 0,
            "bbox": [100, 110, 900, 160],
        },
        {
            "type": "list",
            "list_items": ["1. Gather the materials", "2. Mix them well", "3. Bake"],
            "page_idx": 0,
            "bbox": [100, 160, 900, 260],
        },
    ]
    with document:
        assert split_headings(blocks, document) == blocks


@pytest.mark.parametrize(
    ("text", "heading"),
    [
        ("1.5 Noise models for quantum computing", True),
        ("34. Gesundheitsdatennutzungsgesetz (GDNG)", True),
        ("Artículo 18. Organización.", True),
        ("（3）社会教育施設等における学習機会の提供", True),
        ("C. Pharmacotherapy", True),
        ("IV. The Avant-Garde", True),
        ("2. How would you have resolved the conflict? Why?", False),
        ("1. Define healthcare management.", False),
        ("9.4. Corollary. Under assumptions of the previous corollary", False),
        ("3 Anaphase I", False),
        ("0.000 1.00", False),
        ("76 % des Français ne se sentent pas exposés", False),
        ("M. Olivier", False),
        ("a. Explain what is happening in the program", False),
        ("I. INONDATIONS SURVENUES ............ 19", False),
    ],
)
def test_numbered_heading_titles(text, heading):
    assert numbered_heading(text) is heading


def test_a_bold_heading_odl_read_as_a_paragraph_is_recalled():
    # The document's body is 10 pt regular; "Water Supply Systems" is 14 pt bold
    # on its own row with space above, read by ODL as body text.
    document = pymupdf.open()
    body = "Body text of the section runs on across the line and fills it out."
    for _ in range(3):
        page = document.new_page(width=600, height=800)
        y = 80
        for _ in range(12):
            page.insert_text((60, y), body, fontsize=10)
            y += 13
    page = document[1]
    page.insert_text((60, 260), "Water Supply Systems", fontsize=14, fontname="hebo")
    page.insert_text((60, 278), body, fontsize=10)
    blocks = [
        {
            "type": "text",
            "text": "Water Supply Systems",
            "page_idx": 1,
            "bbox": [95, 312, 450, 330],
        },
        {"type": "text", "text": body, "page_idx": 1, "bbox": [95, 335, 950, 352]},
    ]
    with document:
        result = recall_headings(blocks, document)
    assert result[0]["text_level"] and result[0]["_source_role"] == "layout-heading"
    assert result[1] == blocks[1]
