"""Parser v10 outline levels and book-title roots (parser/odl/outline_levels.py)
on synthetic block lists."""

import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parser"))
from odl import outline_levels as ol


def _doc(pages: int, toc=None, title=None) -> pymupdf.Document:
    document = pymupdf.open()
    for _ in range(pages):
        document.new_page()
    if toc:
        document.set_toc(toc)
    if title:
        document.set_metadata({"title": title})
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


def _body(page, y=300, chars=60):
    return _block("Body text " + "x" * (chars - 10), page, y=y)


def _levels(blocks):
    return {b["text"]: b.get("text_level") for b in blocks if b.get("text_level")}


# ------------------------------------------------------------------ outline levels

# Four chapters; the outline lists the chapters and two sections.
_TOC = [
    [1, "Chapter 1 Motion", 2],
    [2, "1.1 Speed", 3],
    [1, "Chapter 2 Forces", 5],
    [2, "2.1 Mass", 6],
    [1, "Chapter 3 Energy", 8],
    [1, "Chapter 4 Heat", 10],
]


def _book():
    return [
        _block("Chapter 1 Motion", 1, 2),
        _body(1),
        _block("1.1 Speed", 2, 4),
        _body(2),
        _block("Chapter 2 Forces", 4, 2),
        _body(4),
        _block("2.1 Mass", 5, 2),  # typed as large as its chapter
        _body(5),
        _block("Chapter 3 Energy", 7, 2),
        _body(7),
        _block("Key Terms", 7, 2, y=400),  # unlisted, typed as a chapter
        _body(7, y=500),
        _block("Chapter 4 Heat", 9, 2),
        _body(9),
    ]


def test_a_listed_heading_moves_under_its_outline_parent():
    with _doc(12, _TOC) as document:
        result = ol.relevel(_book(), document)
    levels = _levels(result)
    assert levels["2.1 Mass"] == 3
    # Levels change only where the stack contradicts the outline.
    assert levels["Chapter 1 Motion"] == 2 and levels["1.1 Speed"] == 4
    # A same-level heading the outline leaves out closes the listed heading
    # before it and becomes its sibling.
    assert levels["Key Terms"] == 2
    assert [b["text"] for b in result] == [b["text"] for b in _book()]


def test_an_unlisted_heading_and_a_boundary_stay_under_a_listed_ancestor():
    blocks = _book()
    # Chapter 3 lists Key Terms: an unlisted heading and a removed banner before
    # it, typed at the chapter's level, would close chapter 3.
    at = next(i for i, b in enumerate(blocks) if b["text"] == "Key Terms")
    blocks[at:at] = [
        _block("Sidebar", 7, 2, y=150),
        {
            "type": "discarded",
            "text": "Running head",
            "page_idx": 7,
            "bbox": [100, 20, 900, 40],
            "_source_role": "running-banner",
            "_heading_boundary_level": 2,
        },
    ]
    toc = [*_TOC[:5], [2, "Key Terms", 8], _TOC[5]]
    with _doc(12, toc) as document:
        result = ol.relevel(blocks, document)
    levels = _levels(result)
    assert levels["Sidebar"] == 3 and levels["Key Terms"] == 3
    assert [
        b.get("_heading_boundary_level") for b in result if b["type"] == "discarded"
    ] == [3]


def test_front_matter_closes_at_a_top_level_entry_but_a_part_stays_above():
    with _doc(12, _TOC) as document:
        front = ol.relevel([_block("A Physics Book", 0, 1), *_book()], document)
        part = ol.relevel([_block("Part 1 Foundations", 0, 1), *_book()], document)
    assert _levels(front)["A Physics Book"] == 1
    assert _levels(front)["Chapter 1 Motion"] == 1
    assert _levels(front)["1.1 Speed"] == 3  # carried with its chapter
    assert _levels(part)["Part 1 Foundations"] == 1
    assert _levels(part)["Chapter 1 Motion"] == 2


def test_a_heading_numbered_as_the_listed_peer_is_not_held():
    # BCcampus: the outline leaves out "4. Images"; it is chapter 3's peer.
    toc = [
        [1, "1. Intro", 1],
        [1, "2. Text", 3],
        [1, "3. Organizing Content", 5],
        [2, "Headings", 6],
        [1, "5. Tables", 9],
    ]
    blocks = [
        _block("1. Intro", 0, 2),
        _body(0),
        _block("2. Text", 2, 2),
        _body(2),
        _block("3. Organizing Content", 4, 2),
        _block("Headings", 5, 3),
        _body(5),
        _block("4. Images", 6, 2),
        _block("What are images?", 6, 3, y=200),
        _body(6),
        _block("5. Tables", 8, 2),
        _body(8),
    ]
    with _doc(10, toc) as document:
        result = ol.relevel(blocks, document)
    assert _levels(result)["4. Images"] == 2
    assert _levels(result)["What are images?"] == 3


