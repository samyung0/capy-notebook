"""Heading levels and fragments, after the role rules (parser v9).

Ported from the heading-levels investigation
(``bench/parsers/reports/2026-09-24-heading-levels-and-fragments.md``). Each rule
takes and returns the block list; none adds, removes or reorders a block. They
change ``text_level``, ``type`` (a chapter label becomes ``discarded``) and a
removed banner's ``_heading_boundary_level``, and set ``_source_role`` and
``_chapter_label``. Only native text headings are touched, and a heading the PDF
outline lists on its page is never demoted.

- ``demote_fragments``: formula fragments, run-in labels, numbered callout
  series, page footers and bare numbers become body text; a bare number or
  chapter label set above its title becomes that title's label.
- ``demote_contents_lines``: headings on printed contents pages become body text.
- ``backbone_levels``: a book without a usable outline is re-levelled from its
  chapter-number chain and section numbering.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from itertools import pairwise

import pymupdf


def _heading(block: dict) -> bool:
    return (
        block.get("type") == "text"
        and bool(block.get("text_level"))
        and len(block.get("bbox") or []) == 4
    )


def _text(block: dict) -> str:
    return " ".join(str(block.get("text") or "").split())


def _demote(block: dict, role: str) -> None:
    block.pop("text_level", None)
    block["_source_role"] = role


# Outline matching: label, numbering, a trailing page number, case, spacing and
# punctuation dropped.
_QUOTE_FOLD = str.maketrans(
    {"’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-"}
)
_OUTLINE_LEAD = re.compile(
    r"^(?:(?:chapter|part|appendix|section|unit|lesson|module)\s+"
    r"(?:\d{1,3}|[ivxlc]{1,6}|[a-z])\b[.:)]?|"
    r"\d{1,3}(?:\.\d{1,3})*[.:)]?|[A-Z][.:)]|[A-Z](?=\s))\s*",
    re.IGNORECASE,
)
_TRAILING_NUMBER = re.compile(r"\s+\d{1,4}$")


def _outline_key(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).translate(_QUOTE_FOLD).strip()
    text = _TRAILING_NUMBER.sub("", _OUTLINE_LEAD.sub("", text))
    return "".join(ch for ch in text.casefold() if ch.isalnum())


def _raw_key(text: str) -> str:
    return "".join(ch for ch in text.casefold() if ch.isalnum() or not ch.isascii())


def _outline_listed(blocks: list[dict], document: pymupdf.Document) -> set[int]:
    """Headings the PDF outline lists on their page."""
    toc = [(page - 1, title) for _, title, page in document.get_toc() if page > 0]
    keys = {(page, _outline_key(title)) for page, title in toc}
    keys |= {(page, _raw_key(title)) for page, title in toc}
    return {
        i
        for i, b in enumerate(blocks)
        if _heading(b)
        and (
            (b.get("page_idx"), _outline_key(_text(b))) in keys
            or (b.get("page_idx"), _raw_key(_text(b))) in keys
        )
    }


# ------------------------------------------------------------------ fragments

_MATH_SYMBOLS = set("=∫∮∑∏√≤≥<>±∓×÷−∂∇∞∈∉⊂⊃⊆⊇∪∩→←↔⇒⇐⇔↦∀∃∧∨¬⊢⊨≠≈≡∼≅∝")


def _math_letter(ch: str) -> bool:
    # Mathematical alphanumerics, letterlike symbols (ℝ ℕ ...) and Greek.
    return (
        0x1D400 <= ord(ch) <= 0x1D7FF or ch in "ℝℕℤℚℂℙℍℓℏ℘" or 0x370 <= ord(ch) <= 0x3FF
    )


def _plain_letters(text: str) -> int:
    return sum(1 for ch in text if ch.isalpha() and not _math_letter(ch))


_WORD = re.compile(r"[^\W\d_]{3,}")


def _plain_word(text: str) -> bool:
    """Holds a run of three or more ordinary (not mathematical) letters."""
    return any(_plain_letters(w) >= 3 for w in _WORD.findall(text))


_SECTION_NUMBER = re.compile(r"^\d{1,3}(?:\.\d{1,3}){1,4}\.?\s+\S")
_SINGLE_LETTER = re.compile(r"^[^\W\d_]$")  # an index or dictionary section ("A")


def _formula_fragment(text: str) -> bool:
    """No ordinary word, and a maths symbol, letter or private-use glyph, no
    letter at all, or only tokens of one or two characters. A dotted section
    number ("10.1.1 di 'at, in'") and a single letter are titles."""
    if (
        not text
        or _plain_word(text)
        or _SECTION_NUMBER.match(text)
        or _SINGLE_LETTER.match(text)
    ):
        return False
    tokens = text.split()
    return (
        _plain_letters(text) == 0
        or any(
            ch in _MATH_SYMBOLS or _math_letter(ch) or 0xE000 <= ord(ch) <= 0xF8FF
            for ch in text
        )
        or (len(tokens) >= 2 and all(len(t) <= 2 for t in tokens))
    )


_LABEL_WORDS = (
    "theorem|lemma|proposition|corollary|definition|example|exercise|remark|proof|"
    "claim|conjecture|problem|question|solution|activity|fact|observation|notation|"
    "hint|algorithm|case|step"
)
_RUN_IN_LABEL = re.compile(
    rf"^(?:{_LABEL_WORDS})\s+(?:\d+[\w.]*|[ivxlc]+|[A-Z])[.:)]?"
    r"(?:\s*\([^)]{0,80}\))?[.:]?(?:\s+\S+){0,1}$",
    re.IGNORECASE,
)
_BARE_LABEL = re.compile(rf"^(?:{_LABEL_WORDS})[.:]$", re.IGNORECASE)
_PAGE_FOOTER = re.compile(r"^page\s+\d{1,4}(?:\s+of\s+\d{1,4})?$", re.IGNORECASE)
_NUMBER_ONLY = re.compile(r"^(?:\d{1,3}\.?|[IVXLC]{2,6}\.?|[IVXLC]\.)$")
_CHAPTER_ONLY = re.compile(
    r"^(?:chapter|part|unit|module|lesson|section|book)\s+(?:\d{1,3}|[ivxlc]{1,6}|"
    r"one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[.:]?$",
    re.IGNORECASE,
)
_SERIES = re.compile(
    r"^([A-Za-z][A-Za-z’' ]{2,40}?)\s+(\d{1,3}(?:\.\d{1,3}){0,3})[.:]?(?:\s|$)"
)
_STRUCTURAL = re.compile(
    r"^(?:chapter|part|unit|module|lesson|section|appendix|book|volume|"
    r"area of operation|week|day|session|level|stage|phase|grade|year)$",
    re.IGNORECASE,
)


def _next_heading(blocks: list[dict], index: int) -> int | None:
    """The heading right after ``index`` on its page, with no body text between."""
    page = blocks[index].get("page_idx")
    for j in range(index + 1, min(index + 4, len(blocks))):
        block = blocks[j]
        if block.get("page_idx") != page:
            return None
        if _heading(block):
            return j
        if block.get("type") in ("text", "list") and _text(block):
            return None
    return None


def _callout_series(blocks: list[dict]) -> set[int]:
    """Headings of one label with three or more numbers that are dotted
    ("EXAMPLE 12.1"), restart ("Figure 1" in each chapter) or track the page (a
    running head): boxes and captions, not sections. A clean once-each run
    (Problem Set 1..10) is a section series."""
    found: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for i, b in enumerate(blocks):
        if _heading(b):
            m = _SERIES.match(_text(b))
            if m and not _STRUCTURAL.match(m[1].strip()):
                found[m[1].strip().casefold()].append((i, m[2]))
    series = set()
    for items in found.values():
        numbers = [n for _, n in items]
        restarts = max(Counter(numbers).values()) >= 2
        offsets = Counter(
            int(n) - blocks[i]["page_idx"] for i, n in items if n.isdigit()
        )
        folio = bool(offsets) and offsets.most_common(1)[0][1] >= max(
            3, 0.6 * len(items)
        )
        if len(set(numbers)) >= 3 and (
            any("." in n for n in numbers) or restarts or folio
        ):
            series.update(i for i, _ in items)
    return series


def demote_fragments(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Demote headings that are formula fragments, run-in labels, numbered
    callouts, page footers or bare numbers. A bare number or chapter label set
    above its title becomes the title's ``_chapter_label`` and is discarded."""
    out = [dict(b) for b in blocks]
    series = _callout_series(out)
    listed = _outline_listed(out, document)
    for i, b in enumerate(out):
        if not _heading(b) or i in listed:
            continue
        text = _text(b)
        if _NUMBER_ONLY.match(text) or _CHAPTER_ONLY.match(text):
            j = _next_heading(out, i)
            if j is not None and not _NUMBER_ONLY.match(_text(out[j])):
                out[j]["_chapter_label"] = text
                out[j]["text_level"] = min(out[j]["text_level"], b["text_level"])
                b["type"] = "discarded"
                _demote(b, "chapter-label")
            elif _NUMBER_ONLY.match(text):
                _demote(b, "bare-number")
            continue
        if _PAGE_FOOTER.match(text):
            _demote(b, "page-footer")
        elif i in series:
            _demote(b, "callout-series")
        elif _formula_fragment(text):
            _demote(b, "formula-fragment")
        elif _RUN_IN_LABEL.match(text) or _BARE_LABEL.match(text):
            _demote(b, "run-in-label")
    return out


