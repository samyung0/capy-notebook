"""Source-reviewed extension of ruled table geometry, kept outside production."""

from __future__ import annotations

import argparse
import copy
import itertools
import json
import re
import statistics
import time
import unicodedata
from collections import Counter
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

import experiment_odl_table_geometry as geometry
import pymupdf
from experiment_odl_native_tables import chunk_native_bounded, contextualize
from structured_recovery import (
    Table,
    _normalized,
    _repeated_across_pages,
    chunk_structured,
    clean_inline,
)

VALUE = re.compile(
    r"[+−-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\([+−-]?\d+(?:\.\d+)?\))"
    r"(?:[·×]10\^[+−-]?\d+)?(?:[%#@*]+)?"
    r"(?:\([↑↓]?[+−-]?\d[\d,.]*[↑↓]?\))?"
)


def numeric(line):
    return bool(VALUE.fullmatch(re.sub(r"\s+", "", line["text"])))


def in_body(line, region):
    return (
        region[0] - 1 <= line["x"] <= region[2] + 1
        and region[1] <= line["y"] <= region[3] + 1
    )


def select_regions(page, lines):
    """Split matching rules at source headings; retain large ruled row bands."""
    buckets = []
    for rule in geometry.horizontal_rules(page):
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
        groups = []
        for rule in sorted(bucket, key=lambda r: r[1]):
            previous = groups[-1][-1][1] if groups else None
            boundary = previous is not None and any(
                previous < line["y"] < rule[1]
                and (
                    geometry.CAPTION.match(line["text"])
                    or line["bbox"][0] < rule[0] + 0.15 * (rule[2] - rule[0])
                    and re.match(r"^\d+\.\d+(?:\s|$)", line["text"])
                )
                for line in lines
            )
            # A large prose gap still rejects unrelated horizontal decorations.
            if previous is not None and rule[1] - previous > 160:
                between = [l for l in lines if previous < l["y"] < rule[1]]
                boundary |= sum(len(l["text"]) > 100 for l in between) > 2
            if not groups or boundary:
                groups.append([])
            groups[-1].append(rule)
        for group in groups:
            if len(group) >= 2 and group[-1][1] - group[0][1] >= 12:
                result.append([group[0][0], group[0][1], group[0][2], group[-1][1]])
    return sorted(result, key=lambda b: b[1])


def source_context(page, region, lines, table):
    """Attach complete adjacent context, stopping at headings and source gaps."""
    x0, y0, x1, y1 = region
    body = [l for l in lines if in_body(l, region)]
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
    context = []
    close_captions = [
        l for l in captions if min(abs(l["bbox"][3] - y0), abs(l["bbox"][1] - y1)) < 65
    ]
    if numbered and not close_captions:
        start = max(l["y"] for l in numbered)
        context = [
            l
            for l in upper
            if start - 2 <= l["y"] < y0 and (not numeric(l) or l in numbered)
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
                    if nearest["y"] + 2 < l["y"] < y0 and not numeric(l)
                ]
    # Header text above a top rule belongs to the table, not a caption.
    header_above = [
        l
        for l in upper
        if y0 - l["y"] < 16
        and not numeric(l)
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
        and not numeric(l)
    ]
    for line in unit_lines:
        if line not in context:
            context.append(line)
    notes = []
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


def stable_chunks(blocks, original):
    """Freeze repeated-furniture evidence from the original complete document."""
    prepared, _ = contextualize(original, strict=False)
    furniture = _repeated_across_pages(prepared)

    def keep(block):
        return not (
            block.get("type") in {"text", "header", "page_footnote"}
            and not block.get("text_level", 0)
            and _normalized(clean_inline(block.get("text", ""))) in furniture
        )

    clean = [b for b in blocks if keep(b)]
    # After the original decision, do not infer new recurrence from partial runs.
    import experiment_odl_native_tables as native
    import pipeline.retrieval.chunking as production
    import structured_recovery as structured

    with (
        patch.object(native, "_repeated_across_pages", lambda _: set()),
        patch.object(structured, "_repeated_across_pages", lambda _: set()),
        patch.object(production, "_repeated_across_pages", lambda _: set()),
    ):
        return chunk_native_bounded(clean)[1], sorted(furniture)


def row_scope(page, table):
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
    removed = []
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
    groups = []
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


def backgrounds(page, table):
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
        evidence.append(
            {
                "row": cell["row"],
                "column": column,
                "fill": fill,
                "bbox": list(box),
                "source_text": cell["text"],
            }
        )
    table["background_cells"] = evidence
    return table


