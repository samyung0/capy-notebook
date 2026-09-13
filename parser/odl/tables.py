"""Source-geometry table recovery and its guarded replacement of native blocks."""

from __future__ import annotations

import copy
import itertools
import re
import statistics
import unicodedata
from collections import Counter
from collections.abc import Callable

import pymupdf

from . import context, geometry, source_grid
from .adapter import odl_content_list
from .source_text import RAW_FLAGS
from .table_html import table_html

VALUE = geometry.NUMBER


class _Lazy:
    """Compute a page's text lines once, only if a region needs them."""

    def __init__(self, load: Callable[[], list[dict]]) -> None:
        self._load = load
        self._value: list[dict] | None = None

    def __call__(self) -> list[dict]:
        if self._value is None:
            self._value = self._load()
        return self._value


def _numeric(line: dict) -> bool:
    return bool(VALUE.fullmatch(re.sub(r"\s+", "", line["text"])))


def _in_body(line: dict, region) -> bool:
    return (
        region[0] - 1 <= line["x"] <= region[2] + 1
        and region[1] <= line["y"] <= region[3] + 1
    )


def select_regions(
    rules: list[list[float]], lines: Callable[[], list[dict]]
) -> list[list[float]]:
    """Split matching rules at source headings; retain large ruled row bands.

    ``lines`` is read lazily: most pages have rules but no candidate band, and
    the text-line pass is the expensive part on image-heavy pages.
    """
    buckets: list[list[list[float]]] = []
    for rule in rules:
        bucket = next(
            (
                b
                for b in buckets
                if abs(b[0][0] - rule[0]) < 2 and abs(b[0][2] - rule[2]) < 2
            ),
            None,
        )
        if bucket is None:
            bucket = []
            buckets.append(bucket)
        bucket.append(rule)
    result = []
    for bucket in buckets:
        groups: list[list[list[float]]] = []
        for rule in sorted(bucket, key=lambda r: r[1]):
            previous = groups[-1][-1][1] if groups else None
            boundary = previous is not None and any(
                previous < line["y"] < rule[1]
                and (
                    geometry.CAPTION.match(line["text"])
                    or line["bbox"][0] < rule[0] + 0.15 * (rule[2] - rule[0])
                    and re.match(r"^\d+\.\d+(?:\s|$)", line["text"])
                )
                for line in lines()
            )
            # A large prose gap still rejects unrelated horizontal decorations.
            if previous is not None and rule[1] - previous > 160:
                between = [l for l in lines() if previous < l["y"] < rule[1]]
                boundary |= sum(len(l["text"]) > 100 for l in between) > 2
            if not groups or boundary:
                groups.append([])
            groups[-1].append(rule)
        for group in groups:
            if len(group) >= 2 and group[-1][1] - group[0][1] >= 12:
                result.append([group[0][0], group[0][1], group[0][2], group[-1][1]])
    return sorted(result, key=lambda b: b[1])