# ------------------------------------------------------------------ contents

_CONTENTS_TITLE = re.compile(
    r"^(?:(?:table of )?contents|(?:brief|detailed) contents|contents at a glance|"
    r"目\s*次|⽬\s*次|目\s*录|목\s*차|inhalt(?:sverzeichnis)?|table des matières|"
    r"sommaire|índice|indice|contenido)$",
    re.IGNORECASE,
)
_TRAILING_PAGE = re.compile(r"(?:\s|\.)(?:\d{1,4}|[ivxlc]{1,6})$", re.IGNORECASE)
_LEADER = re.compile(r"\.{4,}|(?:\.\s){3,}|…{2,}")
# Matter that labels only its own pages: any later heading closes it.
_OWN_PAGES = re.compile(
    r"^(?:(?:table of )?contents|brief contents|detailed contents|contents at a glance|"
    r"目\s*次|⽬\s*次|目\s*录|목\s*차|"
    r"(?:list of )?(?:figures|tables|illustrations|abbreviations|symbols)|dedication|"
    r"copyright|(?:january|february|march|april|may|june|july|august|september|"
    r"october|november|december)\s+\d{4})[.:]?$",
    re.IGNORECASE,
)


def _contents_pages(blocks: list[dict]) -> set[int]:
    """Runs of pages from a contents title in the first fifth of the book, each
    with at least 4 lines, half of them ending in a page number or a leader."""
    lines: dict[int, list[str]] = defaultdict(list)
    titled: set[int] = set()
    for b in blocks:
        if b.get("type") not in ("text", "list") or not isinstance(
            b.get("page_idx"), int
        ):
            continue
        for item in [str(x) for x in b.get("list_items") or []] or [_text(b)]:
            item = " ".join(item.split())
            if item:
                lines[b["page_idx"]].append(item)
                if _CONTENTS_TITLE.match(item):
                    titled.add(b["page_idx"])
    pages = set()
    for page, items in lines.items():
        entries = sum(1 for t in items if _TRAILING_PAGE.search(t) or _LEADER.search(t))
        if entries >= 4 and entries >= 0.5 * len(items):
            pages.add(page)
    last = max((b.get("page_idx") or 0) for b in blocks) if blocks else 0
    keep = set()
    for start in sorted(titled):
        if start > 0.2 * last:
            continue
        page = start
        while page in pages or page == start:
            if page in pages:
                keep.add(page)
            page += 1
    return keep


