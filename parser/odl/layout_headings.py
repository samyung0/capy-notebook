"""Headings recalled from the document's own heading styles.

ODL reads many headings as paragraphs or list items: a bold "Introduction" set
in the body size, a larger "Water Supply Systems" it took for body text, a
heading run into the paragraph before or after it. Instead of a trained
line-role model this stage measures each document's own conventions:

- a style census (size, weight, capitals, colour) over the document's lines,
  by characters: the body style carries the most, and the body line gap is the
  usual space between two body lines of one paragraph;
- a heading style is rarer than body and larger, or as large and heavier, in
  capitals or in another colour (those two only with section numbering);
- a heading is a short standalone run of rows in such a style: at most three
  rows and ``MAX_WORDS`` words, alone on its row (a bare section number before
  it joins it), not ending or breaking like a sentence, below a gap larger than
  the body line gap (or at the top of its column), and not a running head,
  caption, formula, code, bullet, number, label of a picture or vector figure,
  contents entry, or the first line of a paragraph that fills its column.

A ``text`` block whose source lines are all heading lines becomes a heading
(``_source_role: "layout-heading"``); one with heading lines among body lines
splits into headings and paragraphs, and a list splits before each item that
opens with a heading. Blocks an earlier stage gave a role are left alone.
Levels come from the parser's own headings in the same style, else from
section numbering depth, else from the style's rank among the heading styles.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter, defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import cache
from itertools import pairwise

import pymupdf

from . import page_text
from .list_headings import _compact
from .pictures import _figure_clusters

MAX_WORDS = 16
MAX_RUN_ROWS = 3
CENSUS_PAGES = 300  # pages read for the style census, spread over the book
RARE = 0.25  # a heading style carries at most this share of the body's characters
LEADS_NEAR = (
    60  # points: a heading this close to a drawing cluster must lead into body text
)
FIGURE_REACH = 20  # points: how far a figure's labels may sit from its drawing
DENSE = 4  # accepted headings on a page with no more body rows: a contents page
BAND = 0.15  # top and bottom page fraction where running heads live

# Section numbering at the start of a heading, and a bare number set apart
# from its title on the same row.
NUMBERED = re.compile(
    r"^(?:§\s*|(?:chapter|section|part|appendix|unit|lesson|module)\s+)?"
    r"(?:\d{1,3}(?:\.\d{1,3})*|[A-Z]|[IVXLC]{1,6})(?:[.:)]|\s|$)",
    re.IGNORECASE,
)
BARE_NUMBER = re.compile(r"^(?:§\s*)?(?:\d{1,3}(?:\.\d{1,3})*|[A-Z]|[IVXLC]{1,6})\.?$")
BULLET = re.compile(r"^\s*(?:[•●▪◦‣⁃∙·■□☐➢➤✓✔\-–—*]|\(?[a-z0-9]{1,2}\))\s")
CAPTION = re.compile(
    r"^(?:fig(?:ure)?|table|tab|exhibit|chart|listing|plate|map|diagram|photo"
    r"|image|scheme|box|equation|eq)\.?\s*[\dIVX]+[\w.\-]*[.:\s]"
    r"|^(?:source|note|notes|credit)s?:",
    re.IGNORECASE,
)
SENTENCE_END = re.compile(r"[.,;:!][\"'”’)\]]*$")
RUN_IN = re.compile(
    r"[^\W\d_]{3,}[.!?]\s+\S"
)  # "Activity 3.4 Expected value. Use the…"
BOLD_FONT = re.compile(
    r"bold|black|heavy|cmbx|demi|semibold|medi|[-_,](?:b|bd|sb)$", re.IGNORECASE
)
MATH_FONT = re.compile(
    r"cmmi|cmsy|cmex|math|symbol|stix|mtextra|euclid|msbm|msam|txsy|txmi",
    re.IGNORECASE,
)
MONO_FONT = re.compile(
    r"mono|courier|consol|cmtt|menlo|inconsolata|typewriter|sftt", re.IGNORECASE
)
CONTENTS_TITLE = re.compile(r"^(?:table of )?contents$|^brief contents$", re.IGNORECASE)
PAGE_REF = re.compile(r"\s\d{1,4}$")
OPERATORS = set("=+−×÷<>±≤≥∑∫√∞≈≠^∂∆∇∈∪∩→⇒")

Style = tuple[float, int, bool, int]  # size (half points), weight, capitals, colour


@dataclass
class Census:
    body: Style
    gap: float  # median space between two body lines of one paragraph
    ranks: dict[Style, int]  # heading style -> 1-based rank by size, then weight


def _weight(span: dict) -> int:
    """2 for a bold flag or a heavy font name (CMBX, -Medium, _B), else 1."""
    return 2 if span["flags"] & 16 or _heavy(span["font"]) else 1


@cache
def _heavy(font: str) -> bool:
    return bool(BOLD_FONT.search(font.split("+")[-1]))


def _style(spans: list[dict]) -> Style:
    """The style of the span carrying the most characters; capitals when every
    letter of the line is upper case."""
    main = max(spans, key=lambda s: len(s["text"].strip()))
    letters = [c for s in spans for c in s["text"] if c.isalpha()]
    caps = len(letters) >= 3 and all(c.isupper() for c in letters)
    colour = main["color"]
    return (
        round(main["size"] * 2) / 2,
        _weight(main),
        caps,
        0 if _dark(colour) else colour,
    )


def _lines(page: pymupdf.Page) -> list[dict]:
    """The page's non-empty source lines in ``page_dict`` order, each with its
    text, visible spans, style and source group; the bench's line labels use
    the same order."""
    out = []
    for group in page_text.page_dict(page)["blocks"]:
        for line in group.get("lines", []):
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            out.append(
                {
                    "text": " ".join("".join(s["text"] for s in line["spans"]).split()),
                    "spans": spans,
                    "rect": pymupdf.Rect(line["bbox"]),
                    "centre": (
                        (line["bbox"][0] + line["bbox"][2]) / 2,
                        (line["bbox"][1] + line["bbox"][3]) / 2,
                    ),
                    "horizontal": abs(line["dir"][0] - 1) < 0.01,
                    "style": _style(spans),
                    "group": id(group),
                    "group_x1": group["bbox"][2],
                    # a paragraph: three lines or more, fifteen ems wide or more
                    "paragraph": len(group["lines"]) >= 3
                    and group["bbox"][2] - group["bbox"][0]
                    >= 15 * line["spans"][0]["size"],
                }
            )
    return out


def census(document: pymupdf.Document) -> Census:
    chars: Counter = Counter()
    gaps: defaultdict[Style, list[float]] = defaultdict(list)
    step = max(1, len(document) // CENSUS_PAGES)
    for page in document.pages(0, len(document), step):
        for group in page_text.page_dict(page)["blocks"]:
            previous = None  # style and box of the group's previous line
            for line in group.get("lines", []):
                spans = [s for s in line["spans"] if s["text"].strip()]
                if not spans or abs(line["dir"][0] - 1) >= 0.01:
                    continue
                style, (_, y0, _, y1) = _style(spans), line["bbox"]
                chars[style] += sum(len(s["text"].strip()) for s in spans)
                if (
                    previous
                    and previous[0] == style
                    and y0 > (previous[1] + previous[2]) / 2
                ):
                    gaps[style].append(y0 - previous[2])
                previous = style, y0, y1
    body = max(chars, key=chars.get) if chars else (0.0, 1, False, 0)
    gap = statistics.median(gaps[body]) if gaps[body] else 2.0
    heading = sorted(
        (s for s in chars if _heading_style(s, body, chars)),
        key=lambda s: (-s[0], -s[1], not s[2]),
    )
    return Census(body, gap, {s: i + 1 for i, s in enumerate(heading)})


def _heading_style(style: Style, body: Style, chars: Counter) -> bool:
    """Rarer than body, and larger, or as large and heavier, in capitals or in
    another colour."""
    size, weight, caps, colour = style
    if chars[style] > RARE * chars[body]:
        return False
    if size >= body[0] + 1:
        return True
    return size >= body[0] - 0.5 and (weight > body[1] or caps or colour != body[3])


def _overlap(a: pymupdf.Rect, b: pymupdf.Rect) -> bool:
    """On one row: vertical overlap of at least half the smaller height."""
    return min(a.y1, b.y1) - max(a.y0, b.y0) >= 0.5 * min(a.height, b.height)


def _rows(lines: list[dict], facts: Census) -> list[dict]:
    """Lines on one baseline joined left to right when they nearly touch or the
    left one is a bare section number. A row's style is its longest line's;
    ``uniform`` is the share of its characters set in that size and weight (a
    bold run-in label before body text is not uniform)."""
    em = facts.body[0]
    bands: list[list[dict]] = []
    for line in sorted(lines, key=lambda line: line["rect"].y0 + line["rect"].y1):
        if bands and _overlap(bands[-1][0]["rect"], line["rect"]):
            bands[-1].append(line)
        else:
            bands.append([line])
    rows: list[dict] = []
    for band in bands:
        last = None
        for line in sorted(band, key=lambda line: line["rect"].x0):
            gap = line["rect"].x0 - last["rect"].x1 if last else -1
            if (
                last
                and -1 <= gap
                and (
                    gap < 0.5 * em or (gap < 4 * em and BARE_NUMBER.match(last["text"]))
                )
            ):
                last["lines"].append(line)
                last["rect"] = last["rect"] | line["rect"]
                last["text"] += " " + line["text"]
            else:
                last = {
                    "lines": [line],
                    "rect": pymupdf.Rect(line["rect"]),
                    "text": line["text"],
                }
                rows.append(last)
    for row in rows:
        spans = [s for line in row["lines"] for s in line["spans"]]
        main = max(row["lines"], key=lambda line: len(line["text"]))
        for key in ("style", "group", "group_x1", "paragraph"):
            row[key] = main[key]
        size, weight = main["style"][:2]
        same = sum(
            len(s["text"].strip())
            for s in spans
            if round(s["size"] * 2) / 2 == size and _weight(s) == weight
        )
        row["uniform"] = same / max(1, sum(len(s["text"].strip()) for s in spans))
    return rows


def _runs(rows: list[dict], facts: Census) -> list[list[dict]]:
    """Rows of one style below each other within the body line gap, sharing
    some width: a heading that wraps is one run. Each row also learns the next
    row of its source group (``row["next"]``)."""
    groups: defaultdict[int, list[dict]] = defaultdict(list)
    for row in rows:
        groups[row["group"]].append(row)
    for group in groups.values():
        group.sort(key=lambda row: row["rect"].y0)
        for row, below in pairwise(group):
            row["next"] = below
    runs: list[list[dict]] = []
    for row in sorted(rows, key=lambda row: row["rect"].y0):
        box = row["rect"]
        run = next(
            (
                run
                for run in reversed(runs)
                if run[-1]["style"] == row["style"]
                and 0 <= box.y0 - run[-1]["rect"].y1 <= facts.gap + 0.5 * box.height
                and min(box.x1, run[-1]["rect"].x1) > max(box.x0, run[-1]["rect"].x0)
            ),
            None,
        )
        if run:
            run.append(row)
        else:
            runs.append([row])
    return runs


def _plain(text: str, row: dict) -> str | None:
    """Why a run's text is not a heading's: a number, a caption, a bullet, a
    formula or code."""
    letters = sum(c.isalpha() for c in text)
    fonts = " ".join(s["font"] for line in row["lines"] for s in line["spans"])
    if letters < 3 or letters < 0.5 * len(text.replace(" ", "")):
        return "number"
    if text[0].islower():
        return "lower"
    if CAPTION.match(text) or BULLET.match(text):
        return "caption-or-bullet"
    if text[0] in "([" or re.search(r":\s+\S", text):
        return "aside-or-run-in"  # "[1 mark]", "(Anno Domini…)", "A note: The…"
    if "=" in text or sum(c in OPERATORS for c in text) >= 2 or MATH_FONT.search(fonts):
        return "formula"
    if MONO_FONT.search(fonts):
        return "code"
    return None


def _contents(rows: list[dict]) -> bool:
    """A printed contents or index page: titled so, or many rows end in a page
    number."""
    if any(CONTENTS_TITLE.match(row["text"]) for row in rows):
        return True
    ending = sum(
        bool(PAGE_REF.search(row["text"])) and any(c.isalpha() for c in row["text"])
        for row in rows
    )
    return ending >= max(5, 0.3 * len(rows))


def heading_lines(
    page: pymupdf.Page,
    facts: Census,
    running: set[str],
    lines: list[dict],
    images: Sequence[pymupdf.Rect] = (),
) -> list[bool]:
    """Whether each of ``lines`` (``_lines(page)``) is part of a heading.
    ``images`` are the parser's image and figure blocks on the page."""
    flags = [False] * len(lines)
    index = {id(line): i for i, line in enumerate(lines)}
    for run, reason in classify(page, facts, running, lines, images):
        if reason is None:
            for row in run:
                for line in row["lines"]:
                    flags[index[id(line)]] = True
    return flags


