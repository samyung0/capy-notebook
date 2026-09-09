"""Measure native Java, source inspection, selective OCR and physical deduplication.

Run inside the isolated benchmark container. Captions and application indexing
are separate measurements. This intentionally retains direct OCR's line order.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from bench_java_recovery import deduplicate_images, ocr, ocr_blocks
from compare_opendataloader import Sampler, save
from inspect_java_recovery import inventory


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("root", type=Path)
    parser.add_argument("--trial", required=True)
    parser.add_argument("--suite", choices=["screen", "full", "long"], required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--max-edge", type=int, required=True)
    parser.add_argument("--models", type=Path, required=True)
    args = parser.parse_args()
    trial = args.root / args.trial
    trial.mkdir(parents=True, exist_ok=False)
    native_config = "odl-java-headers-" + args.trial
    native_run = args.suite + "-" + native_config
    output_run = args.suite + "-selective-" + args.trial
    sampler = Sampler(trial / "resources.csv")
    sampler.thread.start()
    started = time.monotonic()
    phases = {}
    try:
        command = [
            sys.executable,
            str(Path(__file__).with_name("compare_opendataloader.py")),
            str(args.root),
            "--config",
            "odl-java-headers",
            "--suite",
            args.suite,
            "--run",
            native_run,
            "--java-threads",
            "1",
            "--no-warmup",
        ]
        with (trial / "native.log").open("w") as log:
            subprocess.run(
                command, stdout=log, stderr=subprocess.STDOUT, timeout=1800, check=True
            )
        phases["native_seconds"] = time.monotonic() - started
        phase_started = time.monotonic()
        inventory(
            args.baseline, trial / "inventory", [args.suite], args.root, native_config
        )
        phases["inspection_seconds"] = time.monotonic() - phase_started
        records = json.loads((trial / "inventory/inventory.json").read_text())[
            "records"
        ]
        jobs = []
        for record in records:
            source = args.root / "results" / native_run / record["id"]
            blocks = json.loads((source / "content_list.json").read_text())
            by_digest = {}
            for page in record["pages"]:
                if "scan" not in page["flags"]:
                    continue
                images = [
                    b
                    for b in blocks
                    if b["page_idx"] == page["page"] and b.get("img_path")
                ]
                if not images:
                    raise ValueError(
                        f"flagged scan has no emitted image: {record['id']} page {page['page']}"
                    )
                image = max(
                    images,
                    key=lambda b: (
                        (b["bbox"][2] - b["bbox"][0]) * (b["bbox"][3] - b["bbox"][1])
                    ),
                )
                path = source / image["img_path"]
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                job = by_digest.setdefault(
                    digest,
                    {
                        "id": f"java-{record['id']}-{len(by_digest)}",
                        "kind": "java",
                        "case": record["id"],
                        "image": str(path),
                        "image_sha256": digest,
                        "pdf_sha256": record["pdf_sha256"],
                        "occurrences": [],
                    },
                )
                job["occurrences"].append(
                    {
                        "page": page["page"],
                        "bbox": image["bbox"],
                        "img_path": image["img_path"],
                    }
                )
            jobs.extend(by_digest.values())
        save(trial / "jobs.json", {"jobs": jobs})
        phases["scan_job_preparation_seconds"] = (
            time.monotonic() - phase_started - phases["inspection_seconds"]
        )
        phase_started = time.monotonic()
        if jobs:
            ocr(
                argparse.Namespace(
                    jobs=trial / "jobs.json",
                    output=trial / "ocr",
                    kinds=["java"],
                    ids=None,
                    models=args.models,
                    max_edge=args.max_edge,
                    threads=args.threads,
                )
            )
        phases["ocr_seconds"] = time.monotonic() - phase_started
        phase_started = time.monotonic()
        for record in records:
            case = record["id"]
            source = args.root / "results" / native_run / case
            blocks = json.loads((source / "content_list.json").read_text())
            for job in [j for j in jobs if j["case"] == case]:
                result = json.loads((trial / "ocr" / f"{job['id']}.json").read_text())
                if result["state"] != "ok":
                    raise ValueError("selective OCR failed")
                for occurrence in job["occurrences"]:
                    target = next(
                        i
                        for i, b in enumerate(blocks)
                        if b.get("img_path") == occurrence["img_path"]
                    )
                    blocks[target + 1 : target + 1] = ocr_blocks(result, occurrence)
            destination = args.root / "results" / output_run / case
            dedup = deduplicate_images(blocks, source, destination)
            save(destination / "content_list.json", blocks)
            native = json.loads((source / "result.json").read_text())
            save(
                destination / "result.json",
                {
                    **native,
                    "config": "java-selective",
                    "deduplication": dedup,
                    "native_wall_s": native["wall_s"],
                    "native_peak_memory_bytes": native["peak_memory_bytes"],
                    "wall_s": None,
                    "peak_memory_bytes": None,
                    "timing_note": "use trial complete.json for whole-pipeline wall time",
                },
            )
        phases["adapt_and_deduplicate_seconds"] = time.monotonic() - phase_started
    finally:
        sampler.stop.set()
        sampler.thread.join()
    save(
        trial / "complete.json",
        {
            "seconds": time.monotonic() - started,
            "phases": phases,
            "native_run": native_run,
            "output_run": output_run,
            "ocr_jobs": len(jobs),
            "peak_memory_bytes": sampler.peak_memory,
            "peak_swap_bytes": sampler.peak_swap,
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
    )
    print(json.dumps(json.loads((trial / "complete.json").read_text())), flush=True)


if __name__ == "__main__":
    main()
