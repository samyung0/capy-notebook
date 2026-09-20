"""Download explicit public benchmark sources and retain identity/failure receipts.

No library ingestion. PDFs stay in an ignored local directory. The manifest
records licensing as supplied; it grants no redistribution rights.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import pymupdf
import requests

ROOT = Path(__file__).resolve().parents[3]


def write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", "utf-8")


def inventory(path: Path) -> dict:
    # Open bytes so PDF page objects cannot keep a Windows file handle alive
    # when the verified temporary download is renamed.
    data = path.read_bytes()
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        sample = sorted(
            {0, len(doc) // 4, len(doc) // 2, 3 * len(doc) // 4, len(doc) - 1}
        )
        return {
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": path.stat().st_size,
            "pages": len(doc),
            "producer": doc.metadata.get("producer", ""),
            "creator": doc.metadata.get("creator", ""),
            "outline_entries": len(doc.get_toc()),
            "tagged": doc.xref_get_key(doc.pdf_catalog(), "StructTreeRoot")[0]
            == "xref",
            "sample_native_chars": {
                str(p + 1): len(doc[p].get_text().strip()) for p in sample
            },
            "rotated_pages": [p.number + 1 for p in doc if p.rotation],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=Path, required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-mb", type=int, required=True)
    args = parser.parse_args()
    seeds = json.loads(args.seeds.read_text("utf-8"))["sources"]
    args.directory.mkdir(parents=True, exist_ok=True)
    receipt = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "sources": [],
        "failures": [],
    }
    for seed in seeds:
        if not re.fullmatch(r"[a-z0-9-]+", seed["id"]):
            raise ValueError("unsafe source id")
        target = args.directory / f"{seed['id']}.pdf"
        part = target.with_suffix(".pdf.part")
        started = time.perf_counter()
        try:
            if target.exists():
                raise FileExistsError(
                    f"Use the retained receipt for existing source {target}"
                )
            with requests.get(seed["url"], timeout=(15, 60), stream=True) as response:
                response.raise_for_status()
                if (
                    int(response.headers.get("content-length", 0))
                    > args.max_mb * 1024**2
                ):
                    raise ValueError("declared file exceeds size bound")
                total = 0
                with part.open("wb") as handle:
                    for chunk in response.iter_content(1024 * 1024):
                        total += len(chunk)
                        if total > args.max_mb * 1024**2:
                            raise ValueError("stream exceeds size bound")
                        handle.write(chunk)
                facts = inventory(part)
                if seed.get("sha256") and facts["sha256"] != seed["sha256"]:
                    raise ValueError("download differs from frozen source SHA-256")
                final_url = response.url
            part.rename(target)
            row = {
                **seed,
                **facts,
                "path": target.resolve().relative_to(ROOT).as_posix(),
                "resolved_url": final_url,
                "download_seconds": round(time.perf_counter() - started, 3),
            }
            receipt["sources"].append(row)
            print(
                f"{seed['id']}: {facts['pages']} pages; {facts['producer']}", flush=True
            )
        except (OSError, ValueError, RuntimeError, requests.RequestException) as exc:
            receipt["failures"].append(
                {**seed, "error": f"{type(exc).__name__}: {exc}"}
            )
            print(f"{seed['id']}: {type(exc).__name__}: {exc}", flush=True)
        write(args.output, receipt)
        time.sleep(0.5)


if __name__ == "__main__":
    main()