def classify(
    page: pymupdf.Page,
    facts: Census,
    running: set[str],
    lines: list[dict],
    images: Sequence[pymupdf.Rect] = (),
) -> list[tuple[list[dict], str | None]]:
    """Every run of rows on the page with the reason it is not a heading, or
    None for a heading."""
    rows = _rows([line for line in lines if line["horizontal"]], facts)
    if _contents(rows):
        return [([row], "contents") for row in rows]
    area = abs(page.rect)
    # Read once a run gets that far; a full-page image is a background.
    pictures = cache(
        lambda: (
            [
                r
                for i in page.get_image_info()
                if abs(r := pymupdf.Rect(i["bbox"])) < 0.5 * area
            ]
            + [r for r in images if abs(r) < 0.5 * area]
        )
    )
    figures = cache(
        lambda: [r for r, segments, _ in _figure_clusters(page) if segments >= 12]
    )
    out = [
        (run, _reason(run, rows, page, facts, running, pictures, figures))
        for run in _runs(rows, facts)
    ]
    # A page of headings and little else is a contents page, a cover or a
    # list of names, not sections.
    found = [run for run, reason in out if reason is None]
    body = sum(row["style"] == facts.body for row in rows)
    if len(found) >= DENSE and len(found) >= body:
        out = [(run, "dense" if reason is None else reason) for run, reason in out]
    return out


