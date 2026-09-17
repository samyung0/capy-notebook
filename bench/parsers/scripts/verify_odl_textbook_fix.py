"""Parse full textbooks through a local HTTP parser, then production packing.

No embeddings, database writes or model calls. Uses the pilot's existing parse
stage and accepts its book manifest or the frozen selective-recovery sources.
Run with --help; use a new output directory for each parser/code revision.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "bench/rag/scripts"))

from knowledge_base_pilot import configure, parse_books


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--book")
    parser.add_argument("--pipeline-root", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if "sources" in manifest:
        if not manifest["frozen_before_candidate_output"]:
            raise ValueError("Freeze source checks before parsing")
        manifest = {
            "books": [
                {
                    **source,
                    "pdf_path": source["path"],
                    "source_url": source["url"],
                    "edition": source["sha256"],
                }
                for source in manifest["sources"]
            ]
        }
    config = json.loads(args.config.read_text(encoding="utf-8"))
    configure(config)
    if args.pipeline_root:
        # A git-archived baseline uses its own parser identity and packing code.
        sys.path.insert(0, str(args.pipeline_root.resolve()))
    parse_books(manifest, config, args.run, args.book)


if __name__ == "__main__":
    main()