def recover(page, region, lines):
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
    with patch.object(geometry, "NUMBER", VALUE):
        try:
            table = geometry.table_from_region(page, region, prepared)
        except ValueError as original:
            try:
                table = simple_table(region, prepared)
            except ValueError:
                raise original
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
    if table["background_cells"]:
        for cell in table["background_cells"]:
            styled["rows"][cell["row"]][cell["column"]] += (
                " [gray background in source]"
            )
    # Full long notes remain source-cited footnotes without filling every row's prefix.
    styled["notes"] = ""
    block = geometry.as_block(styled, page)
    if table["notes"]:
        block["table_footnote"] = [table["title"] + "\n" + table["notes"]]
    return {
        "table": table,
        "block": block,
        "chunks": [asdict(c) for c in chunk_structured([block])],
    }


def simple_table(region, lines):
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
            if any(numeric(l) and l["y"] >= y0 for l in g)
            and any(
                not numeric(l)
                and l["bbox"][2] < min(n["bbox"][0] for n in g if numeric(n))
                for l in g
            )
        ),
        None,
    )
    if first is None:
        raise ValueError("no simple labelled row")
    body = [g for g in groups[first:] if any(numeric(l) for l in g)]
    numbers = [[l for l in g if numeric(l)] for g in body]
    columns = len(numbers[0])
    if not columns or any(len(g) != columns for g in numbers):
        raise ValueError("not a complete numeric rectangle")
    centers = [statistics.mean(g[c]["x"] for g in numbers) for c in range(columns)]
    if any(abs(g[c]["x"] - centers[c]) > 8 for g in numbers for c in range(columns)):
        raise ValueError("simple numeric columns not aligned")
    first_x = min(l["bbox"][0] for g in numbers for l in g)
    heads = [l for g in groups[:first] for l in g]
    headers = [[] for _ in range(columns + 1)]
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
        if col and not numeric(l):
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
        "method": "complete numeric rectangle",
    }


def parenthetical_continuations(page, table):
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


def conservative_shape(page, region, lines, table):
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
        numeric(l)
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
        if in_body(l, region) and l["y"] < first_y - 2 and l["bbox"][2] < first_x
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


def watermark_blocks(document, blocks):
    signatures = {}
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
        for b in page.get_text("dict")["blocks"]:
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
                                "max_opacity": 0.2,
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
            matched.append(
                {
                    "index": i,
                    "source": targets[0],
                    "pages_with_signature": len(signatures[targets[0]["text"]]),
                }
            )
    return matched


def coverage_text(text):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text))


def coverage_tokens(text):
    return Counter(
        re.findall(
            r"[A-Za-z]+|\d+(?:[.,]\d+)*|[^\W\s]",
            unicodedata.normalize("NFKC", text).replace("^", ""),
        )
    )


def removed_coverage(page, table, blocks, watermarks):
    """Every removed source character needs a represented location and output text."""
    meaning = " ".join(
        table["headers"]
        + [v for row in table["rows"] for v in row]
        + [table["title"], table["notes"]]
    )
    output = coverage_text(meaning)
    represented = table["assignments"] + table["header_scopes"] + table["context_lines"]
    # The original helper records numeric header scopes; recover its stub evidence.
    first_y = min(a["bbox"][1] for a in table["assignments"] if a["column"] > 0)
    represented += [
        l
        for l in geometry.text_lines(page)
        if l["bbox"][3] <= first_y
        and any(coverage_text(l["text"]) in coverage_text(h) for h in table["headers"])
    ]
    represented = [r for r in represented if coverage_text(r["text"]) in output]
    native_rects = [
        pymupdf.Rect(
            b["bbox"][0] * page.rect.width / 1000,
            b["bbox"][1] * page.rect.height / 1000,
            b["bbox"][2] * page.rect.width / 1000,
            b["bbox"][3] * page.rect.height / 1000,
        )
        for b in blocks
    ]
    missing = []
    checked = 0
    for block in page.get_text("rawdict")["blocks"]:
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
                    checked += 1
                    if not any(
                        pymupdf.Rect(r["bbox"]).contains(point)
                        and coverage_text(char["c"]) in coverage_text(r["text"])
                        for r in represented
                    ):
                        missing.append({"text": char["c"], "bbox": list(box)})
    native_text = " ".join(b.get("text", "") for b in blocks)
    missing_native = coverage_tokens(native_text) - coverage_tokens(meaning)
    return {
        "source_characters_checked": checked,
        "missing_source_characters": missing,
        "missing_native_tokens": dict(missing_native),
        "accepted": not missing and not missing_native,
    }


