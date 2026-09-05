"""Turn a parsed document into retrievable chunks.

Two entry points, one output shape:

- :func:`chunk_content_list` consumes the parser service's ``content_list.json``,
  which carries a heading level and a page plus bounding box per block. That
  structure is the whole reason citations can name a page.
- :func:`chunk_markdown` consumes plain markdown (txt/md uploads and the
  'normal' parse route, whose cloud API returns markdown only). Headings still
  give section paths; there is no page model, so pages stay null.

Both split on structure first and only fall back to length, so a chunk is a
section or a run of consecutive blocks rather than an arbitrary window. Chunks
carry two strings: ``text`` is what a citation shows and what the model reads;
``indexed_text`` prepends the heading breadcrumb, never a logical file name
(renaming a file must not fork canonical content).
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any

from ..config import cfg
from .lang import CJK_CLASS, CJK_RUN_RE, is_cjk

log = logging.getLogger("evo.retrieval.chunking")

# Bumped when packing, overlap, indexed_text shape, or the text-search
# configuration behind `rag_chunks.search` change. Part of
# rag_contents.pipeline_identity, so a bump invalidates every donor and
# re-parses rather than copying stale chunks.
# v2: search column built with the `english` configuration (was `simple`);
#     packing by estimated tokens; tables flattened to pipe-separated rows;
#     <sub>/<sup> tags stripped; spacing inside inline LaTeX collapsed.
# v3: per-chunk language tag; search column built with that language's
#     configuration (lang.TS_CONFIG).
# v4: blocks repeated on three or more pages dropped as furniture; numeric
#     affiliation/footnote superscripts dropped instead of glued to the word.
# v5: reference lists flagged and left out of the lexical index (chunk
#     boundaries unchanged, so eval indices carry over).
CHUNKER_VERSION = "v5"

# Picture blocks arrive under two labels: ``image`` for photos and diagrams,
# ``chart`` for plots the layout model recognises as data graphics. Same shape,
# different caption key, and both are captionable figures. Kept in step with
# ``parse/figures.py``, which must select exactly this set or a block gets
# described and then dropped (or dropped and never described).
_IMAGE_TYPES = frozenset({"image", "chart"})

# Text-bearing blocks that are not headings. Indexed as ordinary body text.
#
# ``header`` earns its place here by measurement, not by its name: on a slide
# deck it is the *slide title* (it sits in the top band), and on a book's table
# of contents it is "Contents". Dropping it as running furniture cost real
# titles. It is not promoted to a heading either. The parser gives it no
# ``text_level``, and inventing one would let a genuine running header
# ("Chapter 3") overwrite the section path on every page of a book.
_BODY_TEXT_TYPES = frozenset({"header", "page_footnote"})

# Blocks whose text is a list of items rather than a single string.
_LIST_TYPES = frozenset({"list"})

# Page furniture, dropped on purpose. ``page_number`` is a bare digit,
# ``footer`` is the repeated conference/publisher line, ``aside_text`` is the
# rotated margin stamp a scanner picks up as noise. In one sample it read
# "r00[:0:::02". ``discarded`` is the parser's reject label.
_FURNITURE_TYPES = frozenset({"footer", "page_number", "aside_text", "discarded"})

# A running header is furniture whatever label the layout model gives it. On
# the lab corpus a journal's title-and-authors line arrived as ``header`` on 22
# of 25 pages and opened 28 of the paper's 75 chunks, so every question near
# its topic came back as copies of it; a slide deck's licence line arrived as
# ``text`` on 40 pages. Any non-heading text block whose text recurs on this
# many pages is dropped before packing.
_REPEATED_ON_PAGES = 3
_REPEATABLE_TYPES = frozenset({"text"}) | _BODY_TEXT_TYPES

# Parser blocks use a 0..1000 box with the origin at the top-left of the page.
# Recorded per region so a renderer never has to infer it.
BBOX_SPACE = "page-1000-topleft"

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*$")

# Inline markup the parser leaves in prose. Sub/superscript tags carry chemical
# and unit notation (H<sub>2</sub>O, m<sup>2</sup>); the content is kept and the
# tags dropped, which is also how a student types the query. LaTeX stays as
# written except for the parser's habit of spacing every brace and operator
# ("\mathsf { m } ^ { 2 }"), which is pure token cost.
#
# The exception is a digits-only superscript riding on a word of three or more
# letters, a CJK character, or a line start: that is an affiliation or footnote
# marker (Mayor-Rocher<sup>1</sup>, Martin∗<sup>1,2,3</sup>, <sup>1</sup>Facebook),
# and kept it glues a digit onto the name ("rocher1") that no query contains.
# Units and variables are one or two letters, so m<sup>2</sup>, dm<sup>-3</sup>
# and 10<sup>15</sup> keep their exponent.
# ponytail: sin<sup>2</sup> loses its exponent; carve out trig names if it shows up.
_MARKER_SUP_RE = re.compile(
    r"(^|[^\W\d_]{3}|" + CJK_CLASS + r")[∗*]?\s?<sup>\s*[\d,+*∗†‡\s]+</sup>",
    re.MULTILINE,
)
_SUB_SUP_RE = re.compile(r"</?su[bp]>")
_INLINE_MATH_RE = re.compile(r"\$([^$]+)\$")
_MATH_SPACING_RE = re.compile(r"\s*([{}^_])\s*")
_TAG_RE = re.compile(r"<[^>]+>")


@dataclass
class Region:
    page: int
    bbox: list[float]

    def as_dict(self) -> dict[str, Any]:
        return {"page": self.page, "bbox": self.bbox, "space": BBOX_SPACE}


@dataclass
class Chunk:
    text: str
    section_path: str = ""
    page_start: int | None = None
    page_end: int | None = None
    regions: list[Region] = field(default_factory=list)
    # A reference list: embedded and readable, but absent from the lexical
    # index. Citation titles repeat a topic's exact vocabulary, so on a
    # Chinese paper an English question lexically matched the English-tagged
    # bibliography ahead of the Chinese body that answers it.
    reference: bool = False

    def indexed_text(self) -> str:
        if self.section_path:
            return f"{self.section_path}\n\n{self.text}"
        return self.text


@dataclass
class _Block:
    """One parsed source block, normalized across both input formats."""

    text: str
    level: int | None = None  # heading level, None for body content
    page: int | None = None
    bbox: list[float] | None = None
    reference: bool = False


# A bibliography entry: a numbered marker, a year, "et al.", pages, a DOI or
# an arXiv id. Measured on the lab corpus, parsers deliver a reference list as
# one ``list`` block in which nearly every item looks like this (14/14, 22/21,
# 18/18), while a body list that happens to cite something does not (10/3).
_CITATION_RE = re.compile(
    r"^\s*\[\d+\]|[（(]\d{4}[a-z]?[)）]|\b(?:19|20)\d{2}[.,，]|et al\.|pp?\.\s?\d|\bdoi\b|arXiv",
    re.IGNORECASE,
)
_REFERENCE_MIN_ITEMS = 5
_REFERENCE_SHARE = 0.8


def _is_reference_list(items: list[str]) -> bool:
    if len(items) < _REFERENCE_MIN_ITEMS:
        return False
    cited = sum(1 for item in items if _CITATION_RE.search(item))
    return cited >= _REFERENCE_SHARE * len(items)


# --------------------------------------------------------------- CJK handling

# Postgres' built-in text search configurations tokenize on whitespace and
# punctuation, which produces exactly one token for a Chinese sentence. Every
# multilingual option that fixes this properly (PGroonga, pg_bigm, zhparser) is
# an extension we would have to build into the Postgres image. Bigramming CJK
# runs in the application gets the same recall from a stock image, at the cost
# of a larger tsvector. CJK chunks are indexed with the 'simple' configuration
# (lang.TS_CONFIG), which keeps every bigram as written.
_is_cjk = is_cjk


def estimate_tokens(text: str) -> int:
    """Cheap token estimate that treats CJK as ~1 token per character.

    Latin tokenizers pack ~4 characters per token. CJK tokenizers pack ~1.
    ``len // 4`` therefore under-counts Chinese/Japanese/Korean by 3-4x and
    would let a 50k-token budget admit ~200k real tokens of CJK.
    """
    if not text:
        return 0
    cjk = 0
    other = 0
    for ch in text:
        if _is_cjk(ch):
            cjk += 1
        else:
            other += 1
    return cjk + (other + 3) // 4


def clip_to_tokens(text: str, budget: int) -> str:
    """Prefix of ``text`` whose estimated tokens fit in ``budget``."""
    if estimate_tokens(text) <= budget:
        return text
    used = 0
    latin_run = 0
    out: list[str] = []
    for ch in text:
        if _is_cjk(ch):
            cost = 1
            latin_run = 0
        else:
            latin_run += 1
            cost = 1 if latin_run % 4 == 1 else 0
        if used + cost > budget:
            break
        used += cost
        out.append(ch)
    return "".join(out)


def tokenize_for_search(text: str) -> str:
    """Rewrite text so `to_tsvector` indexes CJK usefully.

    Latin runs pass through untouched; each CJK run becomes its overlapping
    character bigrams (plus the single character, when the run is one long).
    Queries must be tokenized with the same function — see
    :func:`search_query_terms`.
    """
    out: list[str] = []
    cjk: list[str] = []
    other: list[str] = []

    # Non-CJK text is carried as whole segments. Emitting it character by
    # character (an earlier version did) turned every Latin word in a mixed
    # chunk into single-letter tokens: one OCR'd dash read as '一' in a table
    # was enough to remove the surrounding English from the lexical index.
    def flush_cjk() -> None:
        if not cjk:
            return
        chars = "".join(cjk)
        if len(chars) == 1:
            out.append(chars)
        else:
            out.extend(chars[i : i + 2] for i in range(len(chars) - 1))
        cjk.clear()

    def flush_other() -> None:
        if other:
            out.append("".join(other))
            other.clear()

    for ch in text:
        if _is_cjk(ch):
            flush_other()
            cjk.append(ch)
        else:
            flush_cjk()
            other.append(ch)
    flush_cjk()
    flush_other()
    return " ".join(out)


@dataclass(frozen=True)
class QueryTerms:
    """The lexical query in the shapes ``store.hybrid_search`` needs.

    ``any_of`` is the OR-joined websearch string (recall: a long question
    shares only part of its vocabulary with the passage). ``all_of`` is the
    same words joined by AND. ``latin``, ``cjk_runs`` and ``terms`` describe
    the query for the exact tier: ``terms`` is the number of words as typed,
    where each CJK run is one word no matter how many bigrams it became.
    """

    any_of: str
    all_of: str
    latin: str
    cjk_runs: int
    terms: int


def search_query_terms(query: str) -> QueryTerms:
    """Build `websearch_to_tsquery`-safe strings matching the index tokens."""
    tokenized = tokenize_for_search(query)
    words = [w for w in re.split(r"\s+", tokenized) if w and w not in "&|!():*"]
    words = words[:40]
    latin = [w for w in words if not CJK_RUN_RE.search(w)]
    cjk_runs = len(CJK_RUN_RE.findall(query))
    return QueryTerms(
        any_of=" or ".join(words),
        all_of=" ".join(words),
        latin=" ".join(latin),
        cjk_runs=cjk_runs,
        terms=len(latin) + cjk_runs,
    )


# ------------------------------------------------------------ block assembly


def _section_path(stack: list[tuple[int, str]]) -> str:
    return " › ".join(title for _, title in stack)


def _push_heading(stack: list[tuple[int, str]], level: int, title: str) -> None:
    while stack and stack[-1][0] >= level:
        stack.pop()
    stack.append((level, title))


def _pack(blocks: list[_Block], section_path: str) -> list[Chunk]:
    """Pack consecutive blocks of one section into token-bounded chunks.

    Blocks are never split unless a single block exceeds the target on its own,
    so a table or a paragraph stays whole and its bbox stays meaningful.
    """
    chunks: list[Chunk] = []
    current: list[_Block] = []
    size = 0

    def flush() -> None:
        nonlocal size
        if not current:
            return
        chunks.append(_build(current, section_path))
        # Overlap by trailing blocks rather than characters: a partial sentence
        # carried into the next chunk helps neither embedding nor reading.
        carry: list[_Block] = []
        carried = 0
        for blk in reversed(current):
            if carried >= cfg.chunk_overlap_tokens:
                break
            carry.insert(0, blk)
            carried += estimate_tokens(blk.text)
        current.clear()
        if carried < cfg.chunk_tokens // 2:
            current.extend(carry)
        size = sum(estimate_tokens(b.text) for b in current)

    for block in blocks:
        text = block.text.strip()
        if not text:
            continue
        tokens = estimate_tokens(text)
        if tokens > cfg.chunk_tokens:
            flush()
            for piece in _split_long(text):
                chunks.append(
                    _build(
                        [_Block(piece, None, block.page, block.bbox, block.reference)],
                        section_path,
                    )
                )
            continue
        if size + tokens > cfg.chunk_tokens and current:
            flush()
        current.append(block)
        size += tokens

    if current:
        chunks.append(_build(current, section_path))
    return [
        c
        for c in chunks
        if estimate_tokens(c.text) >= cfg.chunk_min_tokens or len(chunks) == 1
    ]


def _split_long(text: str) -> list[str]:
    """Last-resort split of one oversized block, preferring sentence ends."""
    pieces: list[str] = []
    remaining = text
    while estimate_tokens(remaining) > cfg.chunk_tokens:
        window = clip_to_tokens(remaining, cfg.chunk_tokens)
        cut = max(
            window.rfind("。"),
            window.rfind(". "),
            window.rfind("\n"),
            window.rfind("！"),
        )
        if cut < len(window) // 2:
            cut = len(window) - 1
        pieces.append(remaining[: cut + 1].strip())
        remaining = remaining[cut + 1 :]
    if remaining.strip():
        pieces.append(remaining.strip())
    return pieces


# ------------------------------------------------------------ text cleanup


def clean_inline(text: str) -> str:
    """Drop sub/superscript tags and collapse spacing inside inline LaTeX."""
    text = _MARKER_SUP_RE.sub(r"\1", text)
    text = _SUB_SUP_RE.sub("", text)
    return _INLINE_MATH_RE.sub(
        lambda m: "$" + _MATH_SPACING_RE.sub(r"\1", m.group(1)).strip() + "$", text
    )


class _TableRows(HTMLParser):
    """Collect the cell text of an HTML table, row by row."""

    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[str]] = []
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            if not self.rows:
                self.rows.append([])
            self._cell = []
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._cell is not None:
            self.rows[-1].append(" ".join("".join(self._cell).split()))
            self._cell = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


def flatten_table(html: str) -> str:
    """Render a parser table as one pipe-separated line per row.

    The parser's HTML carries ``rowspan=1 colspan=1`` on every cell and image
    tags for embedded figures; on the lab corpus that markup was a fifth of all
    indexed characters. Cells keep their text and order, which is what search
    and the model need; the layout geometry is not recoverable from text anyway.
    """
    parser = _TableRows()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001 - malformed markup falls back to tag stripping
        return " ".join(_TAG_RE.sub(" ", html).split())
    lines = [" | ".join(row) for row in parser.rows if any(row)]
    if not lines:
        return " ".join(_TAG_RE.sub(" ", html).split())
    return "\n".join(lines)


def _bbox_coords(bbox: object) -> list[float]:
    try:
        coords = [float(x) for x in bbox]  # type: ignore[union-attr]
    except (TypeError, ValueError):
        return []
    if len(coords) != 4 or not all(math.isfinite(value) for value in coords):
        return []
    x0, y0, x1, y1 = coords
    if x1 <= x0 or y1 <= y0:
        return []
    return coords


def _build(blocks: list[_Block], section_path: str) -> Chunk:
    pages = [b.page for b in blocks if b.page is not None]
    regions: list[Region] = []
    for b in blocks:
        if b.page is None or not b.bbox:
            continue
        coords = _bbox_coords(b.bbox)
        if coords:
            regions.append(Region(page=b.page, bbox=coords))
    return Chunk(
        text="\n\n".join(b.text.strip() for b in blocks if b.text.strip()),
        section_path=section_path,
        page_start=min(pages) if pages else None,
        page_end=max(pages) if pages else None,
        regions=regions,
        reference=all(b.reference for b in blocks),
    )


# ------------------------------------------------------------------ entrypoints


def chunk_content_list(content_list: list[dict[str, Any]]) -> list[Chunk]:
    """Chunk the parser's block list, keeping page and bbox per block.

    Block types follow the parser bundle schema: ``text`` with ``text_level`` on
    headings), ``table``, ``equation``, the picture types in
    :data:`_IMAGE_TYPES`, the prose types in :data:`_BODY_TEXT_TYPES`, and
    :data:`_LIST_TYPES`. Pictures contribute their caption or generated
    description; a bare one with neither adds nothing to retrieval and is
    skipped, as is the page furniture in :data:`_FURNITURE_TYPES`.

    Anything else is counted and logged rather than silently discarded. Parsers
    add block types between versions, and a type this function does not know
    about is content that vanishes from search with nothing failing.
    """
    stack: list[tuple[int, str]] = []
    pending: list[_Block] = []
    chunks: list[Chunk] = []
    unknown: dict[str, int] = {}
    furniture = _repeated_across_pages(content_list)

    def flush_section() -> None:
        if pending:
            chunks.extend(_pack(list(pending), _section_path(stack)))
            pending.clear()

    for item in content_list:
        if not isinstance(item, dict):
            continue
        page = item.get("page_idx")
        page_no = int(page) + 1 if isinstance(page, int) else None
        bbox = item.get("bbox") if isinstance(item.get("bbox"), list) else None
        kind = item.get("type")

        if kind == "text":
            text = clean_inline(str(item.get("text") or "")).strip()
            if not text:
                continue
            level = item.get("text_level")
            if isinstance(level, int) and level > 0:
                flush_section()
                _push_heading(stack, level, text)
                continue
            if _normalized(text) in furniture:
                continue
            pending.append(_Block(text, None, page_no, bbox))
        elif kind in _BODY_TEXT_TYPES:
            text = clean_inline(str(item.get("text") or "")).strip()
            if text and _normalized(text) not in furniture:
                pending.append(_Block(text, None, page_no, bbox))
        elif kind in _LIST_TYPES:
            # A reference list arrives as one block of many items and is the
            # only place a paper's citations exist in the parse.
            items = _as_list(item.get("list_items"))
            text = clean_inline("\n".join(items))
            if text:
                pending.append(
                    _Block(text, None, page_no, bbox, _is_reference_list(items))
                )
        elif kind == "table":
            body = flatten_table(str(item.get("table_body") or ""))
            caption = " ".join(_as_list(item.get("table_caption")))
            footnote = " ".join(_as_list(item.get("table_footnote")))
            text = clean_inline("\n".join(p for p in (caption, body, footnote) if p))
            if text:
                pending.append(_Block(text, None, page_no, bbox))
        elif kind == "equation":
            text = clean_inline(
                str(item.get("text") or item.get("latex") or "")
            ).strip()
            if text:
                pending.append(_Block(text, None, page_no, bbox))
        elif kind in _IMAGE_TYPES:
            caption = " ".join(
                _as_list(item.get("image_caption"))
                + _as_list(item.get("chart_caption"))
            )
            footnote = " ".join(
                _as_list(item.get("image_footnote"))
                + _as_list(item.get("chart_footnote"))
            )
            described = str(item.get("description") or "").strip()
            text = "\n".join(p for p in (caption, described, footnote) if p)
            if text:
                pending.append(_Block(f"[Figure] {text}", None, page_no, bbox))
        elif kind not in _FURNITURE_TYPES:
            unknown[str(kind)] = unknown.get(str(kind), 0) + 1

    if unknown:
        log.warning("dropped unrecognised content_list block types: %s", unknown)

    flush_section()
    return chunks


def _normalized(text: str) -> str:
    return " ".join(text.split())


def _repeated_across_pages(content_list: list[dict[str, Any]]) -> set[str]:
    """Text of non-heading blocks that recurs on ``_REPEATED_ON_PAGES`` pages."""
    pages: dict[str, set[int]] = {}
    for item in content_list:
        if not isinstance(item, dict) or item.get("type") not in _REPEATABLE_TYPES:
            continue
        if isinstance(item.get("text_level"), int) and item["text_level"] > 0:
            continue
        page = item.get("page_idx")
        text = _normalized(clean_inline(str(item.get("text") or "")))
        if text and isinstance(page, int):
            pages.setdefault(text, set()).add(page)
    return {text for text, seen in pages.items() if len(seen) >= _REPEATED_ON_PAGES}


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def chunk_markdown(text: str) -> list[Chunk]:
    """Chunk markdown by heading, with no page model."""
    stack: list[tuple[int, str]] = []
    pending: list[_Block] = []
    chunks: list[Chunk] = []

    def flush_section() -> None:
        if pending:
            chunks.extend(_pack(list(pending), _section_path(stack)))
            pending.clear()

    paragraph: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            joined = "\n".join(paragraph).strip()
            if joined:
                pending.append(_Block(joined))
            paragraph.clear()

    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            paragraph.append(line)
            continue
        if in_fence:
            paragraph.append(line)
            continue
        heading = _HEADING_RE.match(line.strip())
        if heading:
            flush_paragraph()
            flush_section()
            _push_heading(stack, len(heading.group(1)), heading.group(2).strip())
            continue
        if not line.strip():
            flush_paragraph()
            continue
        paragraph.append(line)

    flush_paragraph()
    flush_section()
    return chunks


def outline_from_chunks(chunks: list[Chunk]) -> list[dict[str, Any]]:
    """Distinct section headings in document order, for the file summary."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for chunk in chunks:
        if not chunk.section_path or chunk.section_path in seen:
            continue
        seen.add(chunk.section_path)
        out.append({"title": chunk.section_path, "pageStart": chunk.page_start})
    return out