def source_context(page: pymupdf.Page, region, lines: list[dict], table: dict) -> dict:
    """Attach complete adjacent context, stopping at headings and source gaps."""
    x0, y0, x1, y1 = region
    body = [l for l in lines if _in_body(l, region)]
    near = [
        l
        for l in lines
        if x0 - (x1 - x0) * 0.16 <= l["bbox"][0] <= x1
        and y0 - 130 <= l["y"] <= y1 + 180
    ]
    upper = [l for l in near if l["y"] < y0]
    numbered = [
        l
        for l in upper
        if l["bbox"][0] < x0 + 0.15 * (x1 - x0)
        and re.match(r"^\d+\.\d+(?:\s|$)", l["text"])
    ]
    captions = [
        l
        for l in near
        if geometry.CAPTION.match(l["text"]) and (l["y"] < y0 or l["bbox"][1] > y1)
    ]
    context: list[dict] = []
    close_captions = [
        l for l in captions if min(abs(l["bbox"][3] - y0), abs(l["bbox"][1] - y1)) < 65
    ]
    if numbered and not close_captions:
        start = max(l["y"] for l in numbered)
        context = [
            l
            for l in upper
            if start - 2 <= l["y"] < y0 and (not _numeric(l) or l in numbered)
        ]
    elif close_captions:
        nearest = min(
            close_captions,
            key=lambda l: min(abs(l["bbox"][3] - y0), abs(l["bbox"][1] - y1)),
        )
        distance = min(abs(nearest["bbox"][3] - y0), abs(nearest["bbox"][1] - y1))
        if distance < 65:
            context = [nearest]
            if nearest["y"] < y0:
                context += [
                    l
                    for l in upper
                    if nearest["y"] + 2 < l["y"] < y0 and not _numeric(l)
                ]
    # Header text above a top rule belongs to the table, not a caption.
    header_above = [
        l
        for l in upper
        if y0 - l["y"] < 16
        and not _numeric(l)
        and l not in context
        and l["bbox"][2] - l["bbox"][0] < (x1 - x0) * 0.32
    ]
    numeric_start = min(
        (a["bbox"][0] for a in table["assignments"] if a["column"] > 0), default=x1
    )
    stub = [l for l in header_above if l["bbox"][2] < numeric_start]
    if not table["headers"][0] and stub:
        table["headers"][0] = " / ".join(
            l["text"] for l in sorted(stub, key=lambda l: l["x"])
        )
    context = [l for l in context if l not in header_above]
    # Keep units above the years even when the title is not close enough.
    unit_lines = [
        l
        for l in upper
        if y0 - 50 < l["y"] < y0 - 14
        and l["bbox"][0] > x0 + (x1 - x0) * 0.55
        and not _numeric(l)
    ]
    for line in unit_lines:
        if line not in context:
            context.append(line)
    notes: list[dict] = []
    note_start = next(
        (
            l
            for l in sorted(near, key=lambda l: l["y"])
            if 0 < l["bbox"][1] - y1 < 18 and re.match(r"^(?:Notes?\b|註釋)", l["text"])
        ),
        None,
    )
    if note_start:
        groups = geometry.row_groups([l for l in near if l["y"] >= note_start["y"] - 2])
        last = note_start["y"]
        for group in groups:
            y = statistics.median(l["y"] for l in group)
            if y - last > 22 or any(
                re.match(r"^\d+\.\d+(?:\s|$)", l["text"]) for l in group
            ):
                break
            if any(l["size"] > note_start["size"] * 1.15 for l in group):
                break
            if y > page.rect.height * 0.965:
                break
            notes.extend(group)
            last = y
    table["title"] = " ".join(
        l["text"] for g in geometry.row_groups(context) for l in g
    )
    table["notes"] = " ".join(l["text"] for g in geometry.row_groups(notes) for l in g)
    cited = body + context + header_above + notes
    table["citation_bbox"] = [
        min(x0, *(l["bbox"][0] for l in cited)),
        min(y0, *(l["bbox"][1] for l in cited)),
        max(x1, *(l["bbox"][2] for l in cited)),
        max(y1, *(l["bbox"][3] for l in cited)),
    ]
    table["context_lines"] = [
        {k: l[k] for k in ("text", "bbox")} for l in context + notes + stub
    ]
    return table


