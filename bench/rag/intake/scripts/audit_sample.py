"""Freeze the 3% page sample for the parser fidelity audit.

Pages are drawn per book from the body (first_content_page onward) with a seed
derived from the protocol seed and the book id, so the sample is fixed before
any parse and the same pages are judged for every text under comparison.

    uv run --project pipeline python bench/rag/intake/scripts/audit_sample.py
"""

from __future__ import annotations

import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PROTOCOL = ROOT / "bench/rag/intake/fixtures/protocol.json"
MANIFEST = ROOT / "lab/knowledge/books.json"
OUT = ROOT / "bench/rag/intake/fixtures/audit-pages.json"


def main() -> None:
    protocol = json.loads(PROTOCOL.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    books = manifest if isinstance(manifest, list) else manifest["books"]
    by_id = {b["id"]: b for b in books}
    share = protocol["audit"]["pages_share"]
    seed = protocol["audit"]["seed"]
    sample = {}
    for book_id, entry in protocol["books"].items():
        book = by_id[book_id]
        first = int(book.get("first_content_page") or 1)
        pages = int(entry["pages"])
        count = max(1, round(pages * share))
        rng = random.Random(f"{seed}:{book_id}")
        sample[book_id] = {
            "sha256": entry["sha256"],
            "pages": pages,
            "first_content_page": first,
            "sampled": sorted(rng.sample(range(first, pages + 1), count)),
        }
    doc = {"schema": 1, "share": share, "seed": seed, "pages_are_1_based_pdf_pages": True, "books": sample}
    OUT.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")
    total = sum(len(v["sampled"]) for v in sample.values())
    print(json.dumps({k: len(v["sampled"]) for k, v in sample.items()}), "total", total)


if __name__ == "__main__":
    main()
