"""The parser's element limits (parser/odl/elements.py) over real files.

For every PDF: its image placements (file and busiest page) and paint
operators exactly as the parser counts them, form XObjects expanded, each as a
share of its limit, and whether the parser would refuse it. Office files run
the parser's own package check.

    python element_check.py PATH [PATH ...] --out check.jsonl

PATH is a file or a directory (searched recursively). Paths containing
``holdout`` are skipped. Run from ``pipeline/`` (PyMuPDF), so the counts match the parser's. Prints every refused
file and the closest files to each limit.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "parser"))

import pymupdf  # noqa: E402
from odl import elements  # noqa: E402

LIMITS = {
    "placements": elements.PDF_PLACEMENTS,
    "page_placements": elements.PDF_PAGE_PLACEMENTS,
    "paints": elements.PDF_PAINTS,
}


def pdf_counts(path: Path) -> dict:
    with pymupdf.open(path) as doc:
        counter = elements._PdfCounter(doc)
        placements = page_placements = paints = 0
        for page in doc:
            names = counter.names(page)
            p, v = counter.stream(page.read_contents(), names.get(0, {}), names)
            placements += p
            page_placements = max(page_placements, p)
            paints += v
        pages = len(doc)
    counts = {"placements": placements, "page_placements": page_placements, "paints": paints}
    return {
        "pages": pages,
        **counts,
        "share": {k: round(counts[k] / LIMITS[k], 3) for k in LIMITS},
        "refused": [k for k in LIMITS if counts[k] > LIMITS[k]],
    }


def office_check(path: Path) -> dict:
    try:
        elements.check_office(path.read_bytes(), path.name)
    except elements.TooManyElements as exc:
        return {"refused": [str(exc)]}
    return {"refused": []}


def files(paths: list[str]):
    for raw in paths:
        root = Path(raw)
        for path in [root] if root.is_file() else sorted(root.rglob("*")):
            if "holdout" in str(path).lower() or not path.is_file():
                continue
            if path.suffix.lower() in {".pdf", ".docx", ".pptx"}:
                yield path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    rows = []
    with open(args.out, "w") as out:
        for path in files(args.paths):
            started = time.perf_counter()
            try:
                row = pdf_counts(path) if path.suffix.lower() == ".pdf" else office_check(path)
            except Exception as exc:  # noqa: BLE001 - a broken file is skipped
                print(f"skipped {path}: {type(exc).__name__}: {exc}", file=sys.stderr)
                continue
            row.update(file=str(path), s=round(time.perf_counter() - started, 2))
            rows.append(row)
            out.write(json.dumps(row) + "\n")
            out.flush()
    refused = [r for r in rows if r["refused"]]
    print(f"{len(rows)} files, {len(refused)} refused")
    for r in refused:
        print(f"  REFUSED {r['file']}: {r['refused']}")
    pdfs = [r for r in rows if "share" in r]
    for key in LIMITS:
        top = sorted(pdfs, key=lambda r: -r["share"][key])[:3]
        print(f"  {key} (limit {LIMITS[key]:,}): " + ", ".join(f"{r[key]:,} {Path(r['file']).name[:40]}" for r in top))
    if pdfs:
        print(f"  slowest check: {max(r['s'] for r in pdfs)} s")


if __name__ == "__main__":
    main()