def row_scope(page: pymupdf.Page, table: dict) -> dict:
    if table.get("row_label_span_arm"):
        return table
    labels = [a for a in table["assignments"] if a["column"] == 0]
    centers = [
        statistics.median(
            (a["bbox"][1] + a["bbox"][3]) / 2
            for a in table["assignments"]
            if a["row"] == r and a["column"] > 0
        )
        for r in range(len(table["rows"]))
    ]
    rules = sorted(
        r[1]
        for r in geometry.horizontal_rules(page)
        if abs(r[0] - table["bbox"][0]) < 2
        and abs(r[2] - table["bbox"][2]) < 2
        and table["bbox"][1] - 1 <= r[1] <= table["bbox"][3] + 1
    )
    scopes = []
    removed: list[dict] = []
    for lo, hi in itertools.pairwise(rules):
        rows = [i for i, y in enumerate(centers) if lo < y < hi]
        if len(rows) < 2:
            continue
        group = [a for a in labels if lo < (a["bbox"][1] + a["bbox"][3]) / 2 < hi]
        if len(group) <= len(rows):
            continue
        for cut in sorted({a["bbox"][2] for a in group}):
            left = [a for a in group if a["bbox"][2] <= cut]
            right = [a for a in group if a["bbox"][0] > cut + 3]
            if (
                len(left) + len(right) != len(group)
                or not 1 <= len(left) <= 2
                or {a["row"] for a in right} != set(rows)
            ):
                continue
            cy = statistics.mean((a["bbox"][1] + a["bbox"][3]) / 2 for a in left)
            row_gap = statistics.median(b - a for a, b in itertools.pairwise(centers))
            if len(left) > 1 and any(
                min(abs((a["bbox"][1] + a["bbox"][3]) / 2 - y) for y in centers)
                < row_gap * 0.3
                for a in left
            ):
                continue
            if abs(cy - statistics.mean(centers[r] for r in rows)) > row_gap * 0.3:
                continue
            text = " ".join(a["text"] for a in sorted(left, key=lambda a: a["bbox"][1]))
            scopes.append(
                {
                    "text": text,
                    "rows": rows,
                    "method": "centered source stub inside horizontal separators",
                }
            )
            removed.extend(left)
            break
    # A label-only line followed by indented labels is a row group heading.
    unaligned = [
        a
        for a in labels
        if min(abs((a["bbox"][1] + a["bbox"][3]) / 2 - y) for y in centers) > 3
        and a not in removed
    ]
    groups: list[list[dict]] = []
    for a in sorted(unaligned, key=lambda a: a["bbox"][1]):
        cy = (a["bbox"][1] + a["bbox"][3]) / 2
        if (
            not groups
            or abs(
                cy
                - statistics.mean((g["bbox"][1] + g["bbox"][3]) / 2 for g in groups[-1])
            )
            > 3
        ):
            groups.append([])
        groups[-1].append(a)
    for parents in groups:
        cy = statistics.mean((a["bbox"][1] + a["bbox"][3]) / 2 for a in parents)
        covered = []
        for r, y in enumerate(centers):
            if y <= cy:
                continue
            children = [
                a
                for a in labels
                if a["row"] == r and a not in parents and a not in removed
            ]
            if all(
                any(8 < child["bbox"][0] - parent["bbox"][0] < 45 for child in children)
                for parent in parents
            ):
                covered.append(r)
            else:
                break
        if len(covered) >= 2:
            scopes.append(
                {
                    "text": " ".join(
                        a["text"] for a in sorted(parents, key=lambda a: a["bbox"][0])
                    ),
                    "rows": covered,
                    "method": "source heading followed by indented row labels",
                }
            )
            removed.extend(parents)
    if scopes:
        for r, row in enumerate(table["rows"]):
            own = [a["text"] for a in labels if a["row"] == r and a not in removed]
            parents = [s["text"] for s in scopes if r in s["rows"]]
            row[0] = " / ".join(parents + [" ".join(own)])
        table["source_row_scopes"] = scopes
    return table


def backgrounds(page: pymupdf.Page, table: dict) -> dict:
    drawings = page.get_drawings()
    evidence = []
    for cell in table["assignments"]:
        if cell["column"] == 0 or not VALUE.fullmatch(re.sub(r"\s+", "", cell["text"])):
            continue
        rect = pymupdf.Rect(cell["bbox"])
        point = (rect.tl + rect.br) / 2
        layers = [
            d
            for d in drawings
            if d.get("fill")
            and d.get("fill_opacity") == 1
            and d["rect"].contains(point)
        ]
        if not layers:
            continue
        layer = max(layers, key=lambda d: d["seqno"])
        fill = layer["fill"]
        if (
            len(layer["items"]) != 1
            or layer["items"][0][0] != "re"
            or len(fill) != 3
            or max(fill) - min(fill) > 0.03
            or not 0.7 < statistics.mean(fill) < 0.97
        ):
            continue
        box = layer["rect"]
        if (
            (box & rect).get_area() < rect.get_area() * 0.75
            or box.width > page.rect.width * 0.2
            or box.height > rect.height * 2
        ):
            continue
        column = cell["column"] + int(bool(table.get("row_label_span_arm")))
        evidence.append({"row": cell["row"], "column": column})
    table["background_cells"] = evidence
    return table