def test_a_usable_outline_takes_outline_levels_instead_of_the_backbone():
    # Headings that agree with the outline stay, where the backbone would put
    # the chapters at level 1 and their sections at 2.
    toc = [[1, "Chapter 1 Motion", 2], [2, "1.1 Speed", 3]]
    toc += [[1, "Chapter 2 Forces", 21], [2, "2.1 Mass", 22], [1, "Chapter 3 Heat", 41]]
    blocks = [
        _block("Chapter 1 Motion", 1, 2),
        _block("1.1 Speed", 2, 4),
        _body(2),
        _block("Chapter 2 Forces", 20, 2),
        _block("2.1 Mass", 21, 4),
        _body(21),
        _block("Chapter 3 Heat", 40, 2),
        _body(40),
    ]
    with _doc(60, toc) as document:
        assert ol.relevel(blocks, document) == blocks


def test_outline_headings_inserted_by_v8_make_the_outline_usable():
    # College Research: chapters only in the outline and running heads, so v8
    # inserted them; the outline is then usable and the levels stay.
    blocks = [_block("Algorithms", 1, 1)]
    toc = [[1, "Algorithms", 2]]
    for number, page in enumerate([3, 10, 20, 30, 40], start=1):
        title = f"Chapter {number} Topic {number}"
        toc.append([2, title, page + 1])
        blocks.append(_block(title, page, 2, _source_role="outline-heading"))
        blocks.append(_block(f"{number}.1 Detail", page, 4, y=200))
    with _doc(50, toc) as document:
        assert ol.relevel(blocks, document) == blocks


def test_outline_entries_drop_wrappers_bookmarks_duplicates_and_tags():
    toc = [
        [1, "Main Body", 1],  # a wrapper: its children move up a level
        [2, "Chapter 1", 1],
        [2, "Mary Author", 1],  # a tag under every chapter
        [3, "1.1 Learning Objectives", 1],
        [2, "Chapter 2", 2],
        [2, "Mary Author", 2],
        [3, "_GoBack", 2],  # a machine bookmark
        [3, "2.1 Learning Objectives", 2],
        [2, "Chapter 3", 3],
        [2, "Mary Author", 3],
        [3, "3.1 Learning Objectives", 3],
        [3, "Part A", 4],  # OECD: bookmarked again at level 1
        [1, "Part A", 4],
        [1, "Contents", 5],  # childless: the contents page itself
    ]
    with _doc(5, toc) as document:
        entries = ol._entries(document)
    assert [(e["level"], e["title"]) for e in entries] == [
        (1, "Chapter 1"),
        (2, "1.1 Learning Objectives"),
        (1, "Chapter 2"),
        (2, "2.1 Learning Objectives"),
        (1, "Chapter 3"),
        (2, "3.1 Learning Objectives"),
        (1, "Part A"),
        (1, "Contents"),
    ]


def test_matching_skips_running_heads_and_takes_out_of_order_entries():
    blocks = [_block(f"{n} • Exercises {500 + n}", n, 3, y=30) for n in range(3)] + [
        _block("18.5 Capacitors and Dielectrics", 4, 3),
        _block("Health Insurance &", 5, 3),
        _block("Reimbursement", 5, 3, y=300),
    ]
    entries = [
        {"level": 1, "title": "Exercises", "page": 1, "y": None},
        {"level": 1, "title": "18.5 Capacitors and Dielectrics", "page": 5, "y": None},
        {"level": 1, "title": "Reimbursement", "page": 6, "y": None},
        {"level": 1, "title": "Health Insurance &", "page": 6, "y": None},
    ]
    matched = ol._match(blocks, entries)
    assert 0 not in matched  # a running head never matches
    assert matched[1] == 3 and matched[2] == 5 and matched[3] == 4


def test_an_unmatched_entry_starts_no_earlier_than_the_entry_before_it():
    blocks = [_block("The discovered", 0, 2), _body(0), _body(0, y=500)]
    entries = [
        {"level": 1, "title": "The discovered", "page": 1, "y": None},
        {"level": 1, "title": "The undiscovered", "page": 1, "y": None},
    ]
    positions = ol._positions(blocks, entries, {0: 0}, [0, 1])
    assert positions == {0: 0, 1: 1}


def test_a_title_split_over_two_bookmarks_reads_as_one():
    toc = [[1, "Health Insurance &", 2], [1, "Reimbursement", 2], [1, "Index", 4]]
    toc += [[1, "Glossary", 5], [1, "Notes", 6]]
    blocks = [
        _block("Health Insurance &", 1, 2),
        _block("Reimbursement", 1, 2, y=130),
        _body(1),
        _block("Index", 3, 2),
        _body(3),
        _block("Glossary", 4, 2),
        _block("Notes", 5, 2),
    ]
    with _doc(7, toc) as document:
        listed = ol._listing(blocks, document)
    assert listed[1]["parent_block"] == 0 and listed[0]["end"] == 3


