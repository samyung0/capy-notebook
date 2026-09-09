"""Benchmark-only table/figure packing; production chunking stays unchanged."""

from __future__ import annotations

import html
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "pipeline"))
from pipeline.config import cfg
from pipeline.retrieval.chunking import (
    Chunk,
    _as_list,
    _Block,
    _build,
    _normalized,
    _push_heading,
    _repeated_across_pages,
    chunk_content_list,
    clean_inline,
    clip_to_tokens,
    estimate_tokens,
)


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
    covered = {}
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


def table_html(
    headers: list[str], rows: list[list[str]], spans: list[dict] | None = None
) -> str:
    if not headers or any(len(row) != len(headers) for row in rows):
        raise ValueError("table row and header widths differ")
    covered = checked_spans(rows, spans) if spans is not None else {}
    head = "".join(f"<th>{html.escape(s)}</th>" for s in headers)
    body = ""
    for y, row in enumerate(rows):
        cells = []
        for x, value in enumerate(row):
            span = covered.get((y, x))
            if span and (y, x) != (span["row"], span["column"]):
                continue
            attrs = (
                f' rowspan="{span["rowspan"]}" colspan="{span["colspan"]}"'
                if span
                else ""
            )
            cells.append(f"<td{attrs}>{html.escape(value)}</td>")
        body += "<tr>" + "".join(cells) + "</tr>"
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def repair_encoded_text(blocks: list[dict], inventory: dict) -> int:
    """Remove only glyph aliases observed with zero width in this source page."""
    pairs = {
        page["page"]: set(page.get("zero_width_duplicate_glyphs", []))
        for page in inventory["pages"]
    }
    changed = 0

    def replace(text: str, aliases: set[str]) -> str:
        nonlocal changed
        for alias in aliases:
            if len(alias) != 2 or unicodedata.normalize("NFKC", alias[0]) != alias[1]:
                raise ValueError("invalid source-verified glyph alias")
            changed += text.count(alias)
            text = text.replace(alias, alias[1])
        return text

    for block in blocks:
        aliases = pairs[block["page_idx"]]
        for key in ["text", "latex", "list_items", "table_body", "image_caption"]:
            value = block.get(key)
            if isinstance(value, str):
                block[key] = replace(value, aliases)
            elif isinstance(value, list):
                block[key] = [replace(item, aliases) for item in value]
    return changed


def drop_exact_recovered_text(blocks: list[dict]) -> dict:
    """Drop a generated paragraph only when the same source-page text survives."""
    native = {
        (block.get("page_idx"), _normalized(block["text"]))
        for block in blocks
        if not block.get("_recovery") and isinstance(block.get("text"), str)
    }
    dropped = [
        block
        for block in blocks
        if block.get("_recovery") == "structured-page"
        and block.get("type") == "text"
        and (block.get("page_idx"), _normalized(block["text"])) in native
    ]
    identities = {id(block) for block in dropped}
    blocks[:] = [block for block in blocks if id(block) not in identities]
    return {"blocks": len(dropped), "characters": sum(len(b["text"]) for b in dropped)}


def structured_response(text: str, job: dict) -> list[dict]:
    """Validate model structure before attaching any generated content."""
    # Both wrappers preserve the same typed records. Do not repair malformed
    # JSON, coerce cell values or fill missing columns.
    fenced = re.fullmatch(r"\s*```(?:json)?\s*\n(.*)\n```\s*", text, re.DOTALL)
    if fenced:
        text = fenced[1]
    document = json.loads(text)
    if isinstance(document, list):
        document = {"blocks": document}
    if not isinstance(document, dict) or not isinstance(document.get("blocks"), list):
        raise TypeError("expected a blocks array")
    if not document["blocks"]:
        raise ValueError("empty structured response")
    output = []
    common = {
        "page_idx": job["page"],
        "bbox": job["bbox"],
        "_recovery": "structured-page",
        "_recovery_job": job["id"],
    }
    for block in document["blocks"]:
        if not isinstance(block, dict):
            raise TypeError("invalid block")
        kind = block.get("type")
        if kind == "table":
            title, headers, rows = (
                block.get("title"),
                block.get("headers"),
                block.get("rows"),
            )
            if (
                not isinstance(title, str)
                or not isinstance(headers, list)
                or not headers
                or not all(isinstance(h, str) for h in headers)
                or not isinstance(rows, list)
                or not rows
                or not all(
                    isinstance(r, list) and all(isinstance(c, str) for c in r)
                    for r in rows
                )
            ):
                raise ValueError("invalid table shape")
            spans = block.get("spans")
            if "spans" in block and not isinstance(spans, list):
                raise ValueError("table spans must be an array")
            metadata = block.get("metadata", [])
            if not isinstance(metadata, list) or not all(
                isinstance(v, str) for v in metadata
            ):
                raise ValueError("table metadata must be text")
            output.append(
                {
                    **common,
                    "type": "table",
                    "table_caption": [title] if title else [],
                    "table_body": table_html(headers, rows, spans),
                    **(
                        {"_table_spans": spans, "_table_rows": rows}
                        if spans is not None
                        else {}
                    ),
                    **({"table_footnote": metadata} if metadata else {}),
                }
            )
        elif kind in {"text", "figure"}:
            value = block.get("text")
            if not isinstance(value, str) or not value.strip():
                raise ValueError("missing block text")
            if kind == "text":
                output.append({**common, "type": "text", "text": value})
            else:
                if not isinstance(block.get("title"), str):
                    raise ValueError("missing figure title")
                output.append(
                    {
                        **common,
                        "type": "image",
                        "img_path": job["image"],
                        "image_caption": [block["title"]] if block["title"] else [],
                        "description": value,
                    }
                )
        else:
            raise ValueError("unsupported structured block")
    return output


