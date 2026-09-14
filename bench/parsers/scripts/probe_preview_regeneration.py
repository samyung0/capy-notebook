"""Reconvert frozen Office sources and compare against their saved parser PDF.

Run in a disposable deployed-parser image with the experiment mounted at /probe.
No ODL parsing, model requests, queues, databases or production service calls.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import subprocess
import sys
import time
import traceback
from pathlib import Path

from probe_office_pdf import pdf_geometry


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def raster_hashes(data: bytes) -> list[str]:
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as document:
        return [
            digest(page.get_pixmap(dpi=72, alpha=False).samples) for page in document
        ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--parser-root", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.parser_root))
    from odl.document import normalize_document

    args.output.mkdir(parents=True, exist_ok=False)
    records = []
    for family, source_root, baseline_root in [
        ("feature-rich", "vendor/betteroffice/poc/fixtures", "output"),
        (
            "wetland",
            "bench/parsers/reports/local/2026-09-14-native-citations/bookmarks/corpus",
            "output-final",
        ),
    ]:
        for extension in ("docx", "xlsx", "pptx"):
            identity = f"{family}-{extension}"
            target = args.output / identity
            target.mkdir()
            source = args.root / source_root / f"{family}.{extension}"
            baseline = args.root / baseline_root / identity
            record = {"id": identity, "source": str(source)}
            try:
                data = source.read_bytes()
                old_record = json.loads((baseline / "record.json").read_text())
                record["source_sha256"] = digest(data)
                record["baseline_source_sha256"] = old_record["sha256"]
                if record["source_sha256"] != record["baseline_source_sha256"]:
                    raise ValueError("Source differs from the original parse input")
                old_pdf = (baseline / "preview.pdf").read_bytes()
                started = time.monotonic()
                normalized = normalize_document(data, source.name)
                record["conversion_seconds"] = time.monotonic() - started
                new_pdf = normalized.data
                (target / "regenerated.pdf").write_bytes(new_pdf)
                old_geometry = pdf_geometry(old_pdf)
                new_geometry = pdf_geometry(new_pdf)
                write_json(target / "regenerated-geometry.json", new_geometry)
                old_text = [
                    "\n".join(line["text"] for line in page["lines"])
                    for page in old_geometry
                ]
                new_text = [
                    "\n".join(line["text"] for line in page["lines"])
                    for page in new_geometry
                ]
                old_rasters, new_rasters = (
                    raster_hashes(old_pdf),
                    raster_hashes(new_pdf),
                )
                record.update(
                    status="ok",
                    source_bytes=len(data),
                    original_pdf_bytes=len(old_pdf),
                    regenerated_pdf_bytes=len(new_pdf),
                    original_pdf_sha256=digest(old_pdf),
                    regenerated_pdf_sha256=digest(new_pdf),
                    pdf_bytes_identical=old_pdf == new_pdf,
                    original_pages=len(old_geometry),
                    regenerated_pages=len(new_geometry),
                    page_text_identical=old_text == new_text,
                    full_character_geometry_identical=old_geometry == new_geometry,
                    original_raster_sha256_72dpi=old_rasters,
                    regenerated_raster_sha256_72dpi=new_rasters,
                    raster_identical_72dpi=old_rasters == new_rasters,
                )
                if old_geometry != new_geometry:
                    write_json(target / "original-geometry.json", old_geometry)
                if not (
                    record["page_text_identical"]
                    and record["full_character_geometry_identical"]
                    and record["raster_identical_72dpi"]
                ):
                    record["status"] = "different"
            except Exception as error:  # noqa: BLE001 - retain each independent probe failure
                record.update(status="error", error=str(error))
                (target / "error.txt").write_text(traceback.format_exc())
            write_json(target / "record.json", record)
            records.append(record)
            print(json.dumps(record, ensure_ascii=False), flush=True)
    version = subprocess.run(
        ["/usr/bin/soffice", "--version"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    write_json(
        args.output / "run.json",
        {
            "python": platform.python_version(),
            "libreoffice": version,
            "pymupdf": importlib.metadata.version("PyMuPDF"),
            "scope": "Same source bytes, deployed image, fonts and conversion settings; no ODL reparse.",
            "records": records,
        },
    )
    return int(any(record["status"] != "ok" for record in records))


if __name__ == "__main__":
    raise SystemExit(main())