def replace_tables(blocks, bundles, watermarks, document):
    eligible = {e["index"] for e in watermarks}
    drops = set()
    additions = {}
    receipts = []
    for n, bundle in enumerate(bundles):
        block = copy.deepcopy(bundle["block"])
        block["_native_table_title"] = bundle["table"]["title"]
        area = pymupdf.Rect(block["bbox"])
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
        reason = "accepted"
        if not whole:
            reason = "no contained native content"
        elif partial:
            reason = "partially overlapping ordinary native blocks"
        elif unpositioned:
            reason = "unpositioned native blocks on page"
        elif drops.intersection(candidates):
            reason = "overlapping table replacements"
        elif any(blocks[i].get("type") == "table" for i in whole):
            reason = "existing native table retained"
        coverage = None
        if reason == "accepted":
            coverage = removed_coverage(
                document[block["page_idx"]],
                bundle["table"],
                [blocks[i] for i in whole if i not in preserved_headings],
                watermarks,
            )
            if not coverage["accepted"]:
                reason = "removed native/source content is not completely represented"
        accepted = reason == "accepted"
        receipts.append(
            {
                "table": n,
                "accepted": accepted,
                "reason": reason,
                "page": block["page_idx"] + 1,
                "whole": whole,
                "partial": partial,
                "partial_text": [blocks[i].get("text") for i in partial],
                "unpositioned": unpositioned,
                "source_watermarks": source_watermarks,
                "preserved_headings": preserved_headings,
                "coverage": coverage,
            }
        )
        if accepted:
            drops.update(candidates)
            additions[min(candidates)] = block
    output = []
    for i, block in enumerate(blocks):
        if i in additions:
            output.append(additions[i])
        if i not in drops:
            output.append(copy.deepcopy(block))
    return output, receipts, drops


def scan(manifest_path, output):
    sources = geometry.read(manifest_path)
    results = []
    for source in sources["entries"]:
        if (
            geometry.sha(source["parsed_pdf"]) != source["parsed_pdf_sha256"]
            or geometry.sha(source["content_list"]) != source["content_sha256"]
        ):
            raise ValueError("source bytes changed")
        out = output / source["id"]
        out.mkdir(parents=True, exist_ok=True)
        document = pymupdf.open(source["parsed_pdf"])
        blocks = geometry.read(Path(source["content_list"]))
        started = time.perf_counter()
        pages = [(page.number + 1, geometry.text_lines(page)) for page in document]
        selections = [
            (p, select_regions(document[p - 1], lines), lines) for p, lines in pages
        ]
        selection_s = time.perf_counter() - started
        bundles = []
        candidates = []
        started = time.perf_counter()
        for p, regions, lines in selections:
            for n, region in enumerate(regions):
                try:
                    bundle = recover(document[p - 1], region, lines)
                    path = out / f"p{p}-t{n}.json"
                    geometry.save(path, bundle)
                    candidates.append(
                        {
                            "page": p,
                            "region": n,
                            "bbox": region,
                            "state": "ok",
                            "bundle": str(path),
                            "bundle_index": len(bundles),
                        }
                    )
                    bundles.append(bundle)
                except ValueError as exc:
                    candidates.append(
                        {
                            "page": p,
                            "region": n,
                            "bbox": region,
                            "state": "rejected",
                            "error": str(exc),
                        }
                    )
        recovery_s = time.perf_counter() - started
        started = time.perf_counter()
        watermarks = watermark_blocks(document, blocks)
        merged, receipts, drops = replace_tables(blocks, bundles, watermarks, document)
        replace_s = time.perf_counter() - started
        started = time.perf_counter()
        before, furniture = stable_chunks(blocks, blocks)
        after, after_furniture = stable_chunks(merged, blocks)
        chunk_s = time.perf_counter() - started
        assert furniture == after_furniture
        retained = [b for i, b in enumerate(blocks) if i not in drops]
        assert retained == [
            b for b in merged if b.get("_recovery") != "source-geometry"
        ]
        changed_pages = {blocks[i].get("page_idx") for i in drops}
        same_pages = [
            p
            for p in range(len(document))
            if p not in changed_pages
            and [b for b in blocks if b.get("page_idx") == p]
            == [b for b in merged if b.get("page_idx") == p]
        ]
        safe = lambda c, changed_pages=changed_pages: (
            not any(c.page_start <= p + 1 <= c.page_end for p in changed_pages)
            if c.page_start is not None and c.page_end is not None
            else True
        )
        outside_equal = [asdict(c) for c in before if safe(c)] == [
            asdict(c) for c in after if safe(c)
        ]
        for name, value in [
            ("content_list.json", merged),
            (
                "chunks-before.json",
                [asdict(c) | {"indexed_text": c.indexed_text()} for c in before],
            ),
            (
                "chunks-after.json",
                [asdict(c) | {"indexed_text": c.indexed_text()} for c in after],
            ),
            ("replacement.json", receipts),
            ("watermark-evidence.json", watermarks),
            ("candidates.json", candidates),
        ]:
            geometry.save(out / name, value)
        record = {
            "source": source["id"],
            "pages": len(document),
            "selected": len(candidates),
            "extracted": len(bundles),
            "replaced": sum(r["accepted"] for r in receipts),
            "source_watermarks_removed": sum(
                i in drops for i in [w["index"] for w in watermarks]
            ),
            "unchanged_blocks": len(retained),
            "unchanged_pages": len(same_pages),
            "outside_page_chunks_equal": outside_equal,
            "chunks_before": len(before),
            "chunks_after": len(after),
            "selection_s": selection_s,
            "recovery_s": recovery_s,
            "replace_s": replace_s,
            "two_arm_chunk_s": chunk_s,
        }
        results.append(record)
        print(json.dumps(record))
    geometry.save(
        output / "manifest.json",
        {
            "source_manifest": str(manifest_path),
            "source_manifest_sha256": geometry.sha(manifest_path),
            "script_sha256": geometry.sha(__file__),
            "results": results,
        },
    )