def _reason(
    run: list[dict],
    rows: list[dict],
    page: pymupdf.Page,
    facts: Census,
    running: set[str],
    pictures: Callable[[], list[pymupdf.Rect]],
    figures: Callable[[], list[pymupdf.Rect]],
) -> str | None:
    first, last = run[0], run[-1]
    size, weight, _, colour = first["style"]
    em = facts.body[0]
    text = " ".join(row["text"] for row in run)
    if first["style"] not in facts.ranks:
        return "style"
    if len(run) > MAX_RUN_ROWS or len(text.split()) > MAX_WORDS:
        return "long"
    if any(row["uniform"] < 0.8 for row in run):
        return "mixed"
    if SENTENCE_END.search(text):
        return "sentence"
    if RUN_IN.search(NUMBERED.sub("", text, count=1)):
        return "run-in"
    if plain := _plain(text, first):
        return plain
    # Capitals or colour alone mark a heading only with section numbering.
    emphasis_only = weight <= facts.body[1] and size < facts.body[0] + 1
    if emphasis_only and not NUMBERED.match(text):
        return "caps"
    if _light(colour) and size < facts.body[0] + 1:
        return "light"
    # In a page band: a running head repeats, sits beside a page number, or is
    # set apart by capitals or colour alone.
    height = page.rect.height
    band = first["rect"].y1 < BAND * height or first["rect"].y0 > (1 - BAND) * height
    if band and (_exact(text) in running or _folio(first, rows) or emphasis_only):
        return "running"
    if any(_crowded(row, rows, facts) for row in run):
        return "crowded"
    if any(_inside_picture(row["rect"], pictures()) for row in run):
        return "picture"
    if any(_drawn(row["rect"], figures(), FIGURE_REACH) for row in run):
        return "figure"
    if not _spaced(first, rows, facts):
        return "tight"
    # Near a drawing a heading must lead into body text, which a figure's
    # label does not.
    near = any(_drawn(row["rect"], figures(), LEADS_NEAR) for row in run)
    if near and not _leads(last, rows, facts):
        return "alone"
    # The first line of a paragraph that fills its column, the next line close below.
    follower = last.get("next")
    if (
        follower
        and follower["style"] not in facts.ranks
        and follower["rect"].y0 - last["rect"].y1 <= facts.gap + 0.4 * em
        and last["rect"].x1 >= last["group_x1"] - em
    ):
        return "continues"
    return None