@pytest.mark.parametrize(
    ("title", "child_level", "broken"),
    [
        ("Version 0.5", 1, True),  # Compressible Flow's change log holds every chapter
        ("Ackowledgements", 2, True),  # Message Processing
        ("Best Practices", 3, False),  # BCcampus: a real grouping
    ],
)
def test_broken_outlines_are_vetoed(title, child_level, broken):
    entries = [{"level": 1, "title": title, "page": 1, "y": None}]
    entries += [
        {"level": 2, "title": f"Chapter {n}", "page": 2 + 3 * n, "y": None}
        for n in range(1, 6)
    ]
    blocks = [_block(title, 0, 2)]
    blocks += [_block(f"Chapter {n}", 1 + 3 * n, child_level) for n in range(1, 6)]
    matched = {k: k for k in range(6)}
    assert ol._broken(blocks, entries, matched, 20) is broken


_TOPICS = ["Motion", "Forces", "Energy", "Heat"]


def _chapters():
    blocks = []
    for n, topic in enumerate(_TOPICS, start=1):
        blocks += [_block(f"Chapter {n} {topic}", 2 + 10 * n, 3), _body(2 + 10 * n)]
        blocks += [_block(f"{n}.1 Detail", 3 + 10 * n, 5), _body(3 + 10 * n)]
    return blocks


def test_books_without_a_usable_outline_take_the_chapter_backbone():
    with _doc(60) as document:
        result = ol.relevel(_chapters(), document)
    assert _levels(result)["Chapter 1 Motion"] == 1
    assert _levels(result)["1.1 Detail"] == 2


def test_a_vetoed_outline_falls_back_to_the_backbone():
    toc = [[1, "Version 0.5", 1]]
    toc += [[2, f"Chapter {n} {t}", 3 + 10 * n] for n, t in enumerate(_TOPICS, start=1)]
    blocks = [_block("Version 0.5", 0, 4), *_chapters()]  # its chapters typed larger
    with _doc(60, toc) as document:
        result = ol.relevel(blocks, document)
    assert _levels(result)["Chapter 1 Motion"] == 1
    assert _levels(result)["1.1 Detail"] == 2


# ------------------------------------------------------------------ book titles


def _roles(blocks):
    return {b["text"]: b.get("_source_role") for b in blocks}


def test_title_and_author_lines_are_marked_book_title():
    # Papuan Malay: the metadata title, its title page and the author below it;
    # the Unicode Cookbook sets a subtitle as body text between them.
    blocks = [
        _block("A grammar of Papuan Malay", 0, 1),
        _block("A subtitle set as body text", 0, y=200),
        _block("Angela Kluge", 0, 2, y=300),
        _block("Chapter 1 Introduction", 3, 1),
        _body(3, chars=400),
    ]
    with _doc(10, title="A grammar of Papuan Malay") as document:
        result = ol.mark_book_titles(blocks, document)
    assert _roles(result)["A grammar of Papuan Malay"] == "book-title"
    assert _roles(result)["Angela Kluge"] == "book-title"
    assert result[0]["text_level"] == 1  # the level stays for the chunker
    assert _roles(result)["Chapter 1 Introduction"] is None


def test_repeated_title_pages_and_a_subtitle_between_them_are_marked():
    blocks = [
        _block("Intermediate Financial Accounting", 0, 1),
        _block("with Open Texts", 0, 2, y=200),
        _block("Intermediate Financial Accounting", 4, 1),
        _block("Volume 1", 4, 3, y=200),
        _block("Intermediate Financial Accounting", 6, 1),
        _block("1 Introduction", 6, 2, y=300),  # a numbered chapter stays
        _block("Preface", 8, 1),
        _body(8, chars=400),
    ]
    with _doc(20, title="Intermediate Financial Accounting") as document:
        roles = [b.get("_source_role") for b in ol.mark_book_titles(blocks, document)]
    assert roles[:5] == ["book-title"] * 5
    assert roles[5:] == [None] * 3


def test_title_pages_run_past_pages_with_body_text():
    # ReStorying: the title is printed again on its introduction page, after the
    # licence page; "INTRODUCTION" there goes with it (accepted).
    blocks = [
        _block("ReStorying Education", 0, 4),
        _block("YOU ARE FREE TO:", 3, 5),
        _body(3, chars=600),
        _block("Contents", 4, 1),  # the outline lists it under another title
        _body(4),
        _block("ReStorying Education in the United States", 6, 1),
        _block("INTRODUCTION", 6, 5, y=200),
        _body(6, chars=1900),
        _block("REFERENCES", 8, 5),
    ]
    toc = [[1, "Contents", 5], [1, "Chapter 1", 10]]
    with _doc(12, toc, title="ReStorying Education") as document:
        roles = [b.get("_source_role") for b in ol.mark_book_titles(blocks, document)]
    title = "book-title"
    assert roles == [title, title, None, None, None, title, title, None, None]


def test_a_title_page_heading_that_roots_the_book_is_the_title():
    blocks = [_block("Untitled Works", 0, 1), _block("Section one", 1, 2)]
    blocks += [_body(p, chars=400) for p in range(1, 5)]
    with _doc(10) as document:
        roles = [b.get("_source_role") for b in ol.mark_book_titles(blocks, document)]
    assert roles[0] == "book-title" and roles[1] is None
