"""Diagnose EasyOCR recognition separately from OpenDataLoader's routing.

This is an OCR-stage diagnostic, not a standalone Docling benchmark. It renders
one frozen page at Docling's default 216 DPI and records both quantization modes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import easyocr
import numpy as np
import pypdfium2 as pdfium
import torch


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--page", type=int, required=True)
    parser.add_argument("--lang", required=True)
    parser.add_argument(
        "--quantize", action=argparse.BooleanOptionalAction, required=True
    )
    args = parser.parse_args()
    corpus = json.loads((args.root / "corpus.json").read_text())["entries"]
    entry = next(entry for entry in corpus if entry["id"] == args.id)
    output = args.root / "probes"
    output.mkdir(exist_ok=True)
    torch.set_num_threads(2)
    document = pdfium.PdfDocument(args.root / entry["pdf"])
    page = document[args.page]
    bitmap = page.render(scale=3)
    pixels = np.array(bitmap.to_pil().convert("RGB"))
    bitmap.close()
    page.close()
    document.close()
    start = time.monotonic()
    reader = easyocr.Reader(
        args.lang.split(","),
        gpu=False,
        model_storage_directory=str(args.root / "models/docling/EasyOcr"),
        download_enabled=False,
        quantize=args.quantize,
    )
    ready = time.monotonic()
    results = reader.readtext(pixels)
    record = {
        "args": vars(args) | {"root": str(args.root)},
        "input_sha256": entry["pdf_sha256"],
        "dpi": 216,
        "torch": torch.__version__,
        "easyocr": easyocr.__version__,
        "load_s": ready - start,
        "read_s": time.monotonic() - ready,
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "lines": [{"text": line[1], "confidence": float(line[2])} for line in results],
        "text_at_threshold": {
            str(threshold): " ".join(
                line[1] for line in results if line[2] >= threshold
            )
            for threshold in [0, 0.1, 0.5]
        },
    }
    target = (
        output / f"easyocr-{args.id}-p{args.page}-quantize-{args.quantize}-scores.json"
    )
    target.write_text(json.dumps(record, ensure_ascii=False, indent=2))
    print(
        target,
        {key: len(value) for key, value in record["text_at_threshold"].items()},
        record["read_s"],
        flush=True,
    )


if __name__ == "__main__":
    main()
