"""Offline experiment for ruled PDF tables. No OCR, parser or provider calls.

Rows/columns come from source text geometry. Explicit source typography is kept
as exponent notation and bold-cell annotations. Selection never reads answers.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import itertools
import json
import math
import re
import statistics
import time
from dataclasses import asdict
from pathlib import Path

import pymupdf
from structured_recovery import chunk_structured, table_html

NUMBER = re.compile(r"[+−-]?(?:\d[\d,.]*|\([+−-]?\d[\d,.]*\))(?:[·×]10\^\d+)?[*]*")
CAPTION = re.compile(r"^(?:Table|表)\s*\d+\s*[:：.]?", re.IGNORECASE)
SECTION = re.compile(r"^\d+\.\d+(?:\.\d+)*$")


def save(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def text_lines(page):
    out = []
    for block in page.get_text("dict")["blocks"]:
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


def row_groups(lines, tolerance=2.0):
    groups = []
    for line in sorted(lines, key=lambda x: x["y"]):
        if (
            not groups
            or line["y"] - statistics.median(x["y"] for x in groups[-1]) > tolerance
        ):
            groups.append([])
        groups[-1].append(line)
    return [sorted(g, key=lambda x: x["bbox"][0]) for g in groups]


def horizontal_rules(page):
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
    unique = []
    for rule in sorted(rules):
        if not any(max(abs(a - b) for a, b in zip(rule, r)) < 1 for r in unique):
            unique.append(rule)
    return unique


def select_regions(page, lines=None):
    if lines is None:
        lines = text_lines(page)
    buckets = []
    for rule in horizontal_rules(page):
        target = next(
            (
                b
                for b in buckets
                if abs(b[0][0] - rule[0]) < 2 and abs(b[0][2] - rule[2]) < 2
            ),
            None,
        )
        if target is None:
            target = []
            buckets.append(target)
        target.append(rule)
    candidates = []
    for bucket in buckets:
        groups = []
        for rule in sorted(bucket, key=lambda r: r[1]):
            boundary = False
            if groups:
                previous = groups[-1][-1][1]
                boundary = rule[1] - previous > 100 or any(
                    previous < l["y"] < rule[1]
                    and l["bbox"][0] < rule[0] + 0.15 * (rule[2] - rule[0])
                    and (CAPTION.match(l["text"]) or SECTION.fullmatch(l["text"]))
                    for l in lines
                )
            if not groups or boundary:
                groups.append([])
            groups[-1].append(rule)
        for group in groups:
            if len(group) >= 2 and group[-1][1] - group[0][1] >= 18:
                candidates.append([group[0][0], group[0][1], group[0][2], group[-1][1]])
    return sorted(candidates, key=lambda b: b[1])


def numeric(line):
    return bool(NUMBER.fullmatch(re.sub(r"\s+", "", line["text"])))


def clusters(values, tolerance=6):
    groups = []
    for value in sorted(values):
        if not groups or value - statistics.mean(groups[-1]) > tolerance:
            groups.append([])
        groups[-1].append(value)
    return groups


def table_from_region(page, rect, all_lines=None):
    """Reject unsupported layouts rather than guessing a missing column."""
    if all_lines is None:
        all_lines = text_lines(page)
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
    [x0, split, *[(a + b) / 2 for a, b in itertools.pairwise(centers)], x1]
    header_lines = [l for g in groups[:start] for l in g]
    headers = [[] for _ in range(len(centers) + 1)]
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
    headers = [" / ".join(items) for items in headers]
    if any(not h for h in headers[1:]):
        raise ValueError("a numeric column lacks source headers")
    baselines = [statistics.median(l["y"] for l in g) for g in body_groups]
    rows = [[""] * len(headers) for _ in body_groups]
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
        "headers": headers,
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


def as_block(table, page):
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


def row_label_spans(page, table):
    """Second experimental arm: two stub headers and centered ruled groups."""
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


def replace_regions(blocks, bundles, *, allow_partial=False):
    """Replace contained native blocks; oracle mode is explicit and recorded."""
    drops, additions, receipts = set(), {}, []
    for bundle in bundles:
        block = copy.deepcopy(bundle["block"])
        block["_native_table_title"] = bundle["table"]["title"]
        area = block["bbox"]
        whole = []
        partial = []
        unpositioned = []
        for i, native in enumerate(blocks):
            if native.get("page_idx") != block["page_idx"]:
                continue
            box = native.get("bbox")
            if not box:
                unpositioned.append(i)
                continue
            if min(area[2], box[2]) <= max(area[0], box[0]) or min(
                area[3], box[3]
            ) <= max(area[1], box[1]):
                continue
            # Six page-1000 units allow the two PDF engines' font-box margins.
            if all(a >= s - 6 for a, s in zip(box[:2], area[:2])) and all(
                a <= s + 6 for a, s in zip(box[2:], area[2:])
            ):
                whole.append(i)
            else:
                partial.append(i)
        accepted = bool(whole) and not unpositioned and (allow_partial or not partial)
        receipts.append(
            {
                "accepted": accepted,
                "wholly_contained": whole,
                "partially_overlapping": partial,
                "unpositioned": unpositioned,
                "partial_text": [blocks[i].get("text") for i in partial],
                "oracle_allow_partial": allow_partial,
            }
        )
        if accepted:
            indices = whole + partial
            if drops.intersection(indices):
                raise ValueError("replacement regions claim the same native block")
            drops.update(indices)
            additions[min(indices)] = block
    merged = []
    for i, block in enumerate(blocks):
        if i in additions:
            merged.append(additions[i])
        if i not in drops:
            merged.append(copy.deepcopy(block))
    return merged, receipts


def check():
    doc = pymupdf.open()
    page = doc.new_page()
    for y in [80, 120, 160]:
        page.draw_line((60, y), (500, y))
    for x, t in [(70, "Method"), (240, "Group A"), (400, "Group B")]:
        page.insert_text((x, 100), t)
    for y, row in [(135, ["A", "1.25", "2.50"]), (151, ["B", "3.75", "4.50"])]:
        for x, t in zip([70, 240, 400], row):
            page.insert_text((x, y), t)
    selected = select_regions(page)
    assert len(selected) == 1
    table = table_from_region(page, selected[0])
    assert table["rows"] == [["A", "1.25", "2.50"], ["B", "3.75", "4.50"]]
    assert table["headers"] == ["Method", "Group A", "Group B"]
    assert "1.25" in chunk_structured([as_block(table, page)])[0].text
    grouped = doc.new_page()
    for y in [80, 120, 174, 234]:
        grouped.draw_line((60, y), (500, y))
    for x, t in [(70, "Task"), (110, "Domain"), (240, "Count A"), (400, "Count B")]:
        grouped.insert_text((x, 100), t)
    for x, y, t in [(70, 151, "SDS"), (70, 210, "MDS")]:
        grouped.insert_text((x, y), t)
    for i, y in enumerate([135, 151, 167, 194, 210, 226]):
        for x, t in [(110, chr(65 + i)), (240, str(i + 10)), (400, str(i + 20))]:
            grouped.insert_text((x, y), t)
    grouped_table = table_from_region(grouped, select_regions(grouped)[0])
    revised = row_label_spans(grouped, grouped_table)
    assert revised["spans"] == [
        {"row": 0, "column": 0, "rowspan": 3, "colspan": 1},
        {"row": 3, "column": 0, "rowspan": 3, "colspan": 1},
    ]
    assert [r[2:] for r in revised["rows"]] == [r[1:] for r in grouped_table["rows"]]
    assert (
        "one merged source cell, rows 1-3; columns Task"
        in chunk_structured([as_block(revised, grouped)])[0].text
    )
    native = [
        {"type": "text", "page_idx": 0, "bbox": [0, 0, 100, 100], "text": "crossing"},
        {"type": "text", "page_idx": 1, "bbox": [0, 0, 100, 100], "text": "untouched"},
    ]
    bundle = {
        "table": {"title": "Table"},
        "block": {"type": "table", "page_idx": 0, "bbox": [20, 20, 90, 90]},
    }
    merged, receipts = replace_regions(native, [bundle])
    assert merged == native and not receipts[0]["accepted"]
    print("ruled selection, geometry rows, headers and final chunk check passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--row-label-spans", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.root or not args.output:
        parser.error("root and output required")
    frozen = read(args.root / "frozen-checks.json")
    args.output.mkdir(parents=True, exist_ok=False)
    inventory = []
    selected = []
    for name, source in frozen["sources"].items():
        if sha(source["pdf"]) != source["sha256"]:
            raise ValueError("source changed")
        document = pymupdf.open(source["pdf"])
        started = time.perf_counter()
        records = []
        for page in document:
            lines = text_lines(page)
            regions = select_regions(page, lines)
            records.append({"page": page.number + 1, "regions": regions})
        inventory.append(
            {
                "source": name,
                "pages": len(document),
                "selection_s": time.perf_counter() - started,
                "records": records,
            }
        )
        for record in records:
            page = document[record["page"] - 1]
            for index, region in enumerate(record["regions"]):
                entry = {
                    "source": name,
                    "page": record["page"],
                    "region_index": index,
                    "bbox": region,
                }
                begun = time.perf_counter()
                try:
                    table = table_from_region(page, region)
                    if args.row_label_spans:
                        table = row_label_spans(page, table)
                    block = as_block(table, page)
                    chunks = [asdict(c) for c in chunk_structured([block])]
                    save(
                        args.output / name / f"p{record['page']}-t{index}.json",
                        {"table": table, "block": block, "chunks": chunks},
                    )
                    entry.update(
                        state="ok",
                        rows=len(table["rows"]),
                        columns=len(table["headers"]),
                        spans=len(table["spans"]),
                    )
                except ValueError as exc:
                    entry.update(state="rejected", error=str(exc))
                entry["extraction_s"] = time.perf_counter() - begun
                selected.append(entry)
    save(
        args.output / "manifest.json",
        {
            "inventory": inventory,
            "selected": selected,
            "checks_sha256": sha(args.root / "frozen-checks.json"),
            "script_sha256": sha(__file__),
            "pymupdf_version": pymupdf.__version__,
            "row_label_spans": args.row_label_spans,
        },
    )
    print(
        json.dumps(
            {
                "candidates": len(selected),
                "accepted": sum(x["state"] == "ok" for x in selected),
            }
        )
    )


if __name__ == "__main__":
    main()