def demote_contents_lines(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Demote headings on printed contents pages, keeping the contents title and
    titles such as "List of Figures"."""
    out = [dict(b) for b in blocks]
    pages = _contents_pages(out)
    listed = _outline_listed(out, document)
    for i, b in enumerate(out):
        if (
            _heading(b)
            and b.get("page_idx") in pages
            and i not in listed
            and not _CONTENTS_TITLE.match(_text(b))
            and not _OWN_PAGES.match(_text(b))
        ):
            _demote(b, "contents-line")
    return out


# ------------------------------------------------------------------ backbone

_WORD_NUMBERS = (
    "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|"
    "fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty"
)
_CHAPTER = re.compile(
    r"^(?:chapter|unit|module|lesson|area of operation|bonus essay|book)\s+"
    rf"(?:\d{{1,3}}|[ivxlc]{{1,6}}|{_WORD_NUMBERS})\b",
    re.IGNORECASE,
)
_PART = re.compile(
    rf"^part\s+(?:\d{{1,2}}|[ivxlc]{{1,5}}|{_WORD_NUMBERS})\b", re.IGNORECASE
)
_APPENDIX = re.compile(
    r"^appendix(?:\s+(?:\d{1,2}|[a-z]|[ivxlc]{1,5}))?\b", re.IGNORECASE
)
_NUMBERED = re.compile(r"^(\d{1,3}(?:\.\d{1,3}){0,4})\.?\s+(?=[^\s\d])")
_MERGED_CHAPTER = re.compile(r"^(?:\S+\s+){1,4}?(?=chapter\s+\d{1,3}\b)", re.IGNORECASE)
# Front and back matter that ranks with chapters wherever it appears.
_MATTER = re.compile(
    r"^(?:preface|foreword|prologue|ack\w*ledge?ments?|about the (?:authors?|editors?)|"
    r"how to use this (?:book|textbook)|note to (?:students|instructors|the reader)|"
    r"bibliography|(?:subject |name )?index|glossary|image credits|credits|"
    r"attributions?|licen[cs]e|colophon|afterword|epilogue|appendices|"
    r"versioning history|revision history)[.:]?$",
    re.IGNORECASE,
)
# Chapter rank only outside the chapters (before the first, or after the last and
# set at least as big); inside a chapter they are its sections.
_EDGE_MATTER = re.compile(
    r"^(?:introduction|conclusions?|summary|references|notes|endnotes|"
    r"further reading|recommended (?:further )?reading|works cited|answer key|"
    r"answers(?: to exercises)?|learning outcomes)[.:]?$",
    re.IGNORECASE,
)
_WORD_VALUES = {w: n for n, w in enumerate(_WORD_NUMBERS.split("|"), start=1)}
_ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100}


def _sentence_like(text: str) -> bool:
    words = text.split()
    return len(words) > 14 or (len(words) >= 8 and text[-1:] in ".!?")


def _label_number(token: str) -> int | None:
    token = token.strip(".:)").casefold()
    if token.isdigit():
        return int(token)
    if token in _WORD_VALUES:
        return _WORD_VALUES[token]
    if token and all(c in _ROMAN for c in token):
        values = [_ROMAN[c] for c in token]
        return sum(
            -v if i + 1 < len(values) and v < values[i + 1] else v
            for i, v in enumerate(values)
        )
    return None


def _kind(text: str) -> tuple[str, int, tuple[int, ...]] | None:
    """(part | chapter | numbered | appendix, depth, numbers) of a structural title."""
    if _sentence_like(text) or (_TRAILING_PAGE.search(text) and _LEADER.search(text)):
        return None
    if _PART.match(text):
        n = _label_number(text.split()[1])
        return ("part", 0, (n,) if n else ())
    m = _NUMBERED.match(text)
    if m:
        if not _plain_word(text[m.end() :]):
            return None  # "9 x 2 R": a formula, not a section title
        numbers = tuple(int(x) for x in m[1].split("."))
        return ("numbered", len(numbers), numbers)
    m = _CHAPTER.match(text)
    if m:
        n = _label_number(m[0].split()[-1])
        return ("chapter", 1, (n,) if n else ())
    if _APPENDIX.match(text):
        return ("appendix", 1, ())
    # A part tab ODL merged in front of the chapter label ("Habitat-Focused
    # Techniques Chapter 8 - Restoration").
    m = _MERGED_CHAPTER.match(text)
    if m and (inner := _kind(text[m.end() :])) and inner[0] == "chapter":
        return inner
    return None


def _rising_chain(items: list[tuple[int, int]], step: int = 3) -> set[int]:
    """Longest run of (index, number) in document order whose numbers rise by 1
    to ``step``: the chapter sequence, without contents entries or references."""
    best: list[int] = []
    prev: list[int] = []
    for a, (_, n) in enumerate(items):
        best.append(1)
        prev.append(-1)
        for b in range(a):
            if 0 < n - items[b][1] <= step and best[b] + 1 > best[a]:
                best[a], prev[a] = best[b] + 1, b
    if not best:
        return set()
    # Ties go to the later run (the body after the contents).
    a = max(range(len(best)), key=lambda k: (best[k], k))
    chain = set()
    while a != -1:
        chain.add(items[a][0])
        a = prev[a]
    return chain


def _labelled(block: dict) -> str:
    """Heading text with the chapter label set above it in front."""
    label = block.get("_chapter_label")
    return f"{label} {_text(block)}" if label else _text(block)


def _opener(blocks: list[dict], index: int) -> bool:
    """First content block of its page."""
    page = blocks[index].get("page_idx")
    for j in range(index - 1, -1, -1):
        b = blocks[j]
        if b.get("page_idx") != page:
            return True
        if b.get("type") in ("text", "list", "table", "image", "equation") and (
            _text(b) or b.get("type") != "text"
        ):
            return False
    return True


def _outline_usable(blocks: list[dict], document: pymupdf.Document) -> bool:
    """Five or more outline entries, 30% of them found as headings on their page."""
    toc = [(title, page) for _, title, page in document.get_toc() if page > 0]
    if len(toc) < 5:
        return False
    heads = {(b.get("page_idx"), _outline_key(_text(b))) for b in blocks if _heading(b)}
    found = sum((page - 1, _outline_key(title)) in heads for title, page in toc)
    return found >= 0.3 * len(toc)


def backbone_levels(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Re-level a book without a usable outline from what it prints: the chapter
    chain (parts above it), numbered sections that continue their chapter, front
    and back matter at chapter rank, other headings by style under the section in
    force. Removed banners' scope boundaries are rescaled the same way."""
    out = [dict(b) for b in blocks]
    if _outline_usable(out, document):
        return out
    skip = _contents_pages(out)
    # Chapter openers ODL left as body text: a chapter or part label on top.
    promoted = {
        i
        for i, b in enumerate(out)
        if b.get("type") == "text"
        and not b.get("text_level")
        and len(b.get("bbox") or []) == 4
        and b.get("page_idx") not in skip
        and (_CHAPTER.match(_text(b)) or _PART.match(_text(b)))
        and not _CHAPTER_ONLY.match(_text(b))  # a bare label: its title is elsewhere
        and len(_text(b).split()) <= 20
        and not _sentence_like(_text(b))
        and _opener(out, i)
    }
    heads = [
        i
        for i, b in enumerate(out)
        if (_heading(b) or i in promoted) and b.get("page_idx") not in skip
    ]
    if not heads:
        return out
    kinds = {i: _kind(_labelled(out[i])) for i in heads}
    pages = [b.get("page_idx") or 0 for b in out]
    span = max(pages) - min(pages) + 1 if pages else 1

    def spread(chain: set[int]) -> bool:
        where = sorted({out[i]["page_idx"] for i in chain})
        return (
            len(chain) >= 3 and len(where) >= 3 and where[-1] - where[0] >= 0.2 * span
        )

    def complete(chain: set[int]) -> bool:
        numbers = sorted(kinds[i][2][0] for i in chain)
        gaps = sum(max(0, b - a - 1) for a, b in pairwise(numbers))
        return numbers[0] <= 2 and gaps <= 0.25 * len(numbers)

    def title_part(i: int) -> str:
        text = _labelled(out[i])
        m = _NUMBERED.match(text) or _CHAPTER.match(text)
        title = text[m.end() :] if m else text
        return "".join(unicodedata.normalize("NFKC", title).casefold().split()).strip(
            ":.–-— "
        )

    # Chapter labels beat bare numbers (list items and exercises also rise by
    # one). Page openers are tried first, then each ODL style on its own.
    chain: set[int] = set()
    chain_kind = None
    for kind in ("chapter", "numbered"):
        candidates = [
            i
            for i in heads
            if kinds[i] and kinds[i][0] == kind and kinds[i][1] == 1 and kinds[i][2]
        ]
        # A label whose title repeats ("Chapter 3 Key Takeaways") is a callout.
        numbers_of: dict[str, set[int]] = defaultdict(set)
        for i in candidates:
            numbers_of[title_part(i)].add(kinds[i][2][0])
        candidates = [
            i
            for i in candidates
            if len(numbers_of[title_part(i)]) < 2 or not title_part(i)
        ]
        groups = [[i for i in candidates if _opener(out, i)]]
        groups += [
            [
                i
                for i in candidates
                if i in promoted or out[i].get("text_level") == level
            ]
            for level in sorted(
                {out[i].get("text_level") for i in candidates if i not in promoted}
            )
        ]
        for group in groups:
            found = _rising_chain([(i, kinds[i][2][0]) for i in group])
            if spread(found) and complete(found):
                chain, chain_kind = found, kind
                break
        if chain:
            break
    else:
        return out

    accepted: dict[int, tuple[str, int, tuple[int, ...]]] = {}
    chapter_no = None
    last_chain = None
    for i in heads:
        k = kinds[i]
        if i in chain:
            accepted[i] = k
            chapter_no = k[2][0]
            last_chain = i
        elif (
            k
            and k[0] == "numbered"
            and k[1] >= 2
            and chapter_no is not None
            and k[2][0] == chapter_no
        ):
            accepted[i] = k  # 8.1 inside chapter 8
        elif k and k[0] == "appendix" and i > min(chain):
            accepted[i] = k
        elif (
            k
            and k[1] == 1
            and k[2]
            and chapter_no is not None
            and k[2][0] == chapter_no
            and k[0] == chain_kind
            and abs(out[i]["page_idx"] - out[last_chain]["page_idx"]) <= 1
        ):
            accepted[i] = k  # the chapter's label repeated above its title
    chapter_style = Counter(
        out[i].get("text_level") for i in chain if out[i].get("text_level")
    ).most_common(1)
    chapter_style = chapter_style[0][0] if chapter_style else None
    # Parts rise in number and are set at least as big as the chapters.
    parts = [
        i
        for i in heads
        if kinds[i]
        and kinds[i][0] == "part"
        and kinds[i][2]
        and chapter_style is not None
        and out[i].get("text_level")
        and out[i]["text_level"] <= chapter_style
    ]
    part_chain = _rising_chain([(i, kinds[i][2][0]) for i in parts], step=1)
    if len(part_chain) >= 2:
        accepted.update((i, kinds[i]) for i in part_chain)
    base = 2 if any(k[0] == "part" for k in accepted.values()) else 1

    # The ODL level most headings of each numbering depth carry.
    by_depth: dict[int, list[int]] = defaultdict(list)
    for i, (kind, depth, _) in accepted.items():
        if kind == "numbered" and depth >= 2 and i not in promoted:
            by_depth[depth].append(out[i]["text_level"])
    style = {d: Counter(levels).most_common(1)[0][0] for d, levels in by_depth.items()}
    if chapter_style is not None and (chain_kind == "numbered" or style):
        # The chapter style counts only where numbering separates it from sections.
        style[1] = chapter_style

    first_top, last_top = min(chain), max(chain)
    # Front matter at least as big as the deepest style that opens a front page
    # ranks with chapters; smaller headings nest under the last of those.
    front = [
        i for i in heads if i < first_top and i not in accepted and i not in promoted
    ]
    front_top = max(
        (out[i]["text_level"] for i in front if _opener(out, i)),
        default=min((out[i]["text_level"] for i in front), default=1),
    )
    depth_now = 0
    new_level: dict[int, int] = {}
    boundaries: dict[int, int] = {}
    head_set = set(heads)
    for i in range(len(out)):
        if i not in head_set:
            bound = out[i].get("_heading_boundary_level")
            if isinstance(bound, int) and not _heading(out[i]):
                # A removed banner's scope reset, rescaled like an unnumbered heading.
                if i < first_top:
                    boundaries[i] = (
                        base if bound <= front_top else base + bound - front_top
                    )
                else:
                    boundaries[i] = base + max(depth_now, 1) + bound
            continue
        b = out[i]
        text = _text(b)
        k = accepted.get(i)
        if k is not None:
            if k[0] == "part":
                new_level[i] = 1
                depth_now = 0
            else:
                new_level[i] = base + k[1] - 1
                depth_now = k[1]
            continue
        if i in promoted:
            continue  # a promoted opener outside the numbering stays body text
        if _OWN_PAGES.match(text):
            # Before the chapters it ranks with them; inside them it labels its
            # own pages until the next heading.
            new_level[i] = base if i < first_top else 99
            continue
        level = b["text_level"]
        if _MATTER.match(text) or (
            _EDGE_MATTER.match(text)
            and (
                i < first_top
                or (
                    i > last_top
                    and chapter_style is not None
                    and level <= chapter_style
                )
            )
        ):
            new_level[i] = base
            continue
        if i < first_top:
            new_level[i] = base if level <= front_top else base + level - front_top
            continue
        # Styled like numbered depth d: a depth-d sibling. Else it sits under the
        # section in force, keeping its style order.
        sentence = len(text.split()) >= 8 and re.search(r"[.!?][\"'”’)]*$", text)
        depth = (
            None
            if sentence
            else next(
                (d for d in sorted(style) if level <= style[d] and d <= depth_now + 1),
                None,
            )
        )
        if depth is not None:
            new_level[i] = base + depth - 1
        else:
            new_level[i] = base + max(depth_now, 1) + level
    for i, b in enumerate(out):
        if _heading(b) and b.get("page_idx") in skip and _OWN_PAGES.match(_text(b)):
            new_level[i] = base if i < first_top else 99
    for i, level in new_level.items():
        out[i]["text_level"] = level
        if i in promoted:
            out[i]["_source_role"] = "chapter-opener"
    for i, level in boundaries.items():
        out[i]["_heading_boundary_level"] = level
    return out
