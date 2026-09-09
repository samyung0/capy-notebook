"""Evaluate exact-image cached pages on fresh Java/OCR/encoding outputs.

This is an offline quality replay. Original request and response files remain
unchanged; every accepted source/target pair is retained in the output receipt.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from functools import cache
from pathlib import Path

from bench_java_recovery import deduplicate_images, saved_response
from compare_opendataloader import save
from evaluate_opendataloader import REPO, evaluate
from structured_recovery import (
    chunk_structured,
    drop_exact_recovered_text,
    structured_response,
)


@cache
def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("native", type=Path)
    parser.add_argument("jobs", type=Path)
    parser.add_argument("prior_cache", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--checks", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    corpus = {
        row["id"]: row
        for row in json.loads((args.root / "corpus.json").read_text())["entries"]
    }
    selected = json.loads(args.jobs.read_text())["jobs"]
    targets = {(job["case"], job["page"]): job for job in selected}
    if len(targets) != len(selected):
        raise ValueError("duplicate selected page")
    for job in selected:
        image = args.jobs.parent / Path(job["image"]).name
        if (
            digest(image) != job["image_sha256"]
            or digest(args.root / corpus[job["case"]]["pdf"]) != job["pdf_sha256"]
        ):
            raise ValueError("fresh page source hash mismatch")
        job["image"] = str(image.resolve())
    prior = json.loads(args.prior_cache.read_text())
    accepted, rejected, seen = [], [], set()
    recovered = {}
    for record in prior["records"]:
        old_target, source = record["target_job"], record["source_job"]
        key = old_target["case"], old_target["page"]
        if key in seen:
            raise ValueError("duplicate cached target")
        seen.add(key)
        target = targets.get(key)
        if target is None or any(
            target[field] != old_target[field]
            for field in ("pdf_sha256", "image_sha256")
        ):
            rejected.append({"target": old_target, "reason": "fresh_input_differs"})
            continue
        response = Path(record["response_path"])
        if (
            source["image_sha256"] != target["image_sha256"]
            or digest(Path(source["image"])) != source["image_sha256"]
            or digest(args.root / corpus[source["case"]]["pdf"]) != source["pdf_sha256"]
            or digest(response) != record["response_sha256"]
            or digest(response.parent / "run.json") != record["run_sha256"]
        ):
            raise ValueError("cached source or response binding changed")
        receipt = saved_response(
            response.parent,
            source,
            {
                "run_sha256": record["run_sha256"],
                "responses": {source["id"]: record["response_sha256"]},
            },
        )
        if receipt["state"] != "ok":
            raise ValueError("cached response did not succeed")
        recovered.setdefault(target["case"], []).extend(
            structured_response(receipt["text"], target)
        )
        accepted.append({**record, "target_job": target})
    specification = json.loads(args.checks.read_text())
    checks = specification["checks"].copy()
    for mapping in specification.get("page_mappings", []):
        checks.extend(
            {
                **check,
                "source": mapping["source"],
                "page": mapping["pages"][check["page"]],
            }
            for check in specification["checks"]
            if check["source"] == mapping["checks_from"]
        )
    records = []
    native_sources = {}
    native_cases = {path.parent.name for path in args.native.glob("*/result.json")}
    if {job["case"] for job in selected} - native_cases:
        raise ValueError("selected pages lack native outputs")
    for case in sorted(native_cases):
        source = args.native / case
        result = json.loads((source / "result.json").read_text())
        entry = corpus[case]
        if result["state"] != "ok" or result["input_sha256"] != entry["pdf_sha256"]:
            raise ValueError("native output is incomplete or belongs to another PDF")
        native_sources[case] = digest(source / "content_list.json")
        blocks = json.loads((source / "content_list.json").read_text())
        blocks.extend(recovered.get(case, []))
        duplicates = drop_exact_recovered_text(blocks)
        blocks.sort(key=lambda block: block["page_idx"])
        destination = args.output / case
        destination.mkdir()
        deduplicate_images(blocks, source, destination)
        save(destination / "content_list.json", blocks)
        save(
            destination / "result.json",
            result
            | {
                "config": "offline-cache-replay",
                "wall_s": None,
                "peak_memory_bytes": None,
                "timing_note": "offline exact-image cache replay; no provider calls",
            },
        )
        reference = json.loads(
            (args.root / "prepared" / f"{case}.reference.json").read_text()
        )
        records.append(
            {
                **evaluate(
                    destination, entry, reference, checks, chunker=chunk_structured
                ),
                "case": case,
                "exact_recovered_duplicates": duplicates,
            }
        )
    save(
        args.output / "cache-reuse.json",
        {
            "selected_pages": len(selected),
            "reused_pages": len(accepted),
            "unavailable_pages": len(selected) - len(accepted),
            "rule": prior["rule"],
            "records": accepted,
            "rejected_old_matches": rejected,
            "source_hashes": {
                str(path): digest(path)
                for path in (
                    Path(__file__),
                    Path(__file__).with_name("structured_recovery.py"),
                    Path(__file__).with_name("evaluate_opendataloader.py"),
                    REPO / "pipeline/pipeline/retrieval/chunking.py",
                    args.jobs,
                    args.prior_cache,
                    args.checks,
                )
            },
            "native_content_hashes": native_sources,
        },
    )
    save(args.output / "evaluation.json", {"records": records})
    probes = [probe for record in records for probe in record["probes"]]
    print(
        json.dumps(
            {
                "cases": len(records),
                "reused_pages": len(accepted),
                "unavailable_pages": len(selected) - len(accepted),
                "probes": len(probes),
                "raw_pass": sum(probe["raw_pass"] for probe in probes),
                "chunk_pass": sum(probe["chunk_pass"] for probe in probes),
            }
        )
    )


if __name__ == "__main__":
    main()