def table_units(title: str, headers: list[str], rows: list[list[str]]) -> list[str]:
    prefix = "\n".join(
        s for s in [title, " | ".join(headers) if any(headers) else ""] if s
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


def caption_units(text: str) -> list[str]:
    """Keep paragraphs intact and repeat explicit Markdown table headers."""
    units = []
    for paragraph in re.split(r"\n\s*\n", text.strip()):
        lines = paragraph.splitlines()
        divider = next(
            (
                i
                for i, line in enumerate(lines)
                if "|" in line and re.fullmatch(r"[\s|:\-]+", line)
            ),
            None,
        )
        if divider is not None and divider > 0:

            def cells(line: str) -> list[str]:
                return [cell.strip() for cell in line.strip().strip("|").split("|")]

            headers = cells(lines[divider - 1])
            rows = [cells(line) for line in lines[divider + 1 :] if line.strip()]
            if rows and all(len(row) == len(headers) for row in rows):
                units.extend(
                    table_units("\n".join(lines[: divider - 1]), headers, rows)
                )
                continue
        if paragraph.strip():
            units.append(paragraph.strip())
    return units


def pack_units(units: list[str], prefix: str = "", *, budget: int) -> list[str]:
    """Pack whole paragraphs; repeat supplied context after unavoidable splits."""
    result, pending = [], []

    def joined(parts: list[str]) -> str:
        return "\n\n".join(s for s in [prefix, *parts] if s)

    for unit in units:
        if pending and estimate_tokens(joined([*pending, unit])) > budget:
            # Keep an explicit numbered/Markdown heading with the next paragraph.
            # This changes packing only; it does not invent a heading hierarchy.
            if re.fullmatch(r"(?:#{1,6}|\d+(?:\.\d+)*\.?)\s+[^\n]+", pending[-1]):
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


def chunk_structured(blocks: list[dict], *, figure_tokens: int = 400) -> list[Chunk]:
    """Use Capy packing for prose and explicitly bounded structural units."""
    chunks, pending = [], []
    stack: list[tuple[int, str]] = []
    furniture = _repeated_across_pages(blocks)
    recovery = False

    def seed() -> list[dict]:
        return [
            {"type": "text", "text_level": level, "text": title}
            for level, title in stack
        ]

    def flush() -> None:
        if pending:
            chunks.extend(chunk_content_list(([] if recovery else seed()) + pending))
            pending.clear()

    for block in blocks:
        block_recovery = block.get("_recovery") in {"caption-page", "structured-page"}
        if block_recovery != recovery:
            flush()
            recovery = block_recovery
        kind = block.get("type")
        if (
            kind == "text"
            and isinstance(block.get("text_level"), int)
            and block["text_level"] > 0
        ):
            flush()
            _push_heading(
                stack, block["text_level"], clean_inline(block.get("text", ""))
            )
            continue
        if (
            kind in {"text", "header", "page_footnote"}
            and _normalized(clean_inline(block.get("text", ""))) in furniture
        ):
            continue
        if kind not in {"table", "image", "chart"}:
            pending.append(block)
            continue
        flush()
        prefix = ""
        if kind == "table":
            parser = Table()
            parser.feed(block.get("table_body", ""))
            parser.close()
            headers, rows = parser.grid()
            if block.get("_table_spans"):
                original_rows = block["_table_rows"]
                covered = checked_spans(original_rows, block["_table_spans"])
                # Repeat the source scope at each occupied position, including
                # later row chunks; never imply independent treatment values.
                for (y, x), span in covered.items():
                    start = span["column"]
                    columns = "; ".join(headers[start : start + span["colspan"]])
                    first, last = span["row"] + 1, span["row"] + span["rowspan"]
                    value = original_rows[span["row"]][span["column"]]
                    rows[y][x] = (
                        f"{value} [one merged source cell, rows {first}-{last}; columns {columns}]"
                    )
            title = " ".join(_as_list(block.get("table_caption")))
            units = table_units(title, headers, rows)
            footnotes = _as_list(block.get("table_footnote"))
            if footnotes:
                units.append("\n".join(footnotes))
        else:
            title = " ".join(
                _as_list(block.get("image_caption"))
                + _as_list(block.get("chart_caption"))
            )
            text = "\n\n".join(
                s
                for s in [
                    str(block.get("description") or ""),
                    " ".join(
                        _as_list(block.get("image_footnote"))
                        + _as_list(block.get("chart_footnote"))
                    ),
                ]
                if s
            )
            units = caption_units(text) or ([""] if title else [])
            prefix = "[Figure] " + title
            if not text and title:
                units = [title]
                prefix = "[Figure]"
        budget = cfg.chunk_tokens if kind == "table" else figure_tokens
        for text in pack_units([clean_inline(u) for u in units], prefix, budget=budget):
            section = (
                ""
                if block.get("_recovery") in {"caption-page", "structured-page"}
                else " › ".join(title for _, title in stack)
            )
            page = block.get("page_idx")
            chunks.append(
                _build(
                    [
                        _Block(
                            text,
                            page=page + 1 if isinstance(page, int) else None,
                            bbox=block.get("bbox"),
                        )
                    ],
                    section,
                )
            )
    flush()
    return chunks