def check():
    assert VALUE.fullmatch("48.9523%")
    assert VALUE.fullmatch("37.21(25.42↓)")
    assert not VALUE.fullmatch("7346.1100.0")
    document = pymupdf.open()
    page = document.new_page()
    for y in [80, 120, 165]:
        page.draw_line((60, y), (500, y))
    for x, t in [(70, "Method"), (240, "Count"), (400, "Percent")]:
        page.insert_text((x, 102), t)
    for y, row in [(140, ["A", "20", "50.0%"]), (157, ["B", "12", "30.0%"])]:
        for x, t in zip([70, 240, 400], row):
            page.insert_text((x, y), t)
    bundle = recover(
        page,
        select_regions(page, geometry.text_lines(page))[0],
        geometry.text_lines(page),
    )
    assert bundle["table"]["rows"] == [["A", "20", "50.0%"], ["B", "12", "30.0%"]]
    assert "Percent" in bundle["chunks"][0]["text"]
    native = [{"bbox": [0, 0, 1000, 1000], "text": ""}]
    assert removed_coverage(page, bundle["table"], native, [])["accepted"]
    page.insert_text((545, 140), "99")
    coverage = removed_coverage(page, bundle["table"], native, [])
    assert not coverage["accepted"]
    assert "".join(c["text"] for c in coverage["missing_source_characters"]) == "99"
    blocks = []
    for _ in range(3):
        page = document.new_page()
        page.insert_text((70, 70), "Ordinary text", fontsize=10)
        page.insert_text(
            (100, 180),
            "WM",
            fontsize=50,
            morph=(pymupdf.Point(100, 180), pymupdf.Matrix(45)),
            fill_opacity=0.1,
        )
        for b in page.get_text("dict")["blocks"]:
            for line in b.get("lines", []):
                for s in line["spans"]:
                    if s["text"] == "WM":
                        blocks.append(
                            {
                                "type": "text",
                                "text": "WM",
                                "page_idx": page.number,
                                "bbox": [
                                    s["bbox"][0] / page.rect.width * 1000,
                                    s["bbox"][1] / page.rect.height * 1000,
                                    s["bbox"][2] / page.rect.width * 1000,
                                    s["bbox"][3] / page.rect.height * 1000,
                                ],
                            }
                        )
    assert len(watermark_blocks(document, blocks)) == 3
    original = [
        b
        for p in range(3)
        for b in [
            {"type": "text", "text": "Repeated note label", "page_idx": p},
            {"type": "text", "text": f"Content {p}", "page_idx": p},
        ]
    ]
    chunks, _ = stable_chunks(original[1:], original)
    assert all("Repeated note label" not in c.text for c in chunks)
    print(
        "numeric cells, final chunk, missing-source coverage, repeated faint diagonal watermark and stable furniture checks passed"
    )


