"""The lab's ODL packer, folded into production chunking.

``bench/rag/scripts/odl_agentic_prepare.py::pack_odl`` built the index the
twelve-question acceptance was measured on:
``experiment_odl_table_integration.stable_chunks`` (the parser's frozen
furniture, then ``chunk_native_bounded``) followed by heading retention. This
module is that packer; :func:`pack_blocks` must produce the lab's
``chunks.json`` for a refined bundle, which ``tests/test_packing.py`` pins
with a saved source.

Two behaviours differ from :func:`chunking.chunk_content_list` alone:

- Furniture is the set the parser decided on the block list *before*
  source-geometry table recovery (bundle ``refinement.json``); no new
  recurrence is inferred on the replaced list.
- A table with explicit native headers (``_native_table_supported``) is its
  own chunk(s): header row repeated per row group, merged source cells noted
  from ``_table_spans``, and the adjacent caption (``_native_table_title``)
  as the section path.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from html.parser import HTMLParser

from ..config import cfg
from .chunking import (
    Chunk,
    _as_list,
    _Block,
    _build,
    _normalized,
    _push_heading,
    chunk_content_list,
    clean_inline,
    clip_to_tokens,
    estimate_tokens,
)

# ---------------------------------------------------------------- HTML tables
# Same reader as parser/odl/table_html.py (the parser cannot import the
# pipeline); tests/test_packing.py pins the two copies equal.


@dataclass
class Cell:
    text: str
    header: bool
    rowspan: int
    colspan: int


class Table(HTMLParser):
    """Read explicit cell spans and header tags, without guessing headers."""

    def __init__(self) -> None:
        super().__init__()
        self.rows: list[list[Cell]] = []
        self.cell: Cell | None = None
        self.thead = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "thead":
            self.thead = True
        elif tag == "tr":
            self.rows.append([])
        elif tag in {"td", "th"}:
            if not self.rows or self.cell is not None:
                raise ValueError("invalid table cell nesting")
            values = dict(attrs)
            spans = [int(values.get(key, "1")) for key in ["rowspan", "colspan"]]
            if any(value < 1 or value > 1000 for value in spans):
                raise ValueError("invalid table span")
            self.cell = Cell("", self.thead or tag == "th", *spans)
        elif tag == "br" and self.cell:
            self.cell.text += " "

    def handle_endtag(self, tag: str) -> None:
        if tag == "thead":
            self.thead = False
        elif tag in {"td", "th"} and self.cell:
            self.cell.text = " ".join(self.cell.text.split())
            self.rows[-1].append(self.cell)
            self.cell = None

    def handle_data(self, data: str) -> None:
        if self.cell:
            self.cell.text += data

    def grid(self) -> tuple[list[str], list[list[str]]]:
        cells: dict[tuple[int, int], Cell] = {}
        for row_index, row in enumerate(self.rows):
            column = 0
            for cell in row:
                while (row_index, column) in cells:
                    column += 1
                if column + cell.colspan > 1000:
                    raise ValueError("table is too wide")
                for y in range(row_index, row_index + cell.rowspan):
                    for x in range(column, column + cell.colspan):
                        if (y, x) in cells or y >= len(self.rows):
                            raise ValueError("overlapping or incomplete table span")
                        cells[y, x] = cell
                column += cell.colspan
        width = max((x + 1 for _, x in cells), default=0)
        header_count = 0
        for row in self.rows:
            if not row or not all(cell.header for cell in row):
                break
            header_count += 1
        headers = []
        for x in range(width):
            path = []
            for y in range(header_count):
                cell = cells.get((y, x))
                if cell and cell.text and (not path or cell.text != path[-1]):
                    path.append(cell.text)
            headers.append(" / ".join(path))
        rows = [
            [cells[y, x].text if (y, x) in cells else "" for x in range(width)]
            for y in range(header_count, len(self.rows))
        ]
        return headers, rows


def checked_spans(rows: list[list[str]], spans: list[dict]) -> dict:
    """Bind explicit body spans to their single nonempty origin cell."""
    covered: dict[tuple[int, int], dict] = {}
    if not isinstance(spans, list):
        raise TypeError("table spans must be an array")
    for span in spans:
        keys = {"row", "column", "rowspan", "colspan"}
        if not isinstance(span, dict) or set(span) != keys:
            raise ValueError("invalid table span fields")
        if any(type(span[k]) is not int for k in keys):
            raise ValueError("table span indices must be integers")
        y, x, height, width = (span[k] for k in ["row", "column", "rowspan", "colspan"])
        if (
            min(y, x) < 0
            or min(height, width) < 1
            or height * width < 2
            or y + height > len(rows)
            or x + width > len(rows[0])
        ):
            raise ValueError("table span exceeds its data grid")
        if not rows[y][x].strip():
            raise ValueError("a merged data cell has no origin value")
        for row in range(y, y + height):
            for col in range(x, x + width):
                if (row, col) in covered:
                    raise ValueError("overlapping table spans")
                if (row, col) != (y, x) and rows[row][col]:
                    raise ValueError("a covered cell contains independent text")
                covered[row, col] = span
    return covered


# ------------------------------------------------------------- table context
# Same pass as parser/odl/context.py. The parser already ran it; the lab ran
# it again on the furniture-free list, where a caption the furniture block
# had hidden becomes adjacent, so the packer repeats it for the same result.

CAPTION = re.compile(
    r"^(?:table(?:au)?|tabla|tabelle|tab\.?|表)\s*[0-9０-９]+", re.IGNORECASE
)
UNIT = re.compile(r"^[（(][^()（）\n]{1,24}[)）]$")


def native_spans(parser: Table) -> tuple[list[list[str]], list[dict]]:
    """Recover native HTML span origins, leaving covered body positions empty."""
    headers, rows = parser.grid()
    head = len(parser.rows) - len(rows)
    occupied: set[tuple[int, int]] = set()
    spans = []
    original = [[""] * len(headers) for _ in rows]
    for y, cells in enumerate(parser.rows):
        x = 0
        for cell in cells:
            while (y, x) in occupied:
                x += 1
            for yy in range(y, y + cell.rowspan):
                for xx in range(x, x + cell.colspan):
                    occupied.add((yy, xx))
            if y < head < y + cell.rowspan:
                raise ValueError("native span crosses the header/body boundary")
            if y >= head:
                original[y - head][x] = cell.text
                if cell.rowspan * cell.colspan > 1 and cell.text:
                    spans.append(
                        {
                            "row": y - head,
                            "column": x,
                            "rowspan": cell.rowspan,
                            "colspan": cell.colspan,
                        }
                    )
            x += cell.colspan
    return original, spans


def contextualize(blocks: list[dict]) -> list[dict]:
    """Attach adjacent explicit captions and units to native tables."""
    result = copy.deepcopy(blocks)
    for index, block in enumerate(result):
        if block.get("type") != "table":
            continue
        parser = Table()
        try:
            parser.feed(block.get("table_body", ""))
            parser.close()
            rows, spans = native_spans(parser)
            if not any(parser.grid()[0]):
                raise ValueError("no explicit native column headers")
        except ValueError:
            continue
        block["_native_table_supported"] = True
        if spans and not block.get("_table_spans"):
            block.update(_table_rows=rows, _table_spans=spans)
        box = block.get("bbox")
        context = []
        if box and not block.get("table_caption"):
            for previous in range(index - 1, max(-1, index - 4), -1):
                candidate = blocks[previous]
                text = candidate.get("text", "").strip()
                bounds = candidate.get("bbox")
                if (
                    candidate.get("type") != "text"
                    or candidate.get("page_idx") != block.get("page_idx")
                    or not bounds
                    or not 0 <= box[1] - bounds[3] <= 60
                    or min(box[2], bounds[2]) <= max(box[0], bounds[0])
                ):
                    break
                if CAPTION.match(text):
                    context.insert(0, (previous, text, bounds))
                    break
                if UNIT.fullmatch(text):
                    context.insert(0, (previous, text, bounds))
                    continue
                break
        if context and CAPTION.match(context[0][1]):
            block["table_caption"] = [item[1] for item in context]
            block["_native_table_title"] = context[0][1]
            block["bbox"] = [
                min(box[0], *(item[2][0] for item in context)),
                min(box[1], *(item[2][1] for item in context)),
                max(box[2], *(item[2][2] for item in context)),
                max(box[3], *(item[2][3] for item in context)),
            ]
    return result


# ------------------------------------------------------------- table packing


def table_units(title: str, headers: list[str], rows: list[list[str]]) -> list[str]:
    """Repeat table context when it fits; otherwise pack it once in source order."""
    prefix = "\n".join(
        s for s in [title, " | ".join(headers) if any(headers) else ""] if s
    )
    if estimate_tokens(clean_inline(prefix) + "\n\n") >= cfg.chunk_tokens:
        # Repeating these headers leaves no room for even one row fragment.
        return pack_units(
            [clean_inline(prefix), *(clean_inline(" | ".join(row)) for row in rows)],
            budget=cfg.chunk_tokens,
        )
    units, current = [], []
    for row in rows:
        line = " | ".join(row)
        candidate = "\n".join(s for s in [prefix, *current, line] if s)
        if current and estimate_tokens(clean_inline(candidate)) > cfg.chunk_tokens:
            units.append("\n".join(s for s in [prefix, *current] if s))
            current = []
        if estimate_tokens(clean_inline(f"{prefix}\n{line}")) > cfg.chunk_tokens:
            # A single oversized row must split, but each piece retains its headers.
            units.extend(
                pack_units(
                    [clean_inline(line)], clean_inline(prefix), budget=cfg.chunk_tokens
                )
            )
            continue
        current.append(line)
    if current or (not rows and prefix):
        units.append("\n".join(s for s in [prefix, *current] if s))
    return units


_KEPT_HEADING = re.compile(r"(?:#{1,6}|\d+(?:\.\d+)*\.?)\s+[^\n]+")


def pack_units(units: list[str], prefix: str = "", *, budget: int) -> list[str]:
    """Pack whole units; repeat the supplied context after unavoidable splits."""
    result, pending = [], []

    def joined(parts: list[str]) -> str:
        return "\n\n".join(s for s in [prefix, *parts] if s)

    for unit in units:
        if pending and estimate_tokens(joined([*pending, unit])) > budget:
            # Keep an explicit numbered/Markdown heading with the next paragraph.
            if _KEPT_HEADING.fullmatch(pending[-1]):
                unit = pending.pop() + "\n\n" + unit
            if pending:
                result.append(joined(pending))
            pending = []
        while estimate_tokens(joined([unit])) > budget:
            available = budget - estimate_tokens(prefix + "\n\n")
            if available < 1:
                raise ValueError("structural context exceeds the chunk budget")
            window = clip_to_tokens(unit, available)
            cut = (
                max(
                    window.rfind("。"),
                    window.rfind(". "),
                    window.rfind("\n"),
                    window.rfind("！"),
                )
                + 1
            )
            if cut < len(window) // 2:
                cut = len(window)
            result.append(joined([unit[:cut].strip()]))
            unit = unit[cut:].strip()
        if unit:
            pending.append(unit)
    if pending:
        result.append(joined(pending))
    return result


def table_chunks(block: dict) -> list[Chunk]:
    """One native table as its own chunk(s), section path left to the caller."""
    if block.get("type") != "table":
        # A native table the parser later relabelled (a footer) packs, and
        # for furniture types drops, like any other block.
        return chunk_content_list([block], furniture=frozenset())
    parser = Table()
    parser.feed(block.get("table_body", ""))
    parser.close()
    headers, rows = parser.grid()
    if block.get("_table_spans"):
        original_rows = block["_table_rows"]
        covered = checked_spans(original_rows, block["_table_spans"])
        # Repeat the source scope at each occupied position, including later
        # row chunks; never imply independent treatment values.
        for (y, x), span in covered.items():
            start = span["column"]
            columns = "; ".join(headers[start : start + span["colspan"]])
            first, last = span["row"] + 1, span["row"] + span["rowspan"]
            value = original_rows[span["row"]][span["column"]]
            rows[y][x] = (
                f"{value} [one merged source cell, rows {first}-{last}; columns {columns}]"
            )
    styles = block.get("_table_source_styles", [])
    if not isinstance(styles, list):
        raise TypeError("table source styles must be a list")
    seen = set()
    for cell in styles:
        if not isinstance(cell, dict):
            raise TypeError("table source style must identify a cell")
        row, column, labels = cell.get("row"), cell.get("column"), cell.get("styles")
        if (
            type(row) is not int
            or type(column) is not int
            or not 0 <= row < len(rows)
            or not 0 <= column < len(rows[row])
            or not isinstance(labels, list)
            or not labels
            or any(label not in ("bold", "gray background") for label in labels)
            or len(set(labels)) != len(labels)
            or (row, column) in seen
        ):
            raise ValueError("invalid or ambiguous table source style")
        seen.add((row, column))
        for label in labels:
            note = f"[{label} in source]"
            if note not in rows[row][column]:
                rows[row][column] += f" {note}"
    title = " ".join(_as_list(block.get("table_caption")))
    units = table_units(title, headers, rows)
    footnotes = _as_list(block.get("table_footnote"))
    if footnotes:
        units.append("\n".join(footnotes))
    page = block.get("page_idx")
    return [
        _build(
            [
                _Block(
                    text,
                    page=page + 1 if isinstance(page, int) else None,
                    bbox=block.get("bbox"),
                )
            ],
            "",
        )
        for text in pack_units(
            [clean_inline(u) for u in units], "", budget=cfg.chunk_tokens
        )
    ]


def _is_furniture(block: dict, furniture: frozenset[str]) -> bool:
    return (
        block.get("type") in {"text", "header", "page_footnote"}
        and not block.get("text_level", 0)
        and _normalized(clean_inline(block.get("text", ""))) in furniture
    )


def pack_blocks(blocks: list[dict], furniture: frozenset[str]) -> list[Chunk]:
    """``stable_chunks`` then ``chunk_native_bounded`` with the frozen furniture."""
    prepared = contextualize([b for b in blocks if not _is_furniture(b, furniture)])
    if not any(b.get("_native_table_supported") for b in prepared):
        return chunk_content_list(prepared, furniture=frozenset())
    chunks: list[Chunk] = []
    pending: list[dict] = []
    seed: list[dict] = []
    stack: list[tuple[int, str]] = []

    def flush() -> None:
        if pending:
            chunks.extend(chunk_content_list(seed + pending, furniture=frozenset()))
            pending.clear()
        # The next prose run starts under the headings seen so far.
        seed[:] = [
            {"type": "text", "text_level": level, "text": text} for level, text in stack
        ]

    for block in prepared:
        if block.get("type") == "text" and block.get("text_level", 0) > 0:
            _push_heading(stack, block["text_level"], block["text"])
        if not block.get("_native_table_supported"):
            pending.append(block)
            continue
        flush()
        for chunk in table_chunks(block):
            chunk.section_path = block.get("_native_table_title") or " › ".join(
                text for _, text in stack
            )
            chunks.append(chunk)
    flush()
    return chunks
