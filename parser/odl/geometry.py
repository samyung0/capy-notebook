"""Ruled-table recovery from source text geometry.

Rows and columns come from glyph positions and horizontal rules; unsupported
layouts raise ``ValueError`` so the caller keeps the native table.
"""

from __future__ import annotations

import copy
import math
import re
import statistics

import pymupdf

from .table_html import table_html

# The lab recovered every table with the integration module's wider value
# pattern patched in, so it is the only numeric pattern here.
NUMBER = re.compile(
    r"[+−-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\([+−-]?\d+(?:\.\d+)?\))"
    r"(?:[·×]10\^[+−-]?\d+)?(?:[%#@*]+)?"
    r"(?:\([↑↓]?[+−-]?\d[\d,.]*[↑↓]?\))?"
)
# Text blocks only: image payloads in the dict are never read here.
TEXT_FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
CAPTION = re.compile(r"^(?:Table|表)\s*\d+\s*[:：.]?", re.IGNORECASE)
SECTION = re.compile(r"^\d+\.\d+(?:\.\d+)*$")


def text_lines(page: pymupdf.Page) -> list[dict]:
    out = []
    for block in page.get_text("dict", flags=TEXT_FLAGS)["blocks"]:
        for line in block.get("lines", []):
            if abs(line["dir"][0] - 1) > 0.01 or abs(line["dir"][1]) > 0.01:
                continue
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = "".join(
                (
                    "^"
                    if s["flags"] & 1 and re.fullmatch(r"[+−-]?\d+", s["text"].strip())
                    else ""
                )
                + s["text"]
                for s in line["spans"]
            ).strip()
            primary = [
                s for s in spans if not s["flags"] & 1 and s["text"].strip() != "*"
            ]
            if not primary:
                primary = spans
            box = [
                min(s["bbox"][0] for s in spans),
                min(s["bbox"][1] for s in spans),
                max(s["bbox"][2] for s in spans),
                max(s["bbox"][3] for s in spans),
            ]
            ink = [s for s in spans if s["text"].strip() != "*"] or spans
            out.append(
                {
                    "text": text,
                    "bbox": box,
                    "y": statistics.median(s["origin"][1] for s in primary),
                    "x": (
                        min(s["bbox"][0] for s in ink) + max(s["bbox"][2] for s in ink)
                    )
                    / 2,
                    "size": max(s["size"] for s in primary),
                    "bold": all(
                        s["flags"] & 16
                        for s in spans
                        if re.search(r"[\w\d]", s["text"])
                    ),
                }
            )
    return out


def row_groups(lines: list[dict], tolerance: float = 2.0) -> list[list[dict]]:
    groups: list[list[dict]] = []
    for line in sorted(lines, key=lambda x: x["y"]):
        if (
            not groups
            or line["y"] - statistics.median(x["y"] for x in groups[-1]) > tolerance
        ):
            groups.append([])
        groups[-1].append(line)
    return [sorted(g, key=lambda x: x["bbox"][0]) for g in groups]


def horizontal_rules(page: pymupdf.Page) -> list[list[float]]:
    rules = []
    for drawing in page.get_drawings():
        for item in drawing["items"]:
            if item[0] == "l":
                a, b = item[1:3]
                if abs(a.y - b.y) <= 1 and abs(a.x - b.x) >= page.rect.width * 0.35:
                    rules.append([min(a.x, b.x), (a.y + b.y) / 2, max(a.x, b.x)])
            elif item[0] == "re":
                rect = item[1]
                if rect.height <= 2 and rect.width >= page.rect.width * 0.35:
                    rules.append([rect.x0, (rect.y0 + rect.y1) / 2, rect.x1])
    unique: list[list[float]] = []
    for rule in sorted(rules):
        if not any(max(abs(a - b) for a, b in zip(rule, r)) < 1 for r in unique):
            unique.append(rule)
    return unique


def numeric(line: dict) -> bool:
    return bool(NUMBER.fullmatch(re.sub(r"\s+", "", line["text"])))