def _crowded(row: dict, rows: list[dict], facts: Census) -> bool:
    """Other text shares the row: a cell within a few ems, two or more cells
    anywhere, or a cell in the same style (a table's header row, a figure's
    labels). Body text an em away in the next column does not count beside a
    larger heading, or when it is a paragraph."""
    box, em = row["rect"], facts.body[0]
    larger = row["style"][0] >= facts.body[0] + 1
    beside = [
        other
        for other in rows
        if other is not row
        and _overlap(box, other["rect"])
        and not (
            (larger or other["paragraph"])
            and other["style"] == facts.body
            and (other["rect"].x0 - box.x1 >= em or box.x0 - other["rect"].x1 >= em)
        )
    ]
    return len(beside) >= 2 or any(
        other["style"] == row["style"]
        or (other["rect"].x0 - box.x1 < 3 * em and box.x0 - other["rect"].x1 < 3 * em)
        for other in beside
    )


def _inside_picture(box: pymupdf.Rect, pictures: list[pymupdf.Rect]) -> bool:
    centre = (box.tl + box.br) / 2
    return any(p.contains(centre) for p in pictures)


def _leads(row: dict, rows: list[dict], facts: Census) -> bool:
    """The nearest row below in the row's column is body text, within three
    ems."""
    box = row["rect"]
    below = [
        o
        for o in rows
        if o["rect"].y0 >= box.y1 - 1
        and min(box.x1, o["rect"].x1) > max(box.x0, o["rect"].x0)
    ]
    if not below:
        return False
    nearest = min(below, key=lambda o: o["rect"].y0)
    if nearest["rect"].y0 - box.y1 > 3 * facts.body[0]:
        return False
    return nearest["style"] == facts.body


