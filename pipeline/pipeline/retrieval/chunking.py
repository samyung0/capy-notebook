"""Turn a parsed document into retrievable chunks.

Two entry points, one output shape:

- :func:`chunk_content_list` consumes MinerU's ``content_list.json`` (the
  'advanced' parse route), which carries a heading level and a page + bounding
  box per block. That structure is the whole reason citations can name a page.
- :func:`chunk_markdown` consumes plain markdown (txt/md uploads and the
  'normal' parse route, whose cloud API returns markdown only). Headings still
  give section paths; there is no page model, so pages stay null.

Both split on structure first and only fall back to length, so a chunk is a
section or a run of consecutive blocks rather than an arbitrary window. Chunks
carry two strings: ``text`` is what a citation shows and what the model reads,
``indexed_text`` prepends the file name and heading breadcrumb before embedding
and tokenizing. That prefix is what makes an isolated passage retrievable by a
query phrased in the document's terms rather than the paragraph's.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..config import cfg

# MinerU normalizes bbox coordinates to a 0..1000 box with the origin at the
# top-left of the page. Recorded per region so a renderer never has to infer it.
BBOX_SPACE = "mineru-1000-lefttop"

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*$")


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

    def indexed_text(self, file_name: str) -> str:
        header = file_name
        if self.section_path:
            header = f"{file_name} › {self.section_path}"
        return f"{header}\n\n{self.text}"


@dataclass
class _Block:
    """One parsed source block, normalized across both input formats."""

    text: str
    level: int | None = None  # heading level, None for body content
    page: int | None = None
    bbox: list[float] | None = None


# --------------------------------------------------------------- CJK handling

# Postgres' built-in text search configurations tokenize on whitespace and
# punctuation, which produces exactly one token for a Chinese sentence. Every
# multilingual option that fixes this properly (PGroonga, pg_bigm, zhparser) is
# an extension we would have to build into the Postgres image. Bigramming CJK
# runs in the application and indexing with the 'simple' configuration gets the
# same recall from a stock image, at the cost of a larger tsvector.
_CJK_RANGES = (
    (0x3040, 0x30FF),  # kana
    (0x3400, 0x4DBF),  # CJK ext A
    (0x4E00, 0x9FFF),  # CJK unified
    (0xF900, 0xFAFF),  # compatibility ideographs
    (0xAC00, 0xD7AF),  # hangul syllables
)


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return any(lo <= code <= hi for lo, hi in _CJK_RANGES)


def tokenize_for_search(text: str) -> str:
    """Rewrite text so `to_tsvector('simple', ...)` indexes CJK usefully.

    Latin runs pass through untouched; each CJK run becomes its overlapping
    character bigrams (plus the single character, when the run is one long).
    Queries must be tokenized with the same function — see
    :func:`search_query_terms`.
    """
    out: list[str] = []
    run: list[str] = []

    def flush() -> None:
        if not run:
            return
        chars = "".join(run)
        if len(chars) == 1:
            out.append(chars)
        else:
            out.extend(chars[i : i + 2] for i in range(len(chars) - 1))
        run.clear()

    for ch in text:
        if _is_cjk(ch):
            run.append(ch)
        else:
            flush()
            out.append(ch)
    flush()
    return " ".join(out) if any(_is_cjk(c) for c in text) else text


def search_query_terms(query: str) -> str:
    """Build a `websearch_to_tsquery`-safe string matching the index tokens."""
    tokenized = tokenize_for_search(query)
    # websearch syntax treats bare words as AND; OR keeps recall usable when a
    # long question shares only part of its vocabulary with the passage.
    words = [w for w in re.split(r"\s+", tokenized) if w and w not in "&|!():*"]
    return " or ".join(words[:40])


# ------------------------------------------------------------ block assembly


def _section_path(stack: list[tuple[int, str]]) -> str:
    return " › ".join(title for _, title in stack)


def _push_heading(stack: list[tuple[int, str]], level: int, title: str) -> None:
    while stack and stack[-1][0] >= level:
        stack.pop()
    stack.append((level, title))


def _pack(blocks: list[_Block], section_path: str) -> list[Chunk]:
    """Pack consecutive blocks of one section into size-bounded chunks.

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
            if carried >= cfg.chunk_overlap_chars:
                break
            carry.insert(0, blk)
            carried += len(blk.text)
        current.clear()
        if carried < cfg.chunk_chars // 2:
            current.extend(carry)
        size = sum(len(b.text) for b in current)

    for block in blocks:
        text = block.text.strip()
        if not text:
            continue
        if len(text) > cfg.chunk_chars:
            flush()
            for piece in _split_long(text):
                chunks.append(
                    _build([_Block(piece, None, block.page, block.bbox)], section_path)
                )
            continue
        if size + len(text) > cfg.chunk_chars and current:
            flush()
        current.append(block)
        size += len(text)

    if current:
        chunks.append(_build(current, section_path))
    return [c for c in chunks if len(c.text) >= cfg.chunk_min_chars or len(chunks) == 1]