def simple_table(region, lines: list[dict]) -> dict:
    """A complete numeric rectangle with explicit headers can have one row/column."""
    x0, y0, x1, y1 = region
    selected = [
        l
        for l in lines
        if x0 - 2 <= l["x"] <= x1 + 2
        and y0 - 16 <= l["y"] <= y1 + 1
        and (l["y"] >= y0 or l["bbox"][2] - l["bbox"][0] < (x1 - x0) * 0.32)
    ]
    groups = geometry.row_groups(selected)
    first = next(
        (
            i
            for i, g in enumerate(groups)
            if any(_numeric(l) and l["y"] >= y0 for l in g)
            and any(
                not _numeric(l)
                and l["bbox"][2] < min(n["bbox"][0] for n in g if _numeric(n))
                for l in g
            )
        ),
        None,
    )
    if first is None:
        raise ValueError("no simple labelled row")
    body = [g for g in groups[first:] if any(_numeric(l) for l in g)]
    numbers = [[l for l in g if _numeric(l)] for g in body]
    columns = len(numbers[0])
    if not columns or any(len(g) != columns for g in numbers):
        raise ValueError("not a complete numeric rectangle")
    centers = [statistics.mean(g[c]["x"] for g in numbers) for c in range(columns)]
    if any(abs(g[c]["x"] - centers[c]) > 8 for g in numbers for c in range(columns)):
        raise ValueError("simple numeric columns not aligned")
    first_x = min(l["bbox"][0] for g in numbers for l in g)
    heads = [l for g in groups[:first] for l in g]
    headers: list[list[str]] = [[] for _ in range(columns + 1)]
    scopes = []
    for l in heads:
        c = (
            0
            if l["bbox"][2] < first_x
            else min(range(columns), key=lambda c: abs(centers[c] - l["x"])) + 1
        )
        headers[c].append(l["text"])
        scopes.append({"text": l["text"], "columns": [c], "bbox": l["bbox"]})
    if any(not h for h in headers[1:]):
        raise ValueError("simple column lacks header")
    if len(headers[0]) > 1 or any(len(h) > 2 for h in headers[1:]):
        raise ValueError("simple header is not a leaf header")
    rows = [[""] * (columns + 1) for _ in body]
    assignments = []
    bold = []
    ys = [statistics.median(l["y"] for l in g) for g in numbers]
    for l in [l for g in groups[first:] for l in g]:
        row = min(range(len(rows)), key=lambda i: abs(ys[i] - l["y"]))
        col = (
            0
            if l["bbox"][2] < first_x
            else min(range(columns), key=lambda i: abs(centers[i] - l["x"])) + 1
        )
        if col and not _numeric(l):
            raise ValueError("text cell in simple numeric rectangle")
        if col and rows[row][col]:
            raise ValueError("two values in one simple cell")
        rows[row][col] = (rows[row][col] + " " + l["text"]).strip()
        assignments.append(
            {
                "row": row,
                "column": col,
                "colspan": 1,
                "text": l["text"],
                "bbox": l["bbox"],
            }
        )
        if col and l["bold"]:
            bold.append([row, col])
    return {
        "headers": [" / ".join(h) for h in headers],
        "rows": rows,
        "spans": [],
        "bold_cells": bold,
        "title": "",
        "notes": "",
        "bbox": region,
        "citation_bbox": region,
        "header_scopes": scopes,
        "assignments": assignments,
        "numeric_centers": centers,
    }


def parenthetical_continuations(page: pymupdf.Page, table: dict) -> dict:
    """Keep a signed parenthetical line with its preceding source measure."""
    if len(table["headers"]) - len(table["numeric_centers"]) != 1:
        return table
    continued = []
    for r, row in enumerate(table["rows"]):
        values = [v for v in row[1:] if v]
        if r == 0 or row[0] or not table["rows"][r - 1][0] or not values:
            continue
        if not all(re.fullmatch(r"\([+−-]\d+(?:\.\d+)?\)\s*[*#@]?", v) for v in values):
            continue
        ys = [
            statistics.median(
                (a["bbox"][1] + a["bbox"][3]) / 2
                for a in table["assignments"]
                if a["row"] == i and a["column"] > 0
            )
            for i in [r - 1, r]
        ]
        if any(
            ys[0] < rule[1] < ys[1]
            and rule[0] <= table["bbox"][0] + 2
            and rule[2] >= table["bbox"][2] - 2
            for rule in geometry.horizontal_rules(page)
        ):
            continue
        table["spans"].append({"row": r - 1, "column": 0, "rowspan": 2, "colspan": 1})
        continued.append(r)
    table["parenthetical_continuation_rows"] = continued
    return table