def _drawn(box: pymupdf.Rect, figures: list[pymupdf.Rect], reach: float) -> bool:
    """A label of a vector figure: its centre within ``reach`` of a drawing
    cluster of a dozen segments or more (a heading's rule or frame has a few)."""
    centre = (box.tl + box.br) / 2
    return any((f + (-reach, -reach, reach, reach)).contains(centre) for f in figures)


def _folio(row: dict, rows: list[dict]) -> bool:
    """A band row beside a page number, or holding one at either end."""
    if re.match(r"^\d{1,4}\s|\s\d{1,4}$", row["text"]):
        return True
    return any(
        other is not row
        and _overlap(row["rect"], other["rect"])
        and re.fullmatch(r"\d{1,4}", other["text"])
        for other in rows
    )


def _luma(colour: int) -> float:
    return (
        0.299 * (colour >> 16 & 255)
        + 0.587 * (colour >> 8 & 255)
        + 0.114 * (colour & 255)
    )


def _light(colour: int) -> bool:
    """Near-white text: set on a filled table header or banner."""
    return _luma(colour) > 200


def _dark(colour: int) -> bool:
    """Near-black text (InDesign's 0x231F20) counts as black."""
    return _luma(colour) < 60


def _spaced(row: dict, rows: list[dict], facts: Census) -> bool:
    """More space above than between two body lines, or nothing above in the
    row's column."""
    box = row["rect"]
    above = [
        o["rect"].y1
        for o in rows
        if o["rect"].y1 <= box.y0 + 1
        and min(box.x1, o["rect"].x1) > max(box.x0, o["rect"].x0)
    ]
    return not above or box.y0 - max(above) > facts.gap + 0.4 * facts.body[0]


def _exact(text: str) -> str:
    return "".join(text.casefold().split())


def _running(blocks: list[dict]) -> set[str]:
    """Running heads in a page band: the same text on three pages or more, or
    a text whose number follows the page number ("Chapter 2 | 47" on page 47,
    "Chapter 2 | 48" on page 48) on three pages or more. A numbered heading
    near the top ("Practice Problems 2.3") does neither."""
    pages: defaultdict[str, set[int]] = defaultdict(set)
    offsets: defaultdict[tuple[str, int], set[str]] = defaultdict(set)
    for block in blocks:
        box, page = block.get("bbox") or [], block.get("page_idx")
        if len(box) != 4 or type(page) is not int:
            continue
        if not (box[3] < BAND * 1000 or box[1] > (1 - BAND) * 1000):
            continue
        text = block.get("text") or " ".join(map(str, block.get("list_items") or []))
        exact = _exact(str(text))
        pages[exact].add(page)
        if numbers := re.findall(r"\d+", exact):
            folded = re.sub(r"\d+", "#", exact)
            # The folio is the last number of a head, or the first of a foot.
            for number in {numbers[0], numbers[-1]}:
                offsets[folded, int(number) - page].add(exact)
    running = {exact for exact, seen in pages.items() if len(seen) >= 3}
    for texts in offsets.values():
        if len(texts) >= 3:
            running |= texts
    return running