def _split_long(text: str) -> list[str]:
    """Last-resort split of one oversized block, preferring sentence ends."""
    pieces: list[str] = []
    remaining = text
    while len(remaining) > cfg.chunk_chars:
        window = remaining[: cfg.chunk_chars]
        cut = max(
            window.rfind("。"),
            window.rfind(". "),
            window.rfind("\n"),
            window.rfind("！"),
        )
        if cut < cfg.chunk_chars // 2:
            cut = cfg.chunk_chars
        pieces.append(remaining[: cut + 1].strip())
        remaining = remaining[cut + 1 :]
    if remaining.strip():
        pieces.append(remaining.strip())
    return pieces


def _build(blocks: list[_Block], section_path: str) -> Chunk:
    pages = [b.page for b in blocks if b.page is not None]
    regions = [
        Region(page=b.page, bbox=[float(x) for x in b.bbox])
        for b in blocks
        if b.page is not None and b.bbox and len(b.bbox) == 4
    ]
    return Chunk(
        text="\n\n".join(b.text.strip() for b in blocks if b.text.strip()),
        section_path=section_path,
        page_start=min(pages) if pages else None,
        page_end=max(pages) if pages else None,
        regions=regions,
    )


# ------------------------------------------------------------------ entrypoints


def chunk_content_list(content_list: list[dict[str, Any]]) -> list[Chunk]:
    """Chunk MinerU's block list, keeping page and bbox per block.

    Block types follow MinerU's schema: ``text`` (with ``text_level`` set on
    headings), ``table``, ``equation``, ``image``. Images contribute their
    caption or generated description; a bare image with neither adds nothing to
    retrieval and is skipped.
    """
    stack: list[tuple[int, str]] = []
    pending: list[_Block] = []
    chunks: list[Chunk] = []

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
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            level = item.get("text_level")
            if isinstance(level, int) and level > 0:
                flush_section()
                _push_heading(stack, level, text)
                continue
            pending.append(_Block(text, None, page_no, bbox))
        elif kind == "table":
            body = str(item.get("table_body") or "").strip()
            caption = " ".join(_as_list(item.get("table_caption")))
            footnote = " ".join(_as_list(item.get("table_footnote")))
            text = "\n".join(p for p in (caption, body, footnote) if p)
            if text:
                pending.append(_Block(text, None, page_no, bbox))
        elif kind == "equation":
            text = str(item.get("text") or item.get("latex") or "").strip()
            if text:
                pending.append(_Block(text, None, page_no, bbox))
        elif kind == "image":
            caption = " ".join(_as_list(item.get("image_caption")))
            described = str(item.get("description") or "").strip()
            text = "\n".join(p for p in (caption, described) if p)
            if text:
                pending.append(_Block(f"[Figure] {text}", None, page_no, bbox))

    flush_section()
    return chunks


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