def clusters(values, tolerance: float = 6) -> list[list[float]]:
    groups: list[list[float]] = []
    for value in sorted(values):
        if not groups or value - statistics.mean(groups[-1]) > tolerance:
            groups.append([])
        groups[-1].append(value)
    return groups


def table_from_region(page: pymupdf.Page, rect, all_lines: list[dict]) -> dict:
    """Reject unsupported layouts rather than guessing a missing column."""
    x0, y0, x1, y1 = rect
    lines = [
        l
        for l in all_lines
        if x0 - 1 <= l["x"] <= x1 + 1
        and y0 - 16 <= l["y"] <= y1 + 1
        and (
            l["y"] >= y0
            or numeric(l)
            and l["bbox"][2] - l["bbox"][0] < (x1 - x0) * 0.25
        )
    ]
    groups = row_groups(lines)
    start = next(
        (
            i
            for i, g in enumerate(groups)
            if any(numeric(l) for l in g)
            and any(
                not numeric(l)
                and l["bbox"][2] < min(n["bbox"][0] for n in g if numeric(n))
                for l in g
            )
        ),
        None,
    )
    if start is None:
        raise ValueError("no labelled numeric body row")
    body_groups = [g for g in groups[start:] if any(numeric(l) for l in g)]
    if len(body_groups) < 2:
        raise ValueError("fewer than two numeric body rows")
    support = min(3, max(2, math.ceil(len(body_groups) * 0.3)))
    modes = clusters([l["x"] for g in body_groups for l in g if numeric(l)])
    centers = [statistics.mean(g) for g in modes if len(g) >= support]
    if len(centers) < 2:
        raise ValueError("fewer than two repeated numeric columns")
    first_x = min(l["bbox"][0] for g in body_groups for l in g if numeric(l))
    labels = [
        l for g in body_groups for l in g if not numeric(l) and l["bbox"][2] < first_x
    ]
    if not labels:
        raise ValueError("no row-label column")
    split = (max(l["bbox"][2] for l in labels) + first_x) / 2
    header_lines = [l for g in groups[:start] for l in g]
    headers: list[list[str]] = [[] for _ in range(len(centers) + 1)]
    scopes = []
    for line in header_lines:
        if line["bbox"][2] < split:
            headers[0].append(line["text"])
            continue
        peers = [
            p
            for p in header_lines
            if p is not line
            and p["bbox"][2] > split
            and min(p["bbox"][3], line["bbox"][3]) - max(p["bbox"][1], line["bbox"][1])
            > 0.2 * min(p["size"], line["size"])
        ]
        left = max(
            (p["bbox"][2] for p in peers if p["bbox"][2] <= line["bbox"][0]),
            default=split,
        )
        right = min(
            (p["bbox"][0] for p in peers if p["bbox"][0] >= line["bbox"][2]), default=x1
        )
        lo = split if left == split else (left + line["bbox"][0]) / 2
        hi = x1 if right == x1 else (right + line["bbox"][2]) / 2
        columns = [i + 1 for i, c in enumerate(centers) if lo <= c <= hi]
        if not any(p["y"] > line["y"] + 2 and lo <= p["x"] <= hi for p in header_lines):
            columns = [
                min(range(len(centers)), key=lambda i: abs(centers[i] - line["x"])) + 1
            ]
        if not columns:
            raise ValueError("header has no aligned data column")
        scopes.append({"text": line["text"], "columns": columns, "bbox": line["bbox"]})
        for column in columns:
            headers[column].append(line["text"])
    joined = [" / ".join(items) for items in headers]
    if any(not h for h in joined[1:]):
        raise ValueError("a numeric column lacks source headers")
    baselines = [statistics.median(l["y"] for l in g) for g in body_groups]
    rows = [[""] * len(joined) for _ in body_groups]
    bold = []
    spans = []
    assignments = []
    for line in [l for g in groups[start:] for l in g]:
        row = min(range(len(baselines)), key=lambda i: abs(baselines[i] - line["y"]))
        if line["bbox"][2] <= split:
            column = 0
            span = 1
        else:
            nearest = min(
                range(len(centers)), key=lambda i: abs(centers[i] - line["x"])
            )
            column = nearest + 1
            span = 1
            if numeric(line) and abs(centers[nearest] - line["x"]) > 6:
                options = [
                    (i + 1, j - i + 1)
                    for i in range(len(centers))
                    for j in range(i + 1, len(centers))
                    if abs(statistics.mean(centers[i : j + 1]) - line["x"]) < 3
                    and any(s["columns"] == list(range(i + 1, j + 2)) for s in scopes)
                ]
                if len(options) != 1:
                    raise ValueError(
                        "numeric value between columns has ambiguous shared scope"
                    )
                column, span = options[0]
                spans.append(
                    {"row": row, "column": column, "rowspan": 1, "colspan": span}
                )
        if rows[row][column]:
            rows[row][column] += " "
        rows[row][column] += line["text"]
        if line["bold"] and numeric(line):
            bold.append([row, column])
        assignments.append(
            {
                "row": row,
                "column": column,
                "colspan": span,
                "text": line["text"],
                "bbox": line["bbox"],
            }
        )
    for s in spans:
        if any(
            rows[s["row"]][c]
            for c in range(s["column"] + 1, s["column"] + s["colspan"])
        ):
            raise ValueError("shared cell overlaps independent source text")
    captions = []
    for line in all_lines:
        if CAPTION.match(line["text"]) and (
            0 <= y0 - line["bbox"][3] <= 45 or 0 <= line["bbox"][1] - y1 <= 35
        ):
            captions.append(line)
    if len(captions) > 1:
        raise ValueError("multiple nearby table captions")
    title = captions[0]["text"] if captions else ""
    if captions and captions[0]["y"] < y0:
        extra = [
            l
            for l in all_lines
            if captions[0]["y"] + 2 < l["y"] < y0 and l["bbox"][0] <= x0 + 20
        ]
        title += " " + " ".join(l["text"] for l in extra)
    if not captions:
        headings = [
            l
            for l in all_lines
            if SECTION.fullmatch(l["text"])
            and l["bbox"][0] < x0 + 0.15 * (x1 - x0)
            and 0 < y0 - l["y"] < 70
        ]
        if headings:
            latest = max(headings, key=lambda l: l["y"])
            captions = [
                l
                for l in all_lines
                if latest["y"] - 2 <= l["y"] < min(h["bbox"][1] for h in header_lines)
                and l["bbox"][0] >= x0 - 3
            ]
            title = " ".join(l["text"] for g in row_groups(captions) for l in g)
    notes = []
    note_start = next(
        (
            l
            for l in sorted(all_lines, key=lambda l: l["y"])
            if 0 < l["bbox"][1] - y1 < 15 and re.match(r"^(?:Note|註釋)", l["text"])
        ),
        None,
    )
    if note_start:
        notes = [
            l
            for l in all_lines
            if note_start["y"] - 2 <= l["y"] < note_start["y"] + 40
            and l["size"] <= note_start["size"] * 1.1
            and x0 - 3 <= l["bbox"][0] <= x1
        ]
    citation = lines + captions + notes
    citation_bbox = [
        min(x0, *(l["bbox"][0] for l in citation)),
        min(y0, *(l["bbox"][1] for l in citation)),
        max(x1, *(l["bbox"][2] for l in citation)),
        max(y1, *(l["bbox"][3] for l in citation)),
    ]
    return {
        "headers": joined,
        "rows": rows,
        "spans": spans,
        "bold_cells": bold,
        "title": title.strip(),
        "bbox": rect,
        "citation_bbox": citation_bbox,
        "notes": " ".join(l["text"] for g in row_groups(notes) for l in g),
        "header_scopes": scopes,
        "assignments": assignments,
        "numeric_centers": centers,
    }


