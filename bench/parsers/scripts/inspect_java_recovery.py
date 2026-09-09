"""Measure source-PDF signals for selective recovery of saved Java output.

This is a benchmark inventory, not an admission or production fallback policy.
Run with PyMuPDF 1.28.2 and the sibling comparison adapter available.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import time
import unicodedata
from collections import Counter
from itertools import pairwise
from pathlib import Path

import pymupdf
from compare_opendataloader import odl_content_list, save


def normal(text: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return "".join(
        c for c in unicodedata.normalize("NFKC", text).casefold() if c.isalnum()
    )


def block_text(block: dict) -> str:
    return " ".join(
        " ".join(value) if isinstance(value, list) else str(value)
        for key in ["text", "latex", "list_items", "table_body", "image_caption"]
        if (value := block.get(key))
    )


def significant(rect: pymupdf.Rect) -> bool:
    # Match the existing 130-pixel figure minimum at the tested 144 DPI.
    return rect.width >= 65 and rect.height >= 65


def structural_signals(page: pymupdf.Page, drawings: list[dict]) -> dict:
    """Detect recovery needs, without treating a second table parser as truth."""
    tables = []
    for strategy in [
        {"strategy": "lines"},
        {"vertical_strategy": "text", "horizontal_strategy": "lines"},
    ]:
        for table in page.find_tables(paths=drawings, **strategy).tables:
            if table.row_count < 2 or table.col_count < 2:
                continue
            tables.append(
                {
                    "bbox": list(pymupdf.Rect(table.bbox) * page.rotation_matrix),
                    "rows": table.row_count,
                    "columns": table.col_count,
                    "strategy": strategy,
                }
            )
    duplicates = []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            chars = [c for span in line["spans"] for c in span["chars"]]
            for first, second in pairwise(chars):
                # Some PDFs map one displayed radical to a radical plus a
                # zero-width ordinary ideograph. Character-bag recall is 100%.
                radical = "\u2e80" <= first["c"] <= "\u2fdf"
                same = unicodedata.normalize("NFKC", first["c"]) == second["c"]
                box = second["bbox"]
                if radical and same and abs(box[2] - box[0]) < 0.01:
                    duplicates.append(first["c"] + second["c"])
    return {"source_tables": tables, "zero_width_duplicate_glyphs": duplicates}


def inventory(
    baseline: Path,
    output: Path,
    suites: list[str],
    java_root: Path,
    java_config: str,
    structure: bool = False,
) -> None:
    corpus = json.loads((baseline / "corpus.json").read_text())
    started = time.monotonic()
    records = []
    (output / "cases").mkdir(parents=True, exist_ok=True)
    for entry in corpus["entries"]:
        suite = entry["suite"]
        if suite not in suites:
            continue
        case_started = time.monotonic()
        name = entry["id"]
        run = f"{suite}-{java_config}"
        native_dir = java_root / "results" / run / name
        pdf_path = baseline / entry["pdf"]
        if hashlib.sha256(pdf_path.read_bytes()).hexdigest() != entry["pdf_sha256"]:
            raise ValueError(f"PDF hash mismatch: {pdf_path}")
        reference = json.loads(
            (baseline / "prepared" / f"{name}.reference.json").read_text()
        )
        native = json.loads((native_dir / f"{name}.json").read_text())
        blocks = odl_content_list(native, reference)
        pages = []
        with pymupdf.open(pdf_path) as document:
            for index, page in enumerate(document):
                page_started = time.monotonic()
                page_blocks = [b for b in blocks if b.get("page_idx") == index]
                java_text = normal("\n".join(block_text(b) for b in page_blocks))
                native_text = normal(page.get_text())
                expected, actual = Counter(native_text), Counter(java_text)
                coverage = (
                    sum((expected & actual).values()) / len(native_text)
                    if native_text
                    else None
                )
                images = page.get_image_info()
                drawings = page.get_drawings()
                strokes = [d for d in drawings if "s" in d["type"]]
                all_clusters = page.cluster_drawings(drawings=drawings)
                stroke_clusters = page.cluster_drawings(drawings=strokes)
                visible = page.rect

                def mapped(rect, matrix=page.rotation_matrix, limit=visible):
                    return list((pymupdf.Rect(rect) * matrix) & limit)

                all_regions = [mapped(r) for r in all_clusters if significant(r)]
                stroke_regions = [mapped(r) for r in stroke_clusters if significant(r)]
                image_regions = [mapped(image["bbox"]) for image in images]
                image_ratios = [
                    pymupdf.Rect(rect).get_area() / visible.get_area()
                    for rect in image_regions
                ]
                largest_image = max(image_ratios, default=0)
                tables = [b["bbox"] for b in page_blocks if b.get("type") == "table"]
                flags = []
                if len(native_text) < 100 and largest_image >= 0.5:
                    flags.append("scan")
                if len(native_text) >= 100 and coverage is not None and coverage < 0.8:
                    flags.append("text_gap")
                if stroke_regions:
                    flags.append("vector")
                if tables:
                    flags.append("table")
                extra = {}
                if structure and "scan" not in flags:
                    extra = structural_signals(page, drawings)
                    if extra["source_tables"]:
                        flags.append("source_table")
                    if extra["zero_width_duplicate_glyphs"]:
                        flags.append("encoded_text")
                pages.append(
                    {
                        **extra,
                        "page": index,
                        "source_page": entry["source_pages"][index],
                        "width": visible.width,
                        "height": visible.height,
                        "rotation": page.rotation,
                        "native_chars": len(native_text),
                        "java_chars": len(java_text),
                        "native_character_recall": coverage,
                        "java_types": dict(Counter(b["type"] for b in page_blocks)),
                        "java_tables": tables,
                        "source_images": image_regions,
                        "largest_source_image_ratio": largest_image,
                        "drawing_paths": len(drawings),
                        "stroke_paths": len(strokes),
                        "all_vector_regions": all_regions,
                        "stroke_vector_regions": stroke_regions,
                        "flags": flags,
                        "seconds": time.monotonic() - page_started,
                    }
                )
        record = {
            "id": name,
            "suite": suite,
            "lang": entry["lang"],
            "pdf": entry["pdf"],
            "pdf_sha256": entry["pdf_sha256"],
            "java_run": run,
            "pages": pages,
            "seconds": time.monotonic() - case_started,
        }
        save(output / "cases" / f"{name}.json", record)
        records.append(record)
        print(name, len(pages), round(record["seconds"], 3), flush=True)
    save(
        output / "inventory.json",
        {
            "pymupdf_version": pymupdf.__version__,
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "seconds": time.monotonic() - started,
            "records": records,
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--java-root", type=Path, required=True)
    parser.add_argument("--java-config", required=True)
    parser.add_argument("--structure", action="store_true")
    parser.add_argument(
        "--suites", nargs="+", choices=["screen", "full", "long"], required=True
    )
    args = parser.parse_args()
    inventory(
        args.baseline,
        args.output,
        args.suites,
        args.java_root,
        args.java_config,
        args.structure,
    )


if __name__ == "__main__":
    main()