def recall_headings(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    facts = census(document)
    running = _running(blocks)
    images: defaultdict[int, list[pymupdf.Rect]] = defaultdict(list)
    for block in blocks:
        if block.get("type") == "image" and len(block.get("bbox") or []) == 4:
            page = document[block["page_idx"]].rect
            x0, y0, x1, y1 = block["bbox"]
            images[block["page_idx"]].append(
                pymupdf.Rect(x0, y0, x1, y1)
                * pymupdf.Matrix(page.width / 1000, page.height / 1000)
            )
    # One read per page: the styles of the parser's own headings (for levels)
    # and the heading lines; only pages with heading lines keep their lines.
    # Title and front pages before the parser's first heading are left alone:
    # their title, edition and author lines are set like headings.
    first = min(
        (
            b["page_idx"]
            for b in blocks
            if isinstance(b.get("text_level"), int) and type(b.get("page_idx")) is int
        ),
        default=0,
    )
    seen: defaultdict[Style, Counter] = defaultdict(Counter)
    kept: dict[int, tuple[list[dict], list[bool]]] = {}
    current: tuple[int, list[dict], list[bool] | None] = (-1, [], None)
    for block in blocks:
        page_index = block.get("page_idx")
        level = block.get("text_level")
        heading = isinstance(level, int) and level > 0 and type(page_index) is int
        if not heading and (not _eligible(block, document) or page_index < first):
            continue
        page = document[page_index]
        if current[0] != page_index:
            current = (page_index, _lines(page), None)
        _, lines, flags = current
        if heading:
            for i in _inside(block, page, lines)[:1]:
                seen[lines[i]["style"]][level] += 1
            continue
        if flags is None:
            flags = heading_lines(page, facts, running, lines, images[page_index])
            current = (page_index, lines, flags)
            if any(flags):
                kept[page_index] = (lines, flags)
    levels = {style: count.most_common(1)[0][0] for style, count in seen.items()}
    out: list[dict] = []
    for block in blocks:
        page_index = block.get("page_idx")
        if page_index not in kept or not _eligible(block, document):
            out.append(block)
            continue
        page = document[page_index]
        lines, flags = kept[page_index]
        if block["type"] == "list":
            out.extend(_split_list(block, page, lines, flags, facts, levels))
        else:
            out.extend(_promote(block, page, lines, flags, facts, levels))
    return out


def _eligible(block: dict, document: pymupdf.Document) -> bool:
    """A paragraph or list no earlier stage gave a heading level or a role."""
    page_index = block.get("page_idx")
    return not (
        block.get("type") not in ("text", "list")
        or block.get("text_level")
        or block.get("_source_role")
        or block.get("_native_type") == "caption"
        or len(block.get("bbox") or []) != 4
        or type(page_index) is not int
        or document[page_index].rotation
    )


def _inside(block: dict, page: pymupdf.Page, lines: list[dict]) -> list[int]:
    """Indexes of the horizontal source lines centred in the block, top down."""
    w, h = page.rect.width / 1000, page.rect.height / 1000
    x0, y0, x1, y1 = (v * s for v, s in zip(block["bbox"], (w, h, w, h)))
    inside = [
        i
        for i, line in enumerate(lines)
        if line["horizontal"]
        and x0 <= line["centre"][0] <= x1
        and y0 <= line["centre"][1] <= y1
    ]
    return sorted(inside, key=lambda i: (lines[i]["rect"].y1, lines[i]["rect"].x0))


def _promote(
    block: dict,
    page: pymupdf.Page,
    lines: list[dict],
    flags: list[bool],
    facts: Census,
    levels: dict,
) -> list[dict]:
    """The block as a heading when all its lines are heading lines; else split
    at its heading runs (a heading ODL ran into the paragraph before or after
    it) into headings and paragraphs, found in the block text in order. A
    heading the text does not spell leaves the block whole."""
    inside = _inside(block, page, lines)
    if not any(flags[i] for i in inside):
        return [block]
    if all(flags[i] for i in inside):
        text = " ".join(lines[i]["text"] for i in inside)
        level = _level(text, lines[inside[0]]["style"], facts, levels)
        return [{**block, "text_level": level, "_source_role": "layout-heading"}]
    heads = _heads(inside, lines, flags)
    source = str(block.get("text") or "")
    compact, where = _compact(source)
    w, h = page.rect.width / 1000, page.rect.height / 1000
    x0, y0, x1, y1 = block["bbox"]
    pieces: list[dict] = []
    cursor, top = 0, y0  # characters of ``source`` and the page height placed so far

    def paragraph(end: int, bottom: float) -> None:
        if text := " ".join(source[cursor:end].split()):
            pieces.append({**block, "text": text, "bbox": [x0, top, x1, bottom]})

    for head in heads:
        text = " ".join(line["text"] for line in head)
        needle, _ = _compact(text)
        start = compact.find(needle, len(_compact(source[:cursor])[0]))
        if not needle or start < 0:
            return [block]
        begin, end = where[start], where[start + len(needle) - 1] + 1
        upper, lower = head[0]["rect"].y0 / h, max(l["rect"].y1 for l in head) / h
        paragraph(begin, upper)
        level = _level(text, head[0]["style"], facts, levels)
        box = [
            min(l["rect"].x0 for l in head) / w,
            upper,
            max(l["rect"].x1 for l in head) / w,
            lower,
        ]
        pieces.append(
            {
                **block,
                "text": " ".join(source[begin:end].split()),
                "text_level": level,
                "bbox": box,
                "_source_role": "layout-heading",
            }
        )
        cursor, top = end, lower
    paragraph(len(source), y1)
    return pieces


def _heads(inside: list[int], lines: list[dict], flags: list[bool]) -> list[list[dict]]:
    """The block's runs of consecutive heading lines, top down."""
    heads: list[list[dict]] = []
    for previous, i in zip([None, *inside], inside):
        if flags[i]:
            if previous is None or not flags[previous]:
                heads.append([])
            heads[-1].append(lines[i])
    return heads


def _split_list(
    block: dict,
    page: pymupdf.Page,
    lines: list[dict],
    flags: list[bool],
    facts: Census,
    levels: dict,
) -> list[dict]:
    """A list split before each item that opens with heading lines ("Task A.
    Preflight Assessment" then the task's items): the heading, then the rest
    of that item and the items up to the next heading as a list. A heading no
    item opens with leaves the list whole."""
    inside = _inside(block, page, lines)
    heads = _heads(inside, lines, flags)
    if not heads:
        return [block]
    items = [str(item) for item in block.get("list_items") or []]
    w, h = page.rect.width / 1000, page.rect.height / 1000
    x0, y0, x1, y1 = block["bbox"]
    common = {k: v for k, v in block.items() if k not in ("list_items", "bbox", "type")}
    pieces: list[dict] = []
    pending: list[str] = []
    index, top = 0, y0

    def flush(bottom: float) -> None:
        if pending:
            pieces.append(
                {**block, "list_items": list(pending), "bbox": [x0, top, x1, bottom]}
            )
            pending.clear()

    for head in heads:
        text = " ".join(line["text"] for line in head)
        needle, _ = _compact(text)
        while index < len(items) and not _compact(items[index])[0].startswith(needle):
            pending.append(items[index])
            index += 1
        if not needle or index == len(items):
            return [block]
        _, where = _compact(items[index])
        end = where[len(needle) - 1] + 1
        upper, lower = head[0]["rect"].y0 / h, max(l["rect"].y1 for l in head) / h
        flush(upper)
        box = [
            min(l["rect"].x0 for l in head) / w,
            upper,
            max(l["rect"].x1 for l in head) / w,
            lower,
        ]
        pieces.append(
            {
                **common,
                "type": "text",
                "text": " ".join(items[index][:end].split()),
                "text_level": _level(text, head[0]["style"], facts, levels),
                "bbox": box,
                "_source_role": "layout-heading",
            }
        )
        if rest := items[index][end:].strip():
            pending.append(rest)
        index, top = index + 1, lower
    pending.extend(items[index:])
    flush(y1)
    return pieces


def _level(text: str, style: Style, facts: Census, levels: dict[Style, int]) -> int:
    if style in levels:
        return levels[style]
    if m := re.match(r"\d{1,3}((?:\.\d{1,3})+)\.?\s", text):
        return m[1].count(".") + 1
    return facts.ranks.get(style, len(facts.ranks)) + 1
