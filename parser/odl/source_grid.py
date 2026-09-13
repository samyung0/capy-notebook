"""Source-supported mixed-text grids, with ambiguous geometry left native."""

from __future__ import annotations

import re
import statistics
import unicodedata
from collections import Counter

import pymupdf

from . import geometry


class AmbiguousGrid(ValueError):
    """An observed grid has unresolved meaning and must remain native."""


def normal(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(text))).casefold()


def cell_styles(page: pymupdf.Page, table: dict) -> list[dict]:
    """Retain only literal emphasis whose complete cell scope is source-supported."""
    spans = [
        s
        for b in page.get_text("dict", flags=geometry.TEXT_FLAGS)["blocks"]
        for line in b.get("lines", [])
        for s in line["spans"]
        if re.search(r"\w", s["text"])
    ]
    drawings = page.get_drawings()
    cells: dict[tuple[int, int], set[tuple[str, ...]]] = {}
    for assignment in table["assignments"]:
        rect = pymupdf.Rect(assignment["bbox"])
        matched = [
            s
            for s in spans
            if rect.contains(
                (pymupdf.Rect(s["bbox"]).tl + pymupdf.Rect(s["bbox"]).br) / 2
            )
        ]
        bold = {bool(s["flags"] & 16) for s in matched}
        if len(bold) > 1:
            raise AmbiguousGrid("partial bold emphasis has unresolved cell scope")
        styles = ["bold"] if bold == {True} else []
        point = (rect.tl + rect.br) / 2
        layers = [
            d
            for d in drawings
            if d.get("fill") is not None and d["rect"].contains(point)
        ]
        if layers:
            layer = max(layers, key=lambda d: d["seqno"])
            fill = layer["fill"]
            if any(value < 0.99 for value in fill):
                if (
                    layer.get("fill_opacity") != 1
                    or len(layer["items"]) != 1
                    or layer["items"][0][0] != "re"
                    or len(fill) != 3
                    or max(fill) - min(fill) > 0.03
                    or not 0.7 < statistics.mean(fill) < 0.97
                    or not layer["rect"].contains(rect)
                ):
                    raise AmbiguousGrid("background has unresolved cell scope or color")
                styles.append("gray background")
        cells.setdefault((assignment["row"], assignment["column"]), set()).add(
            tuple(styles)
        )
    result = []
    for (row, column), values in sorted(cells.items()):
        if len(values) != 1:
            raise AmbiguousGrid("wrapped cell has inconsistent source emphasis")
        styles = next(iter(values))
        if styles:
            result.append({"row": row, "column": column, "styles": list(styles)})
    return result


def all_rules(page, region):
    rules = []
    for drawing in page.get_drawings():
        for item in drawing["items"]:
            if item[0] == "re" and item[1].height <= 2:
                rect = item[1]
                r = [rect.x0, (rect.y0 + rect.y1) / 2, rect.x1]
                if (
                    region[0] - 2 <= r[0]
                    and r[2] <= region[2] + 2
                    and region[1] - 2 <= r[1] <= region[3] + 2
                ):
                    rules.append(r)
            if item[0] == "l":
                a, b = item[1:3]
                if abs(a.y - b.y) < 1 and abs(a.x - b.x) > 5:
                    r = [min(a.x, b.x), (a.y + b.y) / 2, max(a.x, b.x)]
                    if (
                        region[0] - 2 <= r[0]
                        and r[2] <= region[2] + 2
                        and region[1] - 2 <= r[1] <= region[3] + 2
                    ):
                        rules.append(r)
    return rules


def numeric_cell(text):
    return bool(re.fullmatch(r"[+−-]?(?:\d[\d,. ]*)(?:[A-Za-z%]+)?|[-−]", text.strip()))