def as_block(table: dict, page: pymupdf.Page) -> dict:
    rows = copy.deepcopy(table["rows"])
    for y, x in table["bold_cells"]:
        rows[y][x] += " [bold in source]"
    rect = page.rect
    box = table["citation_bbox"]
    return {
        "type": "table",
        "page_idx": page.number,
        "bbox": [
            box[0] / rect.width * 1000,
            box[1] / rect.height * 1000,
            box[2] / rect.width * 1000,
            box[3] / rect.height * 1000,
        ],
        "table_caption": [s for s in [table["title"], table["notes"]] if s],
        "table_body": table_html(table["headers"], rows, table["spans"]),
        "_table_spans": table["spans"],
        "_table_rows": rows,
        "_recovery": "source-geometry",
    }


def row_label_spans(page: pymupdf.Page, table: dict) -> dict:
    """Two stub headers with centered ruled groups become explicit row spans."""
    labels = [a for a in table["assignments"] if a["column"] == 0]
    numeric_boxes = [a["bbox"] for a in table["assignments"] if a["column"] > 0]
    if not labels or not numeric_boxes:
        return table
    first_numeric = min(b[0] for b in numeric_boxes)
    first_body = min(b[1] for b in numeric_boxes)
    lines = text_lines(page)
    stub_headers = [
        l
        for l in lines
        if table["bbox"][1] <= l["y"] < first_body
        and table["bbox"][0] - 1 <= l["bbox"][0]
        and l["bbox"][2] < first_numeric
    ]
    if len(stub_headers) != 2 or abs(stub_headers[0]["y"] - stub_headers[1]["y"]) > 2:
        return table
    stub_headers.sort(key=lambda l: l["x"])
    if stub_headers[0]["bbox"][2] >= stub_headers[1]["bbox"][0]:
        raise ValueError("stub column headers overlap")
    row_centers = [
        statistics.median(
            (a["bbox"][1] + a["bbox"][3]) / 2
            for a in table["assignments"]
            if a["row"] == r and a["column"] > 0
        )
        for r in range(len(table["rows"]))
    ]
    rules = sorted(
        r[1]
        for r in horizontal_rules(page)
        if abs(r[0] - table["bbox"][0]) < 2
        and abs(r[2] - table["bbox"][2]) < 2
        and table["bbox"][1] - 1 <= r[1] <= table["bbox"][3] + 1
    )
    revised = copy.deepcopy(table)
    revised["headers"] = [l["text"] for l in stub_headers] + table["headers"][1:]
    revised["rows"] = [["", ""] + row[1:] for row in table["rows"]]
    revised["bold_cells"] = [[r, c + 1] for r, c in table["bold_cells"]]
    revised["spans"] = [dict(s, column=s["column"] + 1) for s in table["spans"]]
    grouped = False
    for label in labels:
        cx = (label["bbox"][0] + label["bbox"][2]) / 2
        cy = (label["bbox"][1] + label["bbox"][3]) / 2
        column = min(range(2), key=lambda c: abs(stub_headers[c]["x"] - cx))
        row = label["row"]
        if column == 0:
            lower = max((y for y in rules if y < cy), default=None)
            upper = min((y for y in rules if y > cy), default=None)
            if lower is None or upper is None:
                raise ValueError("stub label lacks bounding horizontal rules")
            covered = [r for r, y in enumerate(row_centers) if lower < y < upper]
            if len(covered) > 1:
                peers = [
                    a
                    for a in labels
                    if a is not label
                    and lower < (a["bbox"][1] + a["bbox"][3]) / 2 < upper
                    and abs((a["bbox"][0] + a["bbox"][2]) / 2 - stub_headers[0]["x"])
                    < 8
                ]
                if peers:
                    return table
                if abs(cy - statistics.mean(row_centers[r] for r in covered)) > 2:
                    raise ValueError("ambiguous centered stub-label span")
                row = min(covered)
                grouped = True
                revised["spans"].append(
                    {"row": row, "column": 0, "rowspan": len(covered), "colspan": 1}
                )
        if revised["rows"][row][column]:
            raise ValueError("multiple labels occupy one stub cell")
        revised["rows"][row][column] = label["text"]
    if not grouped:
        return table
    revised["row_label_span_arm"] = (
        "explicit-two-stub-headers-centered-between-full-rules"
    )
    return revised