def conservative_shape(
    page: pymupdf.Page, region, lines: list[dict], table: dict
) -> None:
    """Abstain from layouts that exceed the audited alignment model."""
    stub_columns = len(table["headers"]) - len(table["numeric_centers"])
    expanded = copy.deepcopy(table["rows"])
    for span in table["spans"]:
        for r in range(span["row"], span["row"] + span.get("rowspan", 1)):
            if span["column"] < stub_columns:
                expanded[r][span["column"]] = expanded[span["row"]][span["column"]]
    labels = [
        tuple(row[:stub_columns])
        for r, row in enumerate(expanded)
        if r not in table.get("parenthetical_continuation_rows", [])
    ]
    if any(not all(label) for label in labels) or len(set(labels)) != len(labels):
        raise ValueError("blank or repeated row label has unresolved source scope")
    if any(len(h.split(" / ")) > 4 for h in table["headers"]):
        raise ValueError("more than four source header levels")
    assignments = table["assignments"]
    if any(
        s["method"] == "source heading followed by indented row labels"
        for s in table.get("source_row_scopes", [])
    ):
        raise ValueError("indented row scope cannot distinguish wrapped labels")
    centers = table["numeric_centers"]
    gap = max((b - a for a, b in itertools.pairwise(centers)), default=40)
    body_ys = [
        (a["bbox"][1] + a["bbox"][3]) / 2 for a in assignments if a["column"] > 0
    ]
    if any(
        _numeric(l)
        and (
            region[0] - gap * 1.75 < l["x"] < region[0]
            or region[2] < l["x"] < region[2] + gap * 1.75
        )
        and min(abs((l["bbox"][1] + l["bbox"][3]) / 2 - y) for y in body_ys) < 3
        for l in lines
    ):
        raise ValueError("aligned numeric source text continues outside selected width")
    first_y = min(
        (a["bbox"][1] + a["bbox"][3]) / 2 for a in assignments if a["column"] > 0
    )
    first_x = min(a["bbox"][0] for a in assignments if a["column"] > 0)
    heads = [
        l
        for l in lines
        if _in_body(l, region) and l["y"] < first_y - 2 and l["bbox"][2] < first_x
    ]
    rules = geometry.horizontal_rules(page)
    if heads and not any(max(l["y"] for l in heads) < r[1] < first_y for r in rules):
        raise ValueError("row-group text occupies an unruled header band")
    if not table.get("row_label_span_arm"):
        scopes = " ".join(s["text"] for s in table.get("source_row_scopes", []))
        for a in assignments:
            if a["column"] or a["text"] in scopes:
                continue
            peers = [n for n in assignments if n["row"] == a["row"] and n["column"] > 0]
            cy = (a["bbox"][1] + a["bbox"][3]) / 2
            y = statistics.median((n["bbox"][1] + n["bbox"][3]) / 2 for n in peers)
            if abs(cy - y) > (a["bbox"][3] - a["bbox"][1]) * 0.4:
                raise ValueError("unresolved multiline row label")
    for scope in table["header_scopes"]:
        if len(scope["columns"]) >= 3 and len(scope["text"].split()) >= 3:
            raise ValueError("joined multiword header spans several data columns")
        text = re.sub(r"\s+", "", scope["text"])
        if VALUE.fullmatch(text) and not re.fullmatch(
            r"(?:19|20)\d{2}(?:[#@*]|\(\d+\))?", text
        ):
            raise ValueError("numeric body value was assigned to a header")


def recover(page: pymupdf.Page, region, lines: list[dict]) -> dict:
    """One source table from a ruled region, or ValueError to keep the native one."""
    captions = [
        l
        for l in lines
        if geometry.CAPTION.match(l["text"])
        and (0 <= region[1] - l["bbox"][3] <= 45 or 0 <= l["bbox"][1] - region[3] <= 35)
    ]
    nearest = (
        min(
            captions,
            key=lambda l: min(
                abs(region[1] - l["bbox"][3]), abs(l["bbox"][1] - region[3])
            ),
        )
        if captions
        else None
    )
    prepared = [l for l in lines if l not in captions or l is nearest]
    try:
        table = geometry.table_from_region(page, region, prepared)
    except ValueError as original:
        try:
            table = simple_table(region, prepared)
        except ValueError:
            raise original from None
    table = geometry.row_label_spans(page, table)
    if any(
        a["column"] > 0 and not VALUE.fullmatch(re.sub(r"\s+", "", a["text"]))
        for a in table["assignments"]
    ):
        raise ValueError("unassigned text inside numeric columns")
    table = row_scope(page, table)
    table = parenthetical_continuations(page, table)
    conservative_shape(page, region, lines, table)
    table = source_context(page, region, lines, table)
    table = backgrounds(page, table)
    styled = copy.deepcopy(table)
    for cell in table["background_cells"]:
        styled["rows"][cell["row"]][cell["column"]] += " [gray background in source]"
    # Full long notes remain source-cited footnotes without filling every row's prefix.
    styled["notes"] = ""
    block = geometry.as_block(styled, page)
    if table["notes"]:
        block["table_footnote"] = [table["title"] + "\n" + table["notes"]]
    return {"table": table, "block": block}


