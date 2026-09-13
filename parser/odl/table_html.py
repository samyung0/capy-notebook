"""Explicit HTML table reading and writing: spans and header tags are read as
written, never guessed."""

from __future__ import annotations

import html
from dataclasses import dataclass
from html.parser import HTMLParser


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
