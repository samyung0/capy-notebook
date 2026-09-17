"""Pack saved comparison outputs with the current retrieval code for source review.

This is a compatibility diagnostic, not a production MinerU adapter. MinerU's
content list has already discarded furniture; it supplies no ODL frozen keys.
Confidence is the existing text-layer heuristic, not an accuracy verdict.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from dataclasses import asdict
from pathlib import Path

from compare_mineru_pipeline_local import ROOT, read, save, sha


def review(output: Path, name: str) -> None:
    sys.path.insert(0, str(ROOT / "pipeline"))
    from pipeline.retrieval.chunking import CHUNKER_VERSION
    from pipeline.retrieval.confidence import ocr_pages, score_chunks
    from pipeline.retrieval.headings import retain_headings
    from pipeline.retrieval.packing import pack_blocks

    run = output / "runs" / name
    manifest = read(output / "manifest.json")
    cases = {c["id"]: c for c in manifest["cases"]}
    destination = run / "review"
    destination.mkdir(exist_ok=False)
    summary = []
    for result in read(run / "results.json"):
        case = cases[result["case"]]
        directory = run / f"r{result['repeat']}" / case["id"]
        blocks = read(directory / "content_list.json")
        refinement = directory / "refinement.json"
        furniture = read(refinement)["furniture"] if refinement.exists() else []
        source = output / case["pdf"]
        if sha(source) != case["pdf_sha256"]:
            raise ValueError("Frozen source changed")
        page_pdf = directory / "parsed.pdf"
        if not page_pdf.exists():
            page_pdf = source
        chunks = retain_headings(
            blocks, page_pdf, pack_blocks(blocks, frozenset(furniture))
        )
        score_chunks(chunks, page_pdf, ocr=ocr_pages(blocks))
        target = destination / f"r{result['repeat']}" / case["id"]
        serialized = [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks]
        save(target / "chunks.json", serialized)
        lines = []
        for page_index, original_page in enumerate(case["pages"]):
            lines.append(f"# Source page {original_page} (slice page {page_index + 1})")
            lines.append("## Raw blocks")
            for index, block in enumerate(blocks):
                if block.get("page_idx") == page_index:
                    lines.append(
                        f"### Block {index}: {block['type']}, heading level {block.get('text_level', 0)}"
                    )
                    lines.append(json.dumps(block, ensure_ascii=False))
            lines.append("## Current packed chunks intersecting page")
            for index, chunk in enumerate(serialized):
                pages = {r["page"] for r in chunk["regions"]}
                if page_index + 1 in pages:
                    lines.append(f"### Chunk {index}: {chunk['section_path']}")
                    lines.append(
                        f"Confidence {chunk['confidence']}; {chunk['confidence_reasons']}"
                    )
                    lines.append(chunk["text"])
        (target / "source-review.md").write_text("\n\n".join(lines), encoding="utf-8")
        summary.append(
            {
                **result,
                "content_sha256": sha(directory / "content_list.json"),
                "block_types": dict(Counter(b["type"] for b in blocks)),
                "raw_headings": [b["text"] for b in blocks if b.get("text_level", 0)],
                "chunks": len(chunks),
                "high_confidence_without_reasons": sum(
                    c.confidence >= 0.9 and not c.confidence_reasons
                    for c in chunks
                    if c.confidence is not None
                ),
            }
        )
    save(
        destination / "summary.json",
        {
            "chunker_version": CHUNKER_VERSION,
            "manifest_sha256": sha(output / "manifest.json"),
            "script_sha256": sha(Path(__file__)),
            "cases": summary,
        },
    )
    print(json.dumps({"reviewed_case_runs": len(summary), "output": str(destination)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    review(args.output, args.name)
