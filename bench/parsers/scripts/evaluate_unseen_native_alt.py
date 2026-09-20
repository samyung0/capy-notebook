"""Apply the frozen native-Alt prototype to completed unseen heading parses.

No tuning, parsing, production edits, or page-presence accuracy claims. A retained
receipt binds every result to the exact source, parser output, and prototype.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import experiment_prince_native_alt as prototype
import pymupdf

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
from pipeline.retrieval.confidence import ocr_pages, score_chunks
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks


def read(path: Path):
    return json.loads(path.read_text("utf-8"))


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", "utf-8")


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def subsequence(before: str, after: str) -> bool:
    cursor = iter(after)
    return all(any(char == match for match in cursor) for char in before)


def evaluate(source: dict, attempt: Path, output: Path) -> dict:
    candidate = attempt / "candidate"
    pdf = candidate / "parsed.pdf"
    if not pdf.exists():
        pdf = ROOT / source["path"]
    inputs = {
        "source_sha256": source["sha256"],
        "measured_pdf_sha256": sha(pdf),
        "blocks_sha256": sha(candidate / "content_list.json"),
        "refinement_sha256": sha(candidate / "refinement.json"),
        "prototype_sha256": sha(Path(prototype.__file__)),
        "evaluator_sha256": sha(Path(__file__)),
        "pymupdf_version": pymupdf.VersionBind,
        "pipeline_sha256": {
            str(p.relative_to(ROOT)): sha(p)
            for p in sorted((ROOT / "pipeline/pipeline/retrieval").glob("*.py"))
        },
    }
    parse_receipt = read(candidate / "parse.json")
    for key in ["source_sha256", "measured_pdf_sha256"]:
        if inputs[key] != parse_receipt[key]:
            raise ValueError(f"Parse receipt mismatch: {source['id']} {key}")
    if inputs["blocks_sha256"] != parse_receipt["content_list_sha256"]:
        raise ValueError(f"Parser blocks changed: {source['id']}")
    if inputs["refinement_sha256"] != parse_receipt["refinement_sha256"]:
        raise ValueError(f"Parser refinement changed: {source['id']}")
    if sha(ROOT / source["path"]) != source["sha256"]:
        raise ValueError(f"Source PDF changed: {source['id']}")
    receipt = output / "summary.json"
    if receipt.exists():
        previous = read(receipt)
        if previous["inputs"] != inputs:
            raise ValueError(
                f"Inputs changed for {source['id']}; use a new output directory"
            )
        return previous
    started = time.perf_counter()
    blocks = read(candidate / "content_list.json")
    with pymupdf.open(pdf) as doc:
        tags = prototype.alternatives(doc)
        inventory_seconds = time.perf_counter() - started
        recovered, decisions = prototype.recover(doc, blocks, tags)
    recovery_seconds = time.perf_counter() - started - inventory_seconds
    assert len(blocks) == len(recovered)
    changes = []
    for index, (before, after) in enumerate(zip(blocks, recovered)):
        if before == after:
            continue
        original, updated = prototype.fields(before), prototype.fields(after)
        assert len(original) == len(updated)
        assert all(subsequence(a, b) for a, b in zip(original, updated))
        # Only text and provenance may change, including list item count/order.
        allowed = {"text", "list_items", "_benchmark_alt_xrefs"}
        assert {k: v for k, v in before.items() if k not in allowed} == {
            k: v for k, v in after.items() if k not in allowed
        }
        changes.append({"index": index, "before": before, "after": after})
    furniture = frozenset(read(candidate / "refinement.json")["furniture"])
    chunks = retain_headings(recovered, pdf, pack_blocks(recovered, furniture))
    score_chunks(chunks, pdf, ocr=ocr_pages(recovered))
    result = {
        "id": source["id"],
        "inputs": inputs,
        "pages": source["pages"],
        "producer": source.get("producer"),
        "tags": len(tags),
        "statuses": dict(Counter(d["status"] for d in decisions)),
        "modified_blocks": len(changes),
        "modified_pages": len({c["before"]["page_idx"] for c in changes}),
        "original_character_subsequence_preserved": True,
        "original_metadata_and_list_item_count_preserved": True,
        "chunks": len(chunks),
        "inventory_seconds": round(inventory_seconds, 3),
        "recovery_seconds": round(recovery_seconds, 3),
        "total_seconds": round(time.perf_counter() - started, 3),
        "scope": "Native Alt applied after experimental heading parse; no source-ground-truth accuracy inferred from these counts.",
    }
    write(output / "decisions.json", decisions)
    write(output / "changes.json", changes)
    write(output / "content_list.json", recovered)
    write(output / "chunks.json", [asdict(c) for c in chunks])
    write(receipt, result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--parses", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--only", nargs="+")
    args = parser.parse_args()
    results, pending = [], []
    for source in read(args.manifest)["sources"]:
        if args.only and source["id"] not in args.only:
            continue
        status_path = args.parses / source["id"] / "status.json"
        status = (
            read(status_path) if status_path.exists() else {"status": "not_started"}
        )
        if status["status"] != "complete":
            pending.append({"id": source["id"], "status": status["status"]})
            continue
        result = evaluate(
            source,
            args.parses / status["attempt_directory"],
            args.output / source["id"],
        )
        results.append(result)
        print(source["id"], result["statuses"], flush=True)
    implementations = {
        json.dumps(
            {
                k: row["inputs"][k]
                for k in [
                    "prototype_sha256",
                    "evaluator_sha256",
                    "pipeline_sha256",
                    "pymupdf_version",
                ]
            },
            sort_keys=True,
        )
        for row in results
    }
    if len(implementations) > 1:
        raise ValueError("Mixed implementations cannot form one aggregate")
    write(args.output / "summary.json", {"documents": results, "unmeasured": pending})


if __name__ == "__main__":
    main()