def mixed_context(page: pymupdf.Page, region, lines: list[dict], table: dict) -> dict:
    """Copy explicit complete source captions and notes without consuming prose."""
    area = pymupdf.Rect(region)
    paragraphs = []
    unit_spans = []
    unit_label = re.compile(r"^(?:units?|单位|單位)\s*[:：]", re.IGNORECASE)
    for source in page.get_text("dict", flags=geometry.TEXT_FLAGS)["blocks"]:
        source_lines = source.get("lines", [])
        if not source_lines or any(
            abs(line["dir"][0] - 1) > 0.01 for line in source_lines
        ):
            continue
        for line in source_lines:
            for index, span in enumerate(line["spans"]):
                if not unit_label.match(span["text"].strip()):
                    continue
                suffix = line["spans"][index:]
                box = pymupdf.Rect(suffix[0]["bbox"])
                for following in suffix[1:]:
                    box |= pymupdf.Rect(following["bbox"])
                unit_spans.append(
                    {
                        "text": "".join(s["text"] for s in suffix).strip(),
                        "bbox": list(box),
                        "x": (box.x0 + box.x1) / 2,
                        "y": span["origin"][1],
                    }
                )
        text = " ".join(
            "".join(s["text"] for s in line["spans"]).strip() for line in source_lines
        )
        box = pymupdf.Rect(source["bbox"])
        if not area.x0 <= (box.x0 + box.x1) / 2 <= area.x1:
            continue
        if (box & area).get_area() > 0:
            continue
        paragraphs.append({"text": text, "bbox": list(box)})
    captions = []
    for paragraph in paragraphs:
        match = context.CAPTION.match(paragraph["text"])
        if not match or paragraph["text"][match.end() : match.end() + 1] not in {
            " ",
            ":",
            "：",
            ".",
            "．",
        }:
            continue
        box = pymupdf.Rect(paragraph["bbox"])
        gap = min(abs(box.y1 - area.y0), abs(box.y0 - area.y1))
        if gap < 65:
            captions.append((gap, paragraph, re.findall(r"[0-9０-９]+", match[0])[-1]))
    attached = []
    if captions:
        _, nearest, number = min(captions, key=lambda value: value[0])
        above = nearest["bbox"][3] <= area.y0
        attached = [
            p
            for _, p, n in captions
            if n == number and (p["bbox"][3] <= area.y0) == above
        ]
    attached.sort(key=lambda p: (p["bbox"][1], p["bbox"][0]))
    notes = [
        p
        for p in paragraphs
        if 0 <= p["bbox"][1] - area.y1 < 18
        and re.match(r"^(?:Notes?\b|註釋|[注註]\s*[:：])", p["text"], re.IGNORECASE)
    ]
    units = [
        l
        for l in [*lines, *unit_spans]
        if l not in attached
        and area.y0 - 50 < l["y"] < area.y0
        and area.x0 <= l["x"] <= area.x1
        and (context.UNIT.fullmatch(l["text"]) or unit_label.match(l["text"]))
    ]
    for unit in units:
        if not any(
            pymupdf.Rect(p["bbox"]).contains(pymupdf.Rect(unit["bbox"]))
            for p in attached
        ):
            attached.append({"text": unit["text"], "bbox": unit["bbox"]})
    table["captions"] = [p["text"] for p in attached]
    table["title"] = " ".join(table["captions"])
    table["notes"] = " ".join(p["text"] for p in notes)
    table["context_lines"] = attached + notes
    cited = [area, *(pymupdf.Rect(p["bbox"]) for p in attached + notes)]
    table["citation_bbox"] = [
        min(p.x0 for p in cited),
        min(p.y0 for p in cited),
        max(p.x1 for p in cited),
        max(p.y1 for p in cited),
    ]
    return table


def recover_mixed(page: pymupdf.Page, region, lines: list[dict]) -> dict:
    table = mixed_context(page, region, lines, source_grid.recover(page, region, lines))
    styles = source_grid.cell_styles(page, table)
    box = table["citation_bbox"]
    block = {
        "type": "table",
        "page_idx": page.number,
        "bbox": [
            box[0] / page.rect.width * 1000,
            box[1] / page.rect.height * 1000,
            box[2] / page.rect.width * 1000,
            box[3] / page.rect.height * 1000,
        ],
        "table_body": table_html(table["headers"], table["rows"]),
        "table_caption": table["captions"],
        "table_footnote": [table["notes"]] if table["notes"] else [],
        "_table_source_styles": styles,
        "_native_table_supported": True,
        "_native_table_title": table["title"],
        "_recovery": "source-geometry-mixed",
    }
    return {"table": table, "block": block}


