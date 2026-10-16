"""Element census: figures, drawings and table rows in real PDF and Office files.

Sets the thresholds of the parser's element limit (decision 2026-10-16 in
human/agentic-retrieval.md). For every PDF page it records the counts a cheap
pre-parse check could read without rendering (image XObjects, inline images
and path-painting operators in the page's content stream, its byte size), next
to the costlier MuPDF counts the parse itself pays for (placed images, vector
drawings, characters). For Office files it counts rows, cells, shapes and
pictures in the package XML, before LibreOffice.

    python element_census.py PATH [PATH ...] --out census.jsonl

PATH is a file or a directory (searched recursively). Paths containing
``holdout`` are skipped. Needs PyMuPDF. Prints the largest values per metric.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import zipfile
from pathlib import Path

PAINT = re.compile(rb"(?<![^\s\]\)>])(?:f\*?|F|S|s|B\*?|b\*?)(?=\s)")
INLINE = re.compile(rb"(?<![^\s])BI(?=\s)")
DO = re.compile(rb"(?<![^\s])Do(?=\s)")

OFFICE_COUNTS = {
    ".docx": {"rows": b"<w:tr", "cells": b"<w:tc", "drawings": b"<w:drawing", "vml_shapes": b"<v:shape"},
    ".pptx": {"rows": b"<a:tr", "cells": b"<a:tc", "shapes": b"<p:sp", "pictures": b"<p:pic", "tables": b"<a:tbl"},
    ".xlsx": {"rows": b"<row", "cells": b"<c", "pictures": b"<xdr:pic", "shapes": b"<xdr:sp"},
}


def pdf_census(path: Path) -> dict:
    import pymupdf

    pages = []
    cheap_s = full_s = 0.0
    with pymupdf.open(path) as doc:
        for page in doc:
            started = time.perf_counter()
            contents = page.read_contents()
            cheap = {
                "xobj_images": len(page.get_images(full=True)),
                "inline_images": len(INLINE.findall(contents)),
                "paint_ops": len(PAINT.findall(contents)),
                "do_ops": len(DO.findall(contents)),
                "content_kib": len(contents) // 1024,
            }
            cheap_s += time.perf_counter() - started
            started = time.perf_counter()
            full = {
                "placed_images": len(page.get_image_info()),
                "drawings": len(page.get_cdrawings()),
                "chars": len(page.get_text("text")),
            }
            full_s += time.perf_counter() - started
            pages.append({**cheap, **full})
    keys = pages[0].keys() if pages else []
    return {
        "kind": "pdf",
        "pages": len(pages),
        "max_page": {k: max(p[k] for p in pages) for k in keys},
        "total": {k: sum(p[k] for p in pages) for k in keys},
        "cheap_s": round(cheap_s, 2),
        "full_s": round(full_s, 2),
    }


def office_census(path: Path) -> dict:
    counts = dict.fromkeys(OFFICE_COUNTS[path.suffix], 0)
    xml_mib = media = parts = 0
    with zipfile.ZipFile(path) as package:
        for info in package.infolist():
            if "/media/" in info.filename:
                media += 1
            if not info.filename.endswith(".xml"):
                continue
            data = package.read(info)
            xml_mib += len(data)
            if info.filename.startswith(("word/", "ppt/slides/", "xl/worksheets/", "xl/drawings/", "ppt/")):
                parts += 1
                for key, tag in OFFICE_COUNTS[path.suffix].items():
                    counts[key] += data.count(tag + b" ") + data.count(tag + b">")
    return {"kind": path.suffix[1:], "parts": parts, "media": media, "xml_mib": round(xml_mib / 2**20, 1), "total": counts}


def files(paths: list[str]):
    for raw in paths:
        root = Path(raw)
        found = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in found:
            if "holdout" in str(path).lower() or not path.is_file():
                continue
            if path.suffix.lower() in {".pdf", ".docx", ".pptx", ".xlsx"}:
                yield path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    rows = []
    with open(args.out, "w") as out:
        for path in files(args.paths):
            try:
                if path.suffix.lower() == ".pdf":
                    row = pdf_census(path)
                else:
                    row = office_census(path)
            except Exception as exc:  # noqa: BLE001 - a broken file is skipped
                print(f"skipped {path}: {type(exc).__name__}: {exc}", file=sys.stderr)
                continue
            row["file"] = str(path)
            row["mib"] = round(path.stat().st_size / 2**20, 1)
            rows.append(row)
            out.write(json.dumps(row) + "\n")
            out.flush()
    for kind in ("pdf", "docx", "pptx", "xlsx"):
        group = [r for r in rows if r["kind"] == kind]
        if not group:
            continue
        print(f"== {kind}: {len(group)} files")
        section = "max_page" if kind == "pdf" else "total"
        for key in group[0][section]:
            top = sorted(group, key=lambda r: -r[section][key])[:3]
            print(f"  {section}.{key}: " + ", ".join(f"{r[section][key]} ({Path(r['file']).name[:40]})" for r in top))


if __name__ == "__main__":
    main()
