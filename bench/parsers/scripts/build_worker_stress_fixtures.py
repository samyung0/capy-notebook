"""Build deterministic 26-page digital/OCR mixtures for worker stress tests."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from pypdf import PdfReader, PdfWriter

LANES = {
    "digital": 26,
    "mixed": 13,
    "mostly-ocr": 2,
    "ocr": 0,
}


def _write_fixture(
    digital: PdfReader,
    ocr: PdfReader,
    output: Path,
    *,
    digital_pages: int,
    copy_number: int,
    tag: str,
) -> dict[str, int | str]:
    writer = PdfWriter()
    for page_number in range(26):
        source = digital if page_number < digital_pages else ocr
        writer.add_page(source.pages[page_number % len(source.pages)])
    writer.add_metadata(
        {
            "/CapyStressCopy": str(copy_number),
            "/CapyStressLane": output.stem.rsplit("-", 1)[0],
            "/CapyStressTag": tag,
        }
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("wb") as handle:
        writer.write(handle)
    payload = output.read_bytes()
    return {
        "bytes": len(payload),
        "digital_pages": digital_pages,
        "filename": output.name,
        "ocr_pages": 26 - digital_pages,
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--digital", type=Path, required=True)
    parser.add_argument("--ocr", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()

    digital = PdfReader(args.digital)
    ocr = PdfReader(args.ocr)
    if len(digital.pages) < 26 or len(ocr.pages) < 1:
        parser.error("digital input needs 26 pages and OCR input needs one page")

    manifest = []
    for lane, digital_pages in LANES.items():
        for copy_number in range(1, 5):
            manifest.append(
                _write_fixture(
                    digital,
                    ocr,
                    args.output_dir / f"{lane}-{copy_number}.pdf",
                    digital_pages=digital_pages,
                    copy_number=copy_number,
                    tag=args.tag,
                )
            )
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
