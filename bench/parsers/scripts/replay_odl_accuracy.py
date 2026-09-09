"""Compose saved font, reading-order, cell-color and bounded-table experiments.

This replay measures neither parsing nor combined ingest latency. Each input is
an explicit completed experiment directory; it does not choose recovery routes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict
from pathlib import Path

from experiment_odl_native_tables import chunk_native_bounded
from structured_recovery import chunk_content_list


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--order", type=Path, required=True)
    parser.add_argument("--font", type=Path, required=True)
    parser.add_argument("--styles", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    records = []
    order_inputs = {
        case["case"]: case["input_sha256"]
        for case in read(args.order / "summary.json")["cases"]
    }
    for folder in sorted(args.baseline.iterdir()):
        if not folder.is_dir():
            continue
        baseline_path = folder / "content_list.json"
        baseline = read(baseline_path)
        if order_inputs.get(folder.name) != sha(baseline_path):
            raise ValueError(f"reading-order baseline mismatch: {folder.name}")
        chosen = args.order / folder.name / "content_list.json"
        ordered = read(chosen)
        if folder.name == "ccl-feedback":
            if read(args.font / "baseline/content_list.json") != baseline:
                raise ValueError("font baseline mismatch")
            if ordered != baseline:
                raise ValueError(
                    "font and order transformations overlap; explicit composition needed"
                )
            chosen = args.font / "rebuild-cmap/content_list.json"
        elif folder.name == "taln-complexity":
            if read(args.styles / "baseline-content.json") != baseline:
                raise ValueError("style baseline mismatch")
            if ordered != baseline:
                raise ValueError(
                    "style and order transformations overlap; explicit composition needed"
                )
            chosen = args.styles / "candidate-content.json"
        candidate = read(chosen)
        prepared, chunks, table_receipts = chunk_native_bounded(candidate)
        before = chunk_content_list(baseline)
        case_output = args.output / folder.name
        save(case_output / "content_list.json", prepared)
        save(case_output / "table-context.json", table_receipts)
        save(
            case_output / "chunks-before.json",
            [
                {**asdict(chunk), "indexed_text": chunk.indexed_text()}
                for chunk in before
            ],
        )
        save(
            case_output / "chunks-after.json",
            [
                {**asdict(chunk), "indexed_text": chunk.indexed_text()}
                for chunk in chunks
            ],
        )
        records.append(
            {
                "case": folder.name,
                "baseline_path": str(baseline_path.resolve()),
                "baseline_sha256": sha(baseline_path),
                "selected_path": str(chosen.resolve()),
                "selected_sha256": sha(chosen),
                "native_result_sha256": sha(folder / "result.json"),
                "chunks_before": len(before),
                "chunks_after": len(chunks),
                "output_sha256": sha(case_output / "chunks-after.json"),
            }
        )
    if set(order_inputs) != {row["case"] for row in records}:
        raise ValueError("case set mismatch")
    repository = Path(__file__).resolve().parents[3]
    sources = [
        Path(__file__),
        Path(__file__).with_name("experiment_odl_native_tables.py"),
        Path(__file__).with_name("structured_recovery.py"),
        repository / "pipeline/pipeline/retrieval/chunking.py",
        repository / "pipeline/pipeline/config.py",
        repository / "pipeline/pipeline/retrieval/lang.py",
    ]
    save(
        args.output / "manifest.json",
        {
            "purpose": "offline composition of explicit completed experiments; no timing or routing claim",
            "cases": records,
            "sources": {
                str(path.relative_to(repository)): sha(path) for path in sources
            },
            "order_summary_sha256": sha(args.order / "summary.json"),
        },
    )
    print(
        json.dumps(
            {
                "cases": len(records),
                "chunks_before": sum(row["chunks_before"] for row in records),
                "chunks_after": sum(row["chunks_after"] for row in records),
            }
        )
    )


if __name__ == "__main__":
    main()