def watermark_blocks(document: pymupdf.Document, blocks: list[dict]) -> list[dict]:
    signatures: dict[str, set[int]] = {}
    evidence = []
    for page in document:
        traces = page.get_texttrace()
        sizes = [
            s["size"]
            for s in traces
            if abs(s["dir"][1]) < 0.01 and s.get("opacity", 1) > 0.5
        ]
        if not sizes:
            continue
        ordinary = statistics.median(sizes)
        eligible = [
            s
            for s in traces
            if abs(s["dir"][1]) > 0.25
            and s.get("opacity", 1) <= 0.2
            and s["size"] > ordinary * 3
        ]
        for s in eligible:
            value = "".join(chr(c[0]) for c in s["chars"]).strip()
            signatures.setdefault(value, set()).add(page.number)
        if not eligible:
            continue
        for b in page.get_text("dict", flags=geometry.TEXT_FLAGS)["blocks"]:
            for line in b.get("lines", []):
                if abs(line["dir"][1]) <= 0.25:
                    continue
                for s in line["spans"]:
                    text = s["text"].strip()
                    if any(
                        "".join(chr(c[0]) for c in t["chars"]).strip() == text
                        for t in eligible
                    ):
                        evidence.append(
                            {
                                "page": page.number,
                                "text": text,
                                "bbox": [
                                    s["bbox"][0] / page.rect.width * 1000,
                                    s["bbox"][1] / page.rect.height * 1000,
                                    s["bbox"][2] / page.rect.width * 1000,
                                    s["bbox"][3] / page.rect.height * 1000,
                                ],
                                "angle": line["dir"],
                                "size": s["size"],
                            }
                        )
    matched = []
    for i, b in enumerate(blocks):
        if b.get("type") != "text" or not b.get("bbox"):
            continue
        targets = [
            e
            for e in evidence
            if e["page"] == b.get("page_idx")
            and e["text"] == b.get("text", "").strip()
            and len(signatures[e["text"]]) >= 3
            and max(abs(a - v) for a, v in zip(e["bbox"], b["bbox"])) < 7
        ]
        if len(targets) == 1:
            matched.append({"index": i, "source": targets[0]})
    return matched


