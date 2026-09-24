"""Outline levels and book-title roots (parser v10).

Ported from the outline-levels investigation
(``bench/parsers/reports/2026-09-24-outline-levels-and-running-heads.md``).

- ``relevel``: a book whose PDF outline is usable and not broken takes outline
  levels; every other book takes v9's chapter backbone. Walking the headings as
  the chunker does, a heading's level changes only where the stack contradicts
  the outline: a listed heading closes the listed headings whose span has ended
  and sits directly under its outline parent; an unlisted heading or a banner
  boundary cannot close a listed heading that is an outline ancestor of the next
  listed heading, unless it is numbered as that heading's peer; a changed heading
  carries its subtree by the same step. Only ``text_level`` and banner
  ``_heading_boundary_level`` change; no block is added, removed or retyped.
- ``mark_book_titles``: title-page headings (the book title recognised from the
  PDF metadata, a whole-book outline entry or the title page, and the unnumbered
  headings beside it) get ``_source_role: book-title``. The chunker closes the
  heading stack at their level without pushing them and keeps their text.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict

import pymupdf

from . import levels
from .headings import _literal
from .levels import _heading, _labelled, _text

_INF = 10**9
_SECTION_NUMBER = re.compile(
    r"^\s*(?:(?:chapter|part|section|unit|lesson|appendix)\s*)?(\d+(?:\.\d+)*)"
    r"(?=[\s.:)]|$)",
    re.IGNORECASE,
)
# Exporters' structural wrappers (Pressbooks' "Main Body"): not titles, so their
# children move up a level.
_WRAPPER = re.compile(
    r"^(?:\d+\s+)?(?:main body|front matter|back matter|toc|table of contents|"
    r"contents)$",
    re.IGNORECASE,
)
_PART_LIKE = re.compile(r"^\s*(?:part|volume|book|unit|module)\b", re.IGNORECASE)
_FRONT_MATTER = re.compile(
    r"^(?:ack\w*ledg|preface|foreword|dedication|copyright|about\b|contents\b|"
    r"nomenclature|abbreviations)",
    re.IGNORECASE,
)
_EDGE_TOP, _EDGE_BOTTOM = 200, 800  # the top and bottom fifth of the page
_NUMBER_END = re.compile(r"^\W*\d+\b|\b\d+\W*$")
_NUMBER = re.compile(r"\d+(?:\.\d+)*")


def _key(text: str) -> str:
    """Outline key with every leading label stripped ("5 Chapter 1 - Title")."""
    text = unicodedata.normalize("NFKC", text).translate(levels._QUOTE_FOLD).strip()
    for _ in range(3):
        stripped = levels._OUTLINE_LEAD.sub("", text).strip(" -–—:.")
        if stripped == text:
            break
        text = stripped
    text = levels._TRAILING_NUMBER.sub("", text)
    return "".join(ch for ch in text.casefold() if ch.isalnum())


def _similar(a: str, b: str) -> bool:
    """Equal keys, or one of eight or more characters starting the other."""
    a, b = a.translate(levels._QUOTE_FOLD), b.translate(levels._QUOTE_FOLD)
    if not a or not b:
        return False
    short, long_ = sorted((a, b), key=len)
    return a == b or (len(short) >= 8 and long_.startswith(short))


def _entries(document: pymupdf.Document) -> list[dict]:
    """Outline entries in page order: level, title, page (1-based), y (0-1000)."""
    out = []
    wrapped: list[int] = []  # levels of open wrappers
    toc = document.get_toc(simple=False)
    for n, (level, title, page, dest) in enumerate(toc):
        title = " ".join(title.split())
        while wrapped and level <= wrapped[-1]:
            wrapped.pop()
        # A wrapper has children; a childless "Contents" is the contents page.
        if _WRAPPER.match(title) and n + 1 < len(toc) and toc[n + 1][0] > level:
            wrapped.append(level)
            continue
        # Machine bookmarks ("_heading=h.1fob9te", "tmp.x") are not titles.
        if page < 1 or title.startswith("tmp.") or ("_" in title and " " not in title):
            continue
        y = None
        if (
            isinstance(dest, dict)
            and dest.get("to") is not None
            and "nameddest" not in dest
        ):
            y = dest["to"].y / document[page - 1].rect.height * 1000
        out.append(
            {"level": level - len(wrapped), "title": title, "page": page, "y": y}
        )
    out.sort(key=lambda e: e["page"])  # stable: the outline's order within a page

    # One title bookmarked twice on a page at two levels (OECD's "Part A"): keep
    # the shallower; the two copies' spacing differs.
    def same_key(e: dict) -> tuple:
        return e["page"], _literal(e["title"])

    first: dict[tuple, int] = {}
    for e in out:
        first[same_key(e)] = min(first.get(same_key(e), e["level"]), e["level"])
    out = [e for e in out if e["level"] == first[same_key(e)]]

    # Tags: a title repeated verbatim three or more times, mostly on the page of
    # the entry before it at its level (an author under every chapter). Verbatim,
    # so numbered per-chapter entries ("8.1 Learning Objectives") stay.
    def raw(e: dict) -> str:
        return unicodedata.normalize("NFKC", e["title"]).casefold()

    keys = Counter(raw(e) for e in out)
    shared: Counter = Counter()
    for a, e in enumerate(out):
        prev = next((f for f in reversed(out[:a]) if f["level"] <= e["level"]), None)
        if (
            prev is not None
            and prev["level"] == e["level"]
            and prev["page"] == e["page"]
        ):
            shared[raw(e)] += 1
    return [
        e for e in out if not (keys[raw(e)] >= 3 and 2 * shared[raw(e)] >= keys[raw(e)])
    ]


def _running_heads(blocks: list[dict]) -> set[int]:
    """Headings with a number at either end in the top or bottom fifth of the
    page whose text without digits recurs there on three or more pages."""
    pages: dict[str, set[int]] = defaultdict(set)
    keyed: dict[int, str] = {}
    for i, b in enumerate(blocks):
        box = b.get("bbox") or []
        if (
            len(box) != 4
            or type(b.get("page_idx")) is not int
            or not (box[1] < _EDGE_TOP or box[1] > _EDGE_BOTTOM)
        ):
            continue
        text = _text(b)
        k = re.sub(r"\d+", "", _literal(text))
        if k:
            pages[k].add(b["page_idx"])
            if _heading(b) and _NUMBER_END.search(text):
                keyed[i] = k
    return {i for i, k in keyed.items() if len(pages[k]) >= 3}


def _folio_left(text: str, title: str) -> bool:
    """A number at either end that the outline title does not carry."""
    words = [w.strip("|•·–—-.:()") for w in text.split()]
    words = [w for w in words if w]
    own = set(_NUMBER.findall(title))
    return any(_NUMBER.fullmatch(w) and w not in own for w in (words[:1] + words[-1:]))


def _match(blocks: list[dict], entries: list[dict]) -> dict[int, int]:
    """Entry index -> heading index, in reading order, on the destination page or
    a neighbour. A running head never matches an entry lacking its page number."""
    heads = _running_heads(blocks)
    by_page: dict[int, list[int]] = defaultdict(list)
    for i, b in enumerate(blocks):
        if _heading(b):
            by_page[b["page_idx"]].append(i)
    matched: dict[int, int] = {}
    used: set[int] = set()
    cursor = -1

    def fits(i: int, e: dict, key: str) -> bool:
        if i in heads and _folio_left(_text(blocks[i]), e["title"]):
            return False
        return _similar(_key(_text(blocks[i])), key) or _similar(
            _key(_labelled(blocks[i])), key
        )

    for j, e in enumerate(entries):
        key = _key(e["title"])
        if not key:
            continue
        for page in (e["page"] - 1, e["page"], e["page"] - 2):
            hit = next(
                (
                    i
                    for i in by_page.get(page, [])
                    if i > cursor and i not in used and fits(i, e, key)
                ),
                None,
            )
            if hit is not None:
                matched[j] = hit
                used.add(hit)
                cursor = hit
                break
    # An entry listed out of reading order still matches on its own page.
    for j, e in enumerate(entries):
        key = _key(e["title"])
        if j in matched or not key:
            continue
        hit = next(
            (
                i
                for i in by_page.get(e["page"] - 1, [])
                if i not in used and fits(i, e, key)
            ),
            None,
        )
        if hit is not None:
            matched[j] = hit
            used.add(hit)
    return matched


def _reading_order(entries: list[dict], matched: dict[int, int]) -> list[int]:
    """Entries with each matched one moved in front of the first earlier matched
    entry whose heading comes after its own."""
    order: list[int] = []
    for j in range(len(entries)):
        if j in matched:
            k = next(
                (
                    a
                    for a, x in enumerate(order)
                    if x in matched and matched[x] > matched[j]
                ),
                None,
            )
            if k is not None:
                order.insert(k, j)
                continue
        order.append(j)
    return order


def _positions(
    blocks: list[dict], entries: list[dict], matched: dict[int, int], order: list[int]
) -> dict[int, int]:
    """Block index where each entry starts: its heading, else the first block on
    its page at or below its destination, never before the entry listed before it."""
    on_page: dict[int, list[int]] = defaultdict(list)
    for i, b in enumerate(blocks):
        if isinstance(b.get("page_idx"), int):
            on_page[b["page_idx"]].append(i)
    pos = {}
    last = -1
    for j in order:
        e = entries[j]
        if j in matched:
            pos[j] = last = matched[j]
            continue
        slots = on_page.get(e["page"] - 1, [])
        y = e["y"]
        after = [
            i
            for i in slots
            if y is None
            or (len(blocks[i].get("bbox") or []) == 4 and blocks[i]["bbox"][1] >= y - 5)
        ]
        start = after[0] if after else (slots[0] if slots else len(blocks))
        pos[j] = last = max(start, last + 1)
    return pos


def _boundary(block: dict) -> bool:
    level = block.get("_heading_boundary_level")
    return (
        block.get("type") == "discarded"
        and block.get("_source_role") == "running-banner"
        and type(level) is int
        and level > 0
    )


def _broken(
    blocks: list[dict], entries: list[dict], matched: dict[int, int], pages: int
) -> bool:
    """An entry, not Part-like, spans over half the book while most of its matched
    children are typed larger than it (a change-log bookmark holding every
    chapter), or a front-matter entry does so with children typed as large."""
    for k, e in enumerate(entries):
        end = next(
            (f["page"] for f in entries[k + 1 :] if f["level"] <= e["level"]), pages + 1
        )
        if (
            (end - e["page"]) <= 0.5 * pages
            or _PART_LIKE.match(e["title"])
            or k not in matched
        ):
            continue
        own = blocks[matched[k]]["text_level"]
        kids = []
        for c in range(k + 1, len(entries)):
            if entries[c]["level"] <= e["level"]:
                break
            if entries[c]["level"] == e["level"] + 1 and c in matched:
                kids.append(blocks[matched[c]]["text_level"])
        larger = sum(1 for t in kids if t < own)
        peers = sum(1 for t in kids if t <= own)
        if kids and (
            2 * larger > len(kids)
            or (_FRONT_MATTER.match(e["title"]) and 2 * peers > len(kids))
        ):
            return True
    return False


def _listing(blocks: list[dict], document: pymupdf.Document) -> dict[int, dict] | None:
    """Listed headings: block index -> the end of its outline span, its outline
    parent entry and that entry's block. None when the outline is not usable or
    is broken."""
    if not levels._outline_usable(blocks, document):
        return None
    entries = _entries(document)
    matched = _match(blocks, entries)
    if _broken(blocks, entries, matched, len(document)):
        return None
    active = _reading_order(entries, matched)
    pos = _positions(blocks, entries, matched, active)
    n = len(blocks)
    listed: dict[int, dict] = {}
    for a, j in enumerate(active):
        if j not in matched:
            continue
        level = entries[j]["level"]
        end = next((pos[k] for k in active[a + 1 :] if entries[k]["level"] <= level), n)
        parent = next(
            (k for k in reversed(active[:a]) if entries[k]["level"] < level), None
        )
        listed[matched[j]] = {
            "end": max(end, matched[j] + 1),  # never before its own heading
            "parent": parent,
            "parent_block": matched.get(parent) if parent is not None else None,
        }
    # A title split over two same-level bookmarks whose headings follow each other
    # with no body between them reads as one title, the second under the first.
    for a in range(len(active) - 2, -1, -1):
        j1, j2 = active[a], active[a + 1]
        if (
            j1 not in matched
            or j2 not in matched
            or entries[j1]["level"] != entries[j2]["level"]
        ):
            continue
        b1, b2 = matched[j1], matched[j2]
        if b2 <= b1 or blocks[b1].get("page_idx") != blocks[b2].get("page_idx"):
            continue
        if any(
            blocks[k].get("type") != "discarded" and not _heading(blocks[k])
            for k in range(b1 + 1, b2)
        ):
            continue
        listed[b1]["end"] = max(listed[b1]["end"], listed[b2]["end"])
        listed[b2]["parent"], listed[b2]["parent_block"] = j1, b1
    return listed


def _plan(blocks: list[dict], listed: dict[int, dict]) -> tuple[dict, dict]:
    """New heading levels and boundary levels (the investigation's ancestors2)."""
    n = len(blocks)
    nxt = [n] * (n + 1)  # the next listed heading after each block
    for k in range(n - 1, -1, -1):
        nxt[k] = k + 1 if (k + 1) in listed else nxt[k + 1]

    def number(k: int) -> tuple[str, ...] | None:
        found = _SECTION_NUMBER.match(_text(blocks[k]))
        return tuple(found[1].split(".")) if found else None

    def covers(e: dict, i: int) -> bool:
        """The unlisted block i may not pop listed stack entry e: e is an outline
        ancestor of the next listed heading, and i is not numbered as e's peer
        ("4. Images" after "3. Organizing Content", left out of the outline)."""
        if e["end"] <= nxt[i]:
            return False
        if _heading(blocks[i]):
            mine, theirs = number(i), number(e["i"])
            return not (mine and theirs and len(mine) <= len(theirs) and mine != theirs)
        return True

    shift = [0] * n
    new_levels: dict[int, int] = {}
    bounds: dict[int, int] = {}
    stack: list[dict] = []

    def current(k: int) -> int | None:
        b = blocks[k]
        if _heading(b):
            return b["text_level"] + shift[k]
        if _boundary(b):
            return b["_heading_boundary_level"] + shift[k]
        return None

    for i, b in enumerate(blocks):
        if _boundary(b):
            level = b["_heading_boundary_level"] + shift[i]
            protected = [e["level"] for e in stack if e["listed"] and covers(e, i)]
            level = max(level, max(protected) + 1 if protected else 1)
            bounds[i] = level
            while stack and stack[-1]["level"] >= level:
                stack.pop()
            continue
        if not _heading(b):
            continue
        level = b["text_level"] + shift[i]
        info = listed.get(i)
        protected = [
            e
            for e in stack
            if e["listed"] and (e["end"] > i if info is not None else covers(e, i))
        ]
        lo = max((e["level"] for e in protected), default=0) + 1
        # Only a listed heading closes listed headings whose span has ended.
        hi = _INF
        if info is not None:
            hi = min(
                (e["level"] for e in stack if e["listed"] and e["end"] <= i),
                default=_INF,
            )
            if info["parent"] is None or info["parent_block"] is not None:
                parent_level = 0
                if info["parent_block"] is not None:
                    found = [
                        e["level"] for e in stack if e["i"] == info["parent_block"]
                    ]
                    parent_level = found[0] if found else None
                if parent_level is not None:
                    between = [
                        e["level"]
                        for e in stack
                        if not e["listed"] and e["level"] > parent_level
                    ]
                    if between:
                        hi = min(hi, min(between))
                    # An unlisted Part heading stays above a top-level listed one
                    # (NIST AI RMF's outline points "Part 1" at page 1).
                    if info["parent"] is None:
                        parts = [
                            e["level"]
                            for e in stack
                            if not e["listed"]
                            and _PART_LIKE.match(_text(blocks[e["i"]]))
                        ]
                        if parts:
                            lo = max(lo, max(parts) + 1)
        new = min(max(level, lo), hi) if lo <= hi else level  # a conflict: left alone
        if new != level:
            # The heading carries its subtree by the same step.
            for k in range(i + 1, n):
                lk = current(k)
                if lk is None:
                    continue
                if lk <= level:
                    break
                shift[k] += new - level
        new_levels[i] = new
        while stack and stack[-1]["level"] >= new:
            stack.pop()
        stack.append(
            {
                "i": i,
                "level": new,
                "listed": info is not None,
                "end": info["end"] if info else None,
            }
        )
    return new_levels, bounds


def relevel(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Outline levels for a book with a usable, unbroken outline; v9's chapter
    backbone for every other book."""
    listed = _listing(blocks, document)
    if listed is None:
        return levels.backbone_levels(blocks, document)
    if len(listed) < 3:
        return blocks
    new_levels, bounds = _plan(blocks, listed)
    out = [dict(b) for b in blocks]
    for i, level in new_levels.items():
        out[i]["text_level"] = level
    for i, level in bounds.items():
        out[i]["_heading_boundary_level"] = level
    return out


# ------------------------------------------------------------------ title roots

_JUNK_META = re.compile(
    r"^(?:microsoft\s+\w+\s*-\s*|untitled|document\d*$)|\.(?:docx?|pdf|indd|tex)$",
    re.IGNORECASE,
)
_TITLE_PAGE_WINDOW = 5  # where the title page's most prominent heading is sought
_TITLE_FRONT = 10  # pages where a title page can sit


def _same_title(text: str, title: str) -> bool:
    a, b = _key(text), _key(title)
    return bool(a and b) and (a == b or _similar(a, b))


def _meta_title(document: pymupdf.Document) -> str:
    title = " ".join(str((document.metadata or {}).get("title") or "").split())
    if not title or _JUNK_META.search(title) or len(_key(title)) < 6:
        return ""
    return title


def _outline_root(document: pymupdf.Document) -> str:
    """A single top-level outline entry spanning 90% of the pages."""
    entries = _entries(document)
    if not entries:
        return ""
    top = min(e["level"] for e in entries)
    tops = [e for e in entries if e["level"] == top]
    if len(tops) != 1:
        return ""
    e = tops[0]
    return e["title"] if (len(document) + 1 - e["page"]) >= 0.9 * len(document) else ""


def _title_page_root(blocks: list[dict]) -> str:
    """The most prominent heading of the first page with headings (within five
    pages) when it is at the bottom of the heading stack for half the body."""
    heads = [
        i
        for i, b in enumerate(blocks)
        if _heading(b) and b["page_idx"] < _TITLE_PAGE_WINDOW
    ]
    if not heads:
        return ""
    page = blocks[heads[0]]["page_idx"]
    title = min(
        (i for i in heads if blocks[i]["page_idx"] == page),
        key=lambda i: (blocks[i]["text_level"], i),
    )
    stack: list[tuple[int, int]] = []
    bottom: Counter = Counter()
    body = 0
    for i, b in enumerate(blocks):
        if _boundary(b):
            while stack and stack[-1][1] >= b["_heading_boundary_level"]:
                stack.pop()
        elif _heading(b):
            while stack and stack[-1][1] >= b["text_level"]:
                stack.pop()
            stack.append((i, b["text_level"]))
        elif b.get("type") == "text" and _text(b):
            body += 1
            if stack:
                bottom[stack[0][0]] += 1
    return _text(blocks[title]) if body and bottom[title] >= 0.5 * body else ""


def mark_book_titles(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Mark the title pages' unnumbered headings ``book-title``: the title, and
    subtitles, author, series and publisher lines beside it. The title pages run
    from the first page to the last of the first ten that carries the book title.
    Headings the outline lists under another title stay."""
    titles = [t for t in (_meta_title(document), _outline_root(document)) if t]
    titles += [t for t in [_title_page_root(blocks)] if t]
    if not titles:
        return blocks

    def numbered(text: str) -> bool:
        return bool(_SECTION_NUMBER.match(text) or levels._CHAPTER.match(text))

    hits = [
        b["page_idx"]
        for b in blocks
        if _heading(b)
        and b["page_idx"] < _TITLE_FRONT
        and not numbered(_text(b))
        and any(_same_title(_text(b), t) for t in titles)
    ]
    if not hits:
        return blocks
    last = max(hits)
    listed = {
        (e["page"] - 1, _key(e["title"]))
        for e in _entries(document)
        if not any(_same_title(e["title"], t) for t in titles)
    }
    return [
        {**b, "_source_role": "book-title"}
        if _heading(b)
        and b["page_idx"] <= last
        and not numbered(_text(b))
        and (b["page_idx"], _key(_text(b))) not in listed
        else b
        for b in blocks
    ]
