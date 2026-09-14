"""Capture real Office conversion and ODL output for native-citation experiments.

Run inside an isolated parser image. No HTTP, queue, database, or blob writes.
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


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def pdf_geometry(data: bytes) -> list[dict]:
    import pymupdf

    pages = []
    with pymupdf.open(stream=data, filetype="pdf") as document:
        for page in document:
            lines = []
            for block in page.get_text("rawdict")["blocks"]:
                for line in block.get("lines", []):
                    chars = [
                        {"text": char["c"], "bbox": list(char["bbox"])}
                        for span in line["spans"]
                        for char in span["chars"]
                    ]
                    lines.append(
                        {
                            "text": "".join(char["text"] for char in chars),
                            "bbox": list(line["bbox"]),
                            "direction": list(line["dir"]),
                            "chars": chars,
                        }
                    )
            pages.append(
                {
                    "page": page.number + 1,
                    "width": page.rect.width,
                    "height": page.rect.height,
                    "rotation": page.rotation,
                    "lines": lines,
                }
            )
    return pages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--parser-root", type=Path, required=True)
    parser.add_argument("--timeout", type=float, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.parser_root))
    from odl.document import normalize_document
    from odl.refine import parse_pdf

    args.output.mkdir(parents=True, exist_ok=False)
    records = []
    for source in args.input:
        identity = f"{source.stem}-{source.suffix[1:]}"
        target = args.output / identity
        target.mkdir()
        started = time.monotonic()
        data = source.read_bytes()
        record = {
            "id": identity,
            "source": str(source),
            "sha256": hashlib.sha256(data).hexdigest(),
            "format": source.suffix[1:],
        }
        try:
            normalized = normalize_document(data, source.name)
            (target / "preview.pdf").write_bytes(normalized.data)
            write_json(target / "pdf-geometry.json", pdf_geometry(normalized.data))
            work = target / "parser-work"
            work.mkdir()
            parsed = parse_pdf(normalized.data, work, java_timeout_s=args.timeout)
            write_json(target / "content-list.json", parsed.content_list)
            write_json(target / "furniture.json", parsed.furniture)
            (target / "document.md").write_text(parsed.markdown)
            if parsed.parsed_pdf:
                (target / "parsed.pdf").write_bytes(parsed.parsed_pdf)
            record.update(
                status="ok",
                pages=parsed.page_count,
                ocr_pages=parsed.ocr_pages,
                repaired_fonts=parsed.repaired_fonts,
                blocks=len(parsed.content_list),
                phases=parsed.phases,
            )
        except Exception as error:  # noqa: BLE001 - preserve each independent failure
            record.update(status="error", error=str(error))
            (target / "error.txt").write_text(traceback.format_exc())
        record["seconds"] = time.monotonic() - started
        write_json(target / "record.json", record)
        records.append(record)
        print(json.dumps(record, ensure_ascii=False), flush=True)
    libreoffice = subprocess.run(
        ["/usr/bin/soffice", "--version"], capture_output=True, text=True, check=True
    ).stdout.strip()
    write_json(
        args.output / "run.json",
        {
            "python": platform.python_version(),
            "libreoffice": libreoffice,
            "odl": importlib.metadata.version("opendataloader-pdf"),
            "pymupdf": importlib.metadata.version("PyMuPDF"),
            "records": records,
        },
    )
    return int(any(record["status"] != "ok" for record in records))


if __name__ == "__main__":
    raise SystemExit(main())