def verify_saved(output):
    """Check that every recovered row, style and context survives final packing."""
    records = []
    normalize = lambda text: coverage_text(
        re.sub(r"\[one merged source cell[^\]]*\]", "", text)
    )
    for directory in sorted(output.iterdir()):
        if not directory.is_dir():
            continue
        candidates = geometry.read(directory / "candidates.json")
        receipts = geometry.read(directory / "replacement.json")
        chunks = geometry.read(directory / "chunks-after.json")
        for receipt in receipts:
            if not receipt["accepted"]:
                continue
            candidate = next(
                c for c in candidates if c.get("bundle_index") == receipt["table"]
            )
            bundle = geometry.read(Path(candidate["bundle"]))
            table = bundle["table"]
            parser = Table()
            parser.feed(bundle["block"]["table_body"])
            headers, rows = parser.grid()
            relevant = [
                (i, c)
                for i, c in enumerate(chunks)
                if c["page_start"] == c["page_end"] == receipt["page"]
                and any(
                    max(
                        abs(a - b)
                        for a, b in zip(region["bbox"], bundle["block"]["bbox"])
                    )
                    < 0.01
                    for region in c["regions"]
                )
            ]
            row_locations = [
                [
                    i
                    for i, c in relevant
                    if all(
                        normalize(text) in normalize(c["text"])
                        for text in [
                            " | ".join(row),
                            " | ".join(headers),
                            table["title"],
                        ]
                    )
                ]
                for row in rows
            ]
            notes = not table["notes"] or any(
                normalize(table["notes"]) in normalize(c["text"]) for _, c in relevant
            )
            assert all(row_locations) and notes, (
                directory.name,
                receipt["page"],
                candidate["region"],
            )
            assert receipt["coverage"]["accepted"]
            records.append(
                {
                    "source": directory.name,
                    "page": receipt["page"],
                    "region": candidate["region"],
                    "headers": headers,
                    "rows": rows,
                    "spans": table["spans"],
                    "bold_cells": table["bold_cells"],
                    "background_cells": table["background_cells"],
                    "title": table["title"],
                    "notes": table["notes"],
                    "row_chunk_indices": row_locations,
                    "complete_notes": notes,
                    "coverage": receipt["coverage"],
                    "source_crop": f"full-source-review/{directory.name}/p{receipt['page']}-t{candidate['region']}.png",
                }
            )
    report = {
        "tables": len(records),
        "rows": sum(len(r["rows"]) for r in records),
        "records": records,
        "scope": "Every accepted replacement, including row styles, complete headers, title, notes and citation. This verifies serialization of source-reviewed grids; it does not independently score source correctness.",
    }
    geometry.save(output / "final-row-chunk-audit.json", report)
    print(json.dumps({k: report[k] for k in ["tables", "rows"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-root", type=Path)
    parser.add_argument("--sources", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--verify-saved", type=Path)
    args = parser.parse_args()
    if args.check:
        check()
        return
    if args.verify_saved:
        verify_saved(args.verify_saved)
        return
    if not (args.audit_root or args.sources) or not args.output:
        parser.error("--audit-root or --sources, and --output are required")
    args.output.mkdir(parents=True, exist_ok=False)
    if args.sources:
        scan(args.sources, args.output)
        return
    audit = geometry.read(args.audit_root / "accepted-source-audit.json")
    records = []
    for record in audit["records"]:
        page = pymupdf.open(record["source_pdf"])[record["page"] - 1]
        lines = geometry.text_lines(page)
        try:
            result = recover(page, record["table"]["bbox"], lines)
            geometry.save(
                args.output
                / record["source"]
                / f"p{record['page']}-t{record['region_index']}.json",
                result,
            )
            records.append(
                {
                    "source": record["source"],
                    "page": record["page"],
                    "index": record["region_index"],
                    "state": "ok",
                }
            )
        except ValueError as exc:
            records.append(
                {
                    "source": record["source"],
                    "page": record["page"],
                    "index": record["region_index"],
                    "state": "reject",
                    "error": str(exc),
                }
            )
    geometry.save(
        args.output / "manifest.json",
        {"records": records, "script_sha256": geometry.sha(__file__)},
    )
    print(json.dumps(Counter(r["state"] for r in records)))


if __name__ == "__main__":
    main()
