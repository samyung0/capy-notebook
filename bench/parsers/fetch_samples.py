"""Pull a couple of public PDFs so the harness is runnable before you have data.

These are a smoke test, not a representative sample. They are clean, born-digital
academic PDFs — the case every parser handles well — so treat their numbers as
the optimistic ceiling.

The documents that will actually decide this are the ones you have to supply:

    * a lecture slide deck exported to PDF, and the same deck as .pptx
    * a scanned or photographed page of handwritten notes
    * a textbook chapter with dense tables
    * something not in English, if you plan to support that

Drop them in ``bench/parsers/docs/`` alongside these. The scanned one matters
most: it is the case where CPU-only parsing falls off a cliff, and it is the
reason the tiered router exists.

Run: ``python fetch_samples.py [--dest docs]``
"""

from __future__ import annotations

import argparse
import urllib.request
from pathlib import Path

# (filename, url, why it is here)
SAMPLES = [
    (
        "attention-is-all-you-need.pdf",
        "https://arxiv.org/pdf/1706.03762",
        "equations, small tables, figures — born-digital baseline",
    ),
    (
        "resnet.pdf",
        "https://arxiv.org/pdf/1512.03385",
        "dense numeric tables — stresses table structure recognition",
    ),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", default="docs")
    args = parser.parse_args()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    for name, url, why in SAMPLES:
        target = dest / name
        if target.exists():
            print(f"skip {name} (already present)")
            continue
        print(f"fetch {name}  <- {url}\n      {why}")
        request = urllib.request.Request(
            url, headers={"User-Agent": "evo-notes-parse-bench"}
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            target.write_bytes(response.read())
        print(f"      {target.stat().st_size / 1e6:.1f} MB")

    print(
        f"\n{len(list(dest.glob('*')))} file(s) in {dest}. "
        "Add real slides and a scan before trusting any of this."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
