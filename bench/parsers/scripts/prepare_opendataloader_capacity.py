"""Add retained August 31 capacity fixtures to the frozen parser experiment."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from prepare_opendataloader_corpus import digest, page_reference


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("sources", type=Path)
    args = parser.parse_args()
    manifest = args.root / "corpus.json"
    corpus = json.loads(manifest.read_text())
    if any(entry["suite"] == "capacity" for entry in corpus["entries"]):
        raise SystemExit("capacity fixtures already frozen")
    shutil.copy2(manifest, args.root / "corpus-before-capacity.json")
    for lane in ["digital", "ocr"]:
        source = args.sources / f"{lane}-1.pdf"
        identity = f"capacity__{lane}"
        target = args.root / "prepared" / f"{identity}.pdf"
        shutil.copy2(source, target)
        reference = page_reference(target)
        if len(reference) != 26:
            raise ValueError(f"expected a 26-page capacity fixture: {source}")
        target.with_suffix(".reference.json").write_text(json.dumps(reference))
        corpus["entries"].append(
            {
                "id": identity,
                "source": str(source),
                "source_sha256": digest(source),
                "pdf": str(target.relative_to(args.root)),
                "pdf_sha256": digest(target),
                "pages": len(reference),
                "source_pages": list(range(len(reference))),
                "lang": "en",
                "kind": "retained_capacity_fixture",
                "suite": "capacity",
            }
        )
    manifest.write_text(json.dumps(corpus, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