def recover(page: pymupdf.Page, region, lines: list[dict]) -> dict:
    """Infer leaf columns from repeated complete mixed-text rows, then attach
    source header tiers and explicit ruled italic row groups without numeric-only stubs."""
    area = pymupdf.Rect(region)
    inside = [
        l
        for l in lines
        if region[0] - 1 <= l["x"] <= region[2] + 1
        and region[1] <= l["y"] <= region[3] + 1
    ]
    dots = [l for l in inside if re.fullmatch(r"[.·…\s]{5,}", l["text"])]
    inside = [l for l in inside if l not in dots]
    groups = geometry.row_groups(inside)
    supported = [
        g
        for g in groups
        if len(g) >= 3
        and not numeric_cell(g[0]["text"])
        and sum(numeric_cell(l["text"]) for l in g) >= 2
    ]
    if len(supported) < 2:
        raise ValueError("fewer than two mixed data rows")
    width = Counter(len(g) for g in supported).most_common(1)[0][0]
    dense = [g for g in supported if len(g) == width]
    if len(dense) < 2:
        raise ValueError("no repeated complete row template")
    centers = [statistics.median(g[i]["x"] for g in dense) for i in range(width)]
    cuts = [area.x0]
    for i in range(width - 1):
        right = max(g[i]["bbox"][2] for g in dense)
        left = min(g[i + 1]["bbox"][0] for g in dense)
        if right >= left:
            raise ValueError("source columns overlap")
        cuts.append((right + left) / 2)
    cuts.append(area.x1)
    rules = all_rules(page, region)
    full = [r for r in rules if r[2] - r[0] > area.width * 0.9]
    first_dense = min(statistics.median(l["y"] for l in g) for g in dense)
    header_end = max((r[1] for r in full if r[1] < first_dense - 2), default=region[1])
    anchors = [
        g
        for g in supported
        if g[0]["y"] > header_end
        and cuts[0] <= g[0]["x"] <= cuts[1]
        and len(g) <= width
        and all(
            sum(cuts[i] <= l["x"] <= cuts[i + 1] for l in g) <= 1 for i in range(width)
        )
    ]
    if len(anchors) < 2:
        raise ValueError("no stable mixed rows")
    ys = [statistics.median(l["y"] for l in g) for g in anchors]
    header = [l for l in inside if l["y"] < header_end]
    if not header:
        raise ValueError("no source header above ruled body")
    header_groups = geometry.row_groups(header)
    top = header_groups[0]
    # A complete top tier owns every leaf column. Partial top tiers require
    # explicit short underline rules, otherwise only a single leaf is assigned.
    full_top = (
        len(top) > 1
        and abs(top[0]["x"] - centers[0]) < max(10, (cuts[1] - cuts[0]) * 0.5)
        and abs(top[-1]["x"] - centers[-1]) < max(10, (cuts[-1] - cuts[-2]))
    )
    parts = [[] for _ in centers]
    header_scopes = []
    for line in sorted(header, key=lambda l: (l["y"], l["x"])):
        under = [
            r
            for r in rules
            if 0 < r[1] - line["y"] < line["size"] * 1.8
            and r[0] - 2 <= line["x"] <= r[2] + 2
            and r[2] - r[0] < area.width * 0.9
        ]
        if under:
            rule = min(under, key=lambda r: r[1] - line["y"])
            selected = [
                i for i, x in enumerate(centers) if rule[0] - 2 <= x <= rule[2] + 2
            ]
        elif full_top and line in top:
            selected = [
                i
                for i, x in enumerate(centers)
                if min(range(len(top)), key=lambda j: abs(top[j]["x"] - x))
                == top.index(line)
            ]
        else:
            overlapping = [
                i
                for i, x in enumerate(centers)
                if line["bbox"][0] <= x <= line["bbox"][2]
            ]
            parent = [
                (h, s)
                for h, s in header_scopes
                if len(s) > 1 and h["y"] < line["y"] - 2 and abs(h["x"] - line["x"]) < 2
            ]
            if parent:
                selected = max(parent, key=lambda item: item[0]["y"])[1]
            else:
                if len(overlapping) > 1:
                    raise AmbiguousGrid("joined header crosses unresolved leaf columns")
                selected = [
                    min(range(width), key=lambda i: abs(centers[i] - line["x"]))
                ]
        header_scopes.append((line, selected))
        for i in selected:
            parts[i].append(line["text"])
    headers = [" / ".join(dict.fromkeys(v)) for v in parts]
    if any(not h for h in headers):
        raise ValueError("unlabelled leaf column")
    if len({normal(h) for h in headers}) != len(headers):
        raise AmbiguousGrid("duplicate header paths need parent scope")
    # Explicit italic group labels must follow a full-width separator.
    raw = page.get_text("dict", flags=geometry.TEXT_FLAGS)
    spans = [s for b in raw["blocks"] for l in b.get("lines", []) for s in l["spans"]]
    source_lines = {}
    for block_index, block in enumerate(raw["blocks"]):
        for line_index, line in enumerate(block.get("lines", [])):
            ink = [s for s in line["spans"] if s["text"].strip()]
            if not ink:
                continue
            box = (
                min(s["bbox"][0] for s in ink),
                min(s["bbox"][1] for s in ink),
                max(s["bbox"][2] for s in ink),
                max(s["bbox"][3] for s in ink),
            )
            source_lines.setdefault(box, []).append(
                (
                    block_index,
                    line_index,
                    {(s["font"], s["size"], s["flags"], s["color"]) for s in ink},
                )
            )

    def continuation(line, previous):
        first = source_lines.get(tuple(previous["bbox"]), [])
        second = source_lines.get(tuple(line["bbox"]), [])
        if len(first) != 1 or len(second) != 1:
            return False
        a, b = first[0], second[0]
        if a[0] != b[0] or abs(a[1] - b[1]) != 1 or a[2] != b[2]:
            return False
        upper, lower = sorted((previous, line), key=lambda item: item["y"])
        # Consecutive source lines must touch within the same two-point
        # coordinate tolerance used for baseline grouping, align in the cell,
        # and cross no horizontal rule. Proximity alone proves no association.
        return (
            lower["y"] - upper["y"] > 2
            and lower["bbox"][1] - upper["bbox"][3] <= 2
            and min(
                abs(line["bbox"][0] - previous["bbox"][0]),
                abs(line["bbox"][2] - previous["bbox"][2]),
                abs(line["x"] - previous["x"]),
            )
            <= 2
            and not any(
                upper["y"] < rule[1] < lower["y"] and rule[0] <= line["x"] <= rule[2]
                for rule in rules
            )
        )

    def italic(line):
        matched = [
            s
            for s in spans
            if abs(s["origin"][1] - line["y"]) < 2
            and (pymupdf.Rect(s["bbox"]) & pymupdf.Rect(line["bbox"])).get_area() > 0
            and s["text"].strip()
        ]
        # A ruled group label may start italic and include a roman term.
        # Preserve that complete source phrase rather than splitting its scope.
        return bool(matched) and bool(
            min(matched, key=lambda s: s["bbox"][0])["flags"] & 2
        )

    group_lines = []
    for g in groups:
        if g[0]["y"] <= header_end or g in anchors or len(g) != 1:
            continue
        l = g[0]
        if (
            l["bbox"][0] < cuts[min(2, width - 1)]
            and italic(l)
            and any(0 < l["y"] - r[1] < l["size"] * 3 for r in full)
        ):
            group_lines.append(l)
    cells = [[[] for _ in centers] for _ in anchors]

    def column(line):
        c = min(range(width), key=lambda i: abs(line["x"] - centers[i]))
        # Long source labels may vary within a stub, but no cell may cross the
        # inferred whitespace gutter into its neighbour.
        if line["bbox"][0] < cuts[c] - 2 or line["bbox"][2] > cuts[c + 1] + 2:
            raise ValueError("cell crosses source gutter: " + line["text"])
        return c

    for r, anchor in enumerate(anchors):
        for line in anchor:
            cells[r][column(line)].append(line)
    loose = [
        line
        for line in inside
        if line["y"] >= header_end
        and line not in group_lines
        and not any(line in anchor for anchor in anchors)
    ]
    # Start at the proved baselines so longer continuations can extend outward.
    for line in sorted(loose, key=lambda line: min(abs(line["y"] - y) for y in ys)):
        c = column(line)
        owners = [
            r
            for r, row in enumerate(cells)
            if any(continuation(line, previous) for previous in row[c])
        ]
        if len(owners) != 1:
            raise AmbiguousGrid("loose body line has no unique source row continuation")
        cells[owners[0]][c].append(line)
    rows = [
        [
            " ".join(line["text"] for line in sorted(cell, key=lambda l: l["y"]))
            for cell in row
        ]
        for row in cells
    ]
    assignments = [
        {
            "row": r,
            "column": c,
            "colspan": 1,
            "text": line["text"],
            "bbox": line["bbox"],
            "bold": line["bold"],
        }
        for r, row in enumerate(cells)
        for c, cell in enumerate(row)
        for line in sorted(cell, key=lambda l: l["y"])
    ]
    if any(any(not cell for cell in row) for row in rows):
        raise ValueError("incomplete mixed row")
    scopes = []
    for y in ys:
        preceding = [l for l in group_lines if l["y"] < y]
        scopes.append(max(preceding, key=lambda l: l["y"])["text"] if preceding else "")
    if group_lines:
        if any(not s for s in scopes):
            raise ValueError("unscoped source group")
        headers = ["Source group", *headers]
        rows = [[s, *r] for s, r in zip(scopes, rows)]
    offset = int(bool(group_lines))
    for assignment in assignments:
        assignment["column"] += offset
    if group_lines:
        assignments += [
            {
                "row": row,
                "column": 0,
                "colspan": 1,
                "text": scope,
                "bbox": next(l["bbox"] for l in group_lines if l["text"] == scope),
                "bold": False,
            }
            for row, scope in enumerate(scopes)
        ]
    return {
        "headers": headers,
        "rows": rows,
        "bbox": region,
        "citation_bbox": region,
        "assignments": assignments,
        "header_scopes": [
            {
                "text": line["text"],
                "bbox": line["bbox"],
                "columns": [i + offset for i in selected],
            }
            for line, selected in header_scopes
        ],
        "source_groups": scopes,
        "spans": [],
        "bold_cells": [],
        "title": "",
        "notes": "",
        "context_lines": [],
        "decorative_lines": dots,
        "source_grid": "mixed",
    }
