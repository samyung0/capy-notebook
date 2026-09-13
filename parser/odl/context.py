"""Attach adjacent explicit captions and units to native tables and record
their explicit body spans, so the chunker sees each table with its title."""

from __future__ import annotations

import copy
import re

from .table_html import Table

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
    """The lab's non-strict pass: unsupported tables keep ordinary packing."""
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
        # Only adjacent, explicit captions above a table. Captions below it,
        # distant units and unlabelled section titles stay untouched.
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
