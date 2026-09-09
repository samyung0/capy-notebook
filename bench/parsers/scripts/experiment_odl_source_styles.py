"""Benchmark native table-cell background retention. No model or PDF mutation."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import time
from dataclasses import asdict
from pathlib import Path

import pymupdf
from compare_opendataloader import node_text, odl_content_list
from structured_recovery import chunk_content_list, chunk_structured


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def nodes(node: dict):
    yield node
    for key in ("kids", "rows", "cells", "list items", "toc items"):
        for child in node.get(key, []):
            yield from nodes(child)


def color_name(fill: tuple) -> str | None:
    # ponytail: this pilot names only yellow; other colors need source review.
    if len(fill) == 3 and fill[0] >= 0.85 and fill[1] >= 0.85 and fill[2] <= 0.6:
        return "yellow"
    return None


def annotate(document: pymupdf.Document, native: dict) -> tuple[dict, list[dict]]:
    candidate = copy.deepcopy(native)
    receipts = []
    page_data = {}
    for cell in nodes(candidate):
        if cell.get("type") != "table cell" or not node_text(cell).strip():
            continue
        page_number = cell.get("page number")
        if not isinstance(page_number, int) or not 1 <= page_number <= len(document):
            raise ValueError("table cell has no valid source page")
        page = document[page_number - 1]
        # Java boxes in this pilot assume an ordinary unrotated PDF page.
        if (
            page.rotation
            or page.cropbox != page.mediabox
            or page.rect.x0
            or page.rect.y0
        ):
            continue
        if page_number not in page_data:
            drawings = page.get_drawings()
            has_yellow = any(
                color_name(drawing.get("fill") or ()) for drawing in drawings
            )
            page_data[page_number] = (
                drawings,
                page.get_text("words") if has_yellow else [],
            )
        drawings, words = page_data[page_number]
        if not words:
            continue
        x0, y0, x1, y1 = cell["bounding box"]
        box = pymupdf.Rect(x0, page.rect.height - y1, x1, page.rect.height - y0)
        if box.is_empty:
            continue
        selected = [
            word
            for word in words
            if box.contains(
                pymupdf.Point((word[0] + word[2]) / 2, (word[1] + word[3]) / 2)
            )
        ]
        source_text = " ".join(word[4] for word in selected)
        if "".join(source_text.split()) != "".join(node_text(cell).split()):
            continue
        matches = []
        for drawing in drawings:
            fill = drawing.get("fill")
            items = drawing.get("items", [])
            if (
                not fill
                or drawing.get("fill_opacity") != 1
                or len(items) != 1
                or items[0][0] != "re"
                or not color_name(fill)
            ):
                continue
            rectangle = drawing["rect"]
            overlap = (box & rectangle).get_area()
            if overlap < 0.8 * box.get_area() or overlap < 0.8 * rectangle.get_area():
                continue
            if any(
                other["seqno"] > drawing["seqno"]
                and other.get("fill") is not None
                and other.get("fill_opacity", 0) > 0
                and (rectangle & other["rect"]).get_area() > 0.1 * rectangle.get_area()
                for other in drawings
            ):
                continue
            matches.append(drawing)
        if len(matches) != 1:
            continue
        fill = matches[0]["fill"]
        cell.setdefault("kids", []).append(
            {"content": f"[{color_name(fill)} background]"}
        )
        receipts.append(
            {
                "page": page_number,
                "cell_id": cell["id"],
                "row": cell["row number"],
                "column": cell["column number"],
                "source_text": source_text,
                "cell_bbox": list(box),
                "fill_bbox": list(matches[0]["rect"]),
                "fill_rgb": fill,
                "drawing_seqno": matches[0]["seqno"],
            }
        )
    return candidate, receipts


def check() -> None:
    document = pymupdf.open()
    page = document.new_page(width=200, height=200)
    for index, fill in enumerate([(1, 1, 0), (1, 1, 1), (0, 0, 1)]):
        box = pymupdf.Rect(10, 20 + index * 30, 80, 45 + index * 30)
        page.draw_rect(box, fill=fill, color=None)
        page.insert_text((20, 37 + index * 30), str(index))
    native = {
        "kids": [
            {
                "type": "table cell",
                "id": index,
                "page number": 1,
                "row number": index + 1,
                "column number": 1,
                "bounding box": [10, 155 - index * 30, 80, 180 - index * 30],
                "kids": [{"content": str(index)}],
            }
            for index in range(3)
        ]
    }
    _, receipts = annotate(document, native)
    assert [row["cell_id"] for row in receipts] == [0]
    page.draw_rect(pymupdf.Rect(10, 20, 80, 45), fill=(1, 1, 1), color=None)
    assert annotate(document, native)[1] == []
    assert "background" not in json.dumps(native)
    document.close()
    print("source style check passed")


def evaluate(
    candidate: dict, receipts: list[dict], chunks: list[dict], checks: dict
) -> dict:
    tables = [
        node
        for node in nodes(candidate)
        if node.get("type") == "table" and node.get("page number") == checks["page"]
    ]
    expected_labels = {row["label"] for row in checks["rows"]}
    tables = [
        table
        for table in tables
        if expected_labels
        <= {node_text(row["cells"][0]).strip() for row in table["rows"] if row["cells"]}
    ]
    if len(tables) != 1:
        raise ValueError("source-check table did not match uniquely")
    outcomes = []
    for expected in checks["rows"]:
        row = next(
            row
            for row in tables[0]["rows"]
            if node_text(row["cells"][0]).strip() == expected["label"]
        )
        values = [node_text(cell).strip() for cell in row["cells"][1:]]
        expected_values = [
            value
            + (" [yellow background]" if col in expected["yellow_columns"] else "")
            for col, value in enumerate(expected["values"])
        ]
        row_text = " | ".join([expected["label"], *expected_values])
        outcomes.append(
            {
                "label": expected["label"],
                "exact_values_and_colors": values == expected_values,
                "row_in_one_chunk_with_headers": any(
                    row_text in chunk["text"]
                    and all(column in chunk["text"] for column in checks["columns"])
                    for chunk in chunks
                ),
            }
        )
    return {
        "rows": outcomes,
        "marked_cells": len(receipts),
        "expected_marked_cells": sum(
            len(row["yellow_columns"]) for row in checks["rows"]
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--checks", type=Path)
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not all((args.pdf, args.native, args.output)):
        parser.error("--pdf, --native and --output are required")
    args.output.mkdir(parents=True, exist_ok=False)
    native = json.loads(args.native.read_text(encoding="utf-8"))
    checks = (
        json.loads(args.checks.read_text(encoding="utf-8")) if args.checks else None
    )
    if checks and checks["pdf_sha256"] != digest(args.pdf):
        raise ValueError("source checks belong to another PDF")
    started = time.perf_counter()
    with pymupdf.open(args.pdf) as document:
        candidate, receipts = annotate(document, native)
        pages = [
            {"width": page.rect.width, "height": page.rect.height} for page in document
        ]
    seconds = time.perf_counter() - started
    save(args.output / "native-with-styles.json", candidate)
    save(args.output / "cells.json", receipts)
    for arm, data in [("baseline", native), ("candidate", candidate)]:
        blocks = odl_content_list(data, pages)
        save(args.output / f"{arm}-content.json", blocks)
        for name, chunker in [
            ("production", chunk_content_list),
            ("structured", chunk_structured),
        ]:
            try:
                chunks = [asdict(chunk) for chunk in chunker(blocks)]
            except ValueError as exc:
                save(
                    args.output / f"{arm}-{name}-error.json",
                    {"state": "failed", "error": str(exc)},
                )
                continue
            save(args.output / f"{arm}-{name}-chunks.json", chunks)
            if checks and arm == "candidate":
                save(
                    args.output / f"evaluation-{name}.json",
                    evaluate(candidate, receipts, chunks, checks),
                )
    repository = Path(__file__).resolve().parents[3]
    save(
        args.output / "receipt.json",
        {
            "pdf_sha256": digest(args.pdf),
            "native_sha256": digest(args.native),
            "script_sha256": digest(Path(__file__)),
            "pymupdf": pymupdf.VersionBind,
            "annotation_seconds": seconds,
            "annotated_cells": len(receipts),
            "pages": len(pages),
            "timing_scope": "PDF open, native JSON copy, source cell inspection; excludes Java and chunking",
            "checks_sha256": digest(args.checks) if args.checks else None,
            "dependencies": {
                str(path.relative_to(repository)): digest(path)
                for path in [
                    Path(__file__).with_name("compare_opendataloader.py"),
                    Path(__file__).with_name("structured_recovery.py"),
                    repository / "pipeline/pipeline/retrieval/chunking.py",
                    repository / "pipeline/pipeline/retrieval/lang.py",
                    repository / "pipeline/pipeline/config.py",
                ]
            },
        },
    )
    print(json.dumps({"annotation_seconds": seconds, "annotated_cells": len(receipts)}))


if __name__ == "__main__":
    main()