def _coverage_text(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def _coverage_tokens(text: str) -> Counter:
    return Counter(
        re.findall(
            r"[A-Za-z]+|\d+(?:[.,]\d+)*|[^\W\s]",
            unicodedata.normalize("NFKC", text).replace("^", ""),
        )
    )


def removed_coverage(
    page: pymupdf.Page, table: dict, blocks: list[dict], watermarks: list[dict]
) -> bool:
    """Every removed source character needs a represented location and output text."""
    meaning = " ".join(
        table["headers"]
        + [v for row in table["rows"] for v in row]
        + [table["title"], table["notes"]]
    )
    output = _coverage_text(meaning)
    represented = table["assignments"] + table["header_scopes"] + table["context_lines"]
    # Recover stub evidence for numeric header scopes the helper records.
    first_y = min(a["bbox"][1] for a in table["assignments"] if a["column"] > 0)
    represented += [
        l
        for l in geometry.text_lines(page)
        if l["bbox"][3] <= first_y
        and any(
            _coverage_text(l["text"]) in _coverage_text(h) for h in table["headers"]
        )
    ]
    represented = [r for r in represented if _coverage_text(r["text"]) in output]
    native_rects = [
        pymupdf.Rect(
            b["bbox"][0] * page.rect.width / 1000,
            b["bbox"][1] * page.rect.height / 1000,
            b["bbox"][2] * page.rect.width / 1000,
            b["bbox"][3] * page.rect.height / 1000,
        )
        for b in blocks
    ]
    for block in page.get_text("rawdict", flags=RAW_FLAGS)["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                text = "".join(c["c"] for c in span["chars"])
                if any(
                    w["source"]["page"] == page.number
                    and w["source"]["text"] == text.strip()
                    and max(
                        abs(a - b) for a, b in zip(w["source"]["angle"], line["dir"])
                    )
                    < 0.01
                    and abs(w["source"]["size"] - span["size"]) < 0.1
                    for w in watermarks
                ):
                    continue
                for char in span["chars"]:
                    if not char["c"].strip():
                        continue
                    box = pymupdf.Rect(char["bbox"])
                    point = (box.tl + box.br) / 2
                    if not any(r.contains(point) for r in native_rects):
                        continue
                    if char["c"] in ".·…" and any(
                        pymupdf.Rect(line["bbox"]).contains(point)
                        for line in table.get("decorative_lines", [])
                    ):
                        continue
                    if not any(
                        pymupdf.Rect(r["bbox"]).contains(point)
                        and _coverage_text(char["c"]) in _coverage_text(r["text"])
                        for r in represented
                    ):
                        return False
    native_text = " ".join(
        b.get("text", "\n".join(b.get("list_items", []))) for b in blocks
    )
    return not (_coverage_tokens(native_text) - _coverage_tokens(meaning))


def replace_tables(
    blocks: list[dict],
    bundles: list[dict],
    watermarks: list[dict],
    document: pymupdf.Document,
) -> tuple[list[dict], int]:
    eligible = {e["index"] for e in watermarks}
    drops: set[int] = set()
    additions: dict[int, dict] = {}
    for bundle in bundles:
        block = copy.deepcopy(bundle["block"])
        block["_native_table_title"] = bundle["table"]["title"]
        area = pymupdf.Rect(block["bbox"])
        if bundle["table"].get("source_grid") == "mixed":
            page = document[block["page_idx"]]
            x0, y0, x1, y1 = bundle["table"]["bbox"]
            # Context expands citation bounds, not the set of native blocks
            # consumed by this repair. Complete adjacent captions stay intact.
            area = pymupdf.Rect(
                x0 / page.rect.width * 1000,
                y0 / page.rect.height * 1000,
                x1 / page.rect.width * 1000,
                y1 / page.rect.height * 1000,
            )
        whole, partial, unpositioned, source_watermarks = [], [], [], []
        for i, native in enumerate(blocks):
            if native.get("page_idx") != block["page_idx"]:
                continue
            if not native.get("bbox"):
                unpositioned.append(i)
                continue
            box = pymupdf.Rect(native["bbox"])
            if (box & area).get_area() <= 0:
                continue
            if i in eligible:
                source_watermarks.append(i)
            elif pymupdf.Rect(
                area.x0 - 6, area.y0 - 6, area.x1 + 6, area.y1 + 6
            ).contains(box):
                whole.append(i)
            else:
                partial.append(i)
        preserved_headings = [
            i
            for i in whole
            if blocks[i].get("type") == "text" and blocks[i].get("text_level", 0) > 0
        ]
        candidates = [
            i for i in whole if i not in preserved_headings
        ] + source_watermarks
        if (
            not whole
            or partial
            or unpositioned
            or drops.intersection(candidates)
            or not candidates
            or any(
                blocks[i].get("type")
                in {"table", "header", "footer", "page_footnote", "page_number"}
                for i in whole
            )
        ):
            continue
        if not removed_coverage(
            document[block["page_idx"]],
            bundle["table"],
            [blocks[i] for i in whole if i not in preserved_headings],
            watermarks,
        ):
            continue
        drops.update(candidates)
        additions[min(candidates)] = block
    output = []
    for i, block in enumerate(blocks):
        if i in additions:
            output.append(additions[i])
        if i not in drops:
            output.append(copy.deepcopy(block))
    return output, len(additions)


def recover_tables(
    blocks: list[dict], document: pymupdf.Document
) -> tuple[list[dict], int]:
    """Replace fully covered native blocks with source-geometry tables."""
    bundles, mixed = [], []
    for page in document:
        rules = geometry.horizontal_rules(page)
        if len(rules) < 2:
            continue
        lines = _Lazy(lambda page=page: geometry.text_lines(page))
        for region in select_regions(rules, lines):
            try:
                bundles.append(recover(page, region, lines()))
            except ValueError:
                pass
            try:
                mixed.append(recover_mixed(page, region, lines()))
            except ValueError:
                pass
    watermarks = watermark_blocks(document, blocks)
    recovered, count = replace_tables(blocks, bundles, watermarks, document)
    # Preserve supported numeric tables. Mixed-text recovery only consumes
    # remaining prose and cannot reinterpret an existing native/recovered grid.
    recovered, added = replace_tables(recovered, mixed, [], document)
    return recovered, count + added


def mark_footer_tables(
    blocks: list[dict], native_document: dict
) -> tuple[list[dict], int]:
    """Carry explicit footer ancestry through the adapter's flattened tables."""
    counts: Counter = Counter()
    footers: dict = {}

    def visit(node, in_footer=False):
        identity = node.get("id")
        counts[identity] += 1
        in_footer = in_footer or node.get("type") == "footer"
        if in_footer and node.get("type") == "table":
            footers[identity] = node
        for key in ("kids", "list items", "toc items", "rows", "cells"):
            for child in node.get(key, []):
                visit(child, in_footer)

    visit(native_document)
    result = copy.deepcopy(blocks)
    marked = 0
    for block in result:
        identity = block.get("_native_id")
        node = footers.get(identity)
        if (
            block.get("type") != "table"
            or identity is None
            or counts[identity] != 1
            or node is None
        ):
            continue
        if node.get("page number") != block.get("page_idx", -1) + 1:
            continue
        if odl_content_list(node, [])[0]["table_body"] != block.get("table_body"):
            continue
        block["type"] = "footer"
        marked += 1
    return result, marked
