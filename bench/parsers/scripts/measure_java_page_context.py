"""Time Java/OCR plus page rendering and captions with a frozen page-selection plan.

The plan is source-hash bound and was made from the same corpus's earlier Java
output. This measures execution latency, not unseen-document routing quality.
Run inside the isolated benchmark container; no application services are used.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from bench_java_recovery import captions, deduplicate_images
from compare_opendataloader import Sampler, save


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("root", type=Path)
    parser.add_argument("--trial", required=True)
    parser.add_argument("--suite", choices=["screen", "full", "long"], required=True)
    parser.add_argument("--page-plan", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--max-edge", type=int, required=True)
    parser.add_argument("--provider-config", type=Path, required=True)
    parser.add_argument("--key-env", type=Path, required=True)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, required=True)
    parser.add_argument("--request-limit", type=int, required=True)
    args = parser.parse_args()
    planned = json.loads(args.page_plan.read_text())["jobs"]
    if not planned or len(planned) > args.request_limit:
        raise ValueError("page plan is empty or exceeds the request limit")
    trial = args.root / args.trial
    trial.mkdir(parents=True, exist_ok=False)
    save(
        trial / "plan.json",
        {
            "jobs": planned,
            "selection": "frozen source-bound page plan; routing generalization is not measured",
            "page_plan_sha256": hashlib.sha256(args.page_plan.read_bytes()).hexdigest(),
            "started_unix": time.time(),
        },
    )
    native_trial = args.trial + "-native"
    sampler = Sampler(trial / "resources.csv")
    sampler.thread.start()
    started = time.monotonic()
    phases = {}
    try:
        command = [
            sys.executable,
            str(Path(__file__).with_name("measure_selective_java.py")),
            str(args.baseline),
            str(args.root),
            "--trial",
            native_trial,
            "--suite",
            args.suite,
            "--threads",
            str(args.threads),
            "--max-edge",
            str(args.max_edge),
            "--models",
            str(args.models),
        ]
        with (trial / "native-ocr.log").open("w") as log:
            subprocess.run(
                command, stdout=log, stderr=subprocess.STDOUT, timeout=1800, check=True
            )
        phases["native_ocr_dedup_seconds"] = time.monotonic() - started
        native = json.loads((args.root / native_trial / "complete.json").read_text())
        entries = {
            e["id"]: e
            for e in json.loads((args.baseline / "corpus.json").read_text())["entries"]
            if e["suite"] == args.suite
        }
        phase_started = time.monotonic()
        images = trial / "pages"
        images.mkdir()
        jobs = []
        import pymupdf

        for case in sorted({j["case"] for j in planned}):
            entry = entries[case]
            pdf = args.baseline / entry["pdf"]
            if hashlib.sha256(pdf.read_bytes()).hexdigest() != entry["pdf_sha256"]:
                raise ValueError("page plan PDF hash mismatch")
            with pymupdf.open(pdf) as document:
                for job in [j for j in planned if j["case"] == case]:
                    if job["pdf_sha256"] != entry["pdf_sha256"]:
                        raise ValueError("page plan belongs to another source PDF")
                    page = document[job["page"]]
                    scale = args.max_edge / max(page.rect.width, page.rect.height)
                    path = images / (job["id"] + ".png")
                    page.get_pixmap(
                        matrix=pymupdf.Matrix(scale, scale), alpha=False
                    ).save(path)
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    # The plan freezes PDF pages; Mac/Linux raster bytes may differ.
                    # Bind requests to this fresh render, retaining both hashes.
                    jobs.append(
                        {
                            **job,
                            "image": str(path),
                            "planned_image_sha256": job["image_sha256"],
                            "image_sha256": digest,
                        }
                    )
        save(trial / "jobs.json", {"jobs": jobs})
        phases["render_seconds"] = time.monotonic() - phase_started
        phase_started = time.monotonic()
        asyncio.run(
            captions(
                argparse.Namespace(
                    jobs=trial / "jobs.json",
                    output=trial / "captions",
                    kinds=["page"],
                    ids=None,
                    key_env=args.key_env,
                    provider_config=args.provider_config,
                    prompt_file=args.prompt_file,
                    max_edge=args.max_edge,
                    concurrency=args.concurrency,
                    request_limit=args.request_limit,
                )
            )
        )
        phases["caption_seconds"] = time.monotonic() - phase_started
        phase_started = time.monotonic()
        applied, failed = 0, 0
        output_run = args.suite + "-page-context-" + args.trial
        for case in entries:
            source = args.root / "results" / native["output_run"] / case
            blocks = json.loads((source / "content_list.json").read_text())
            for job in [j for j in jobs if j["case"] == case]:
                response = json.loads(
                    (trial / "captions" / (job["id"] + ".json")).read_text()
                )
                if response["job"] != job["id"] or any(
                    response[key] != job[key] for key in ["image_sha256", "pdf_sha256"]
                ):
                    raise ValueError("caption response belongs to another input")
                if response["state"] != "ok":
                    failed += 1
                    continue
                if response["text"] == "DECORATIVE":
                    continue
                blocks.append(
                    {
                        "type": "image",
                        "page_idx": job["page"],
                        "bbox": job["bbox"],
                        "img_path": job["image"],
                        "description": response["text"],
                        "_recovery": "caption-page",
                    }
                )
                applied += 1
            blocks.sort(key=lambda b: b["page_idx"])
            destination = args.root / "results" / output_run / case
            dedup = deduplicate_images(blocks, source, destination)
            save(destination / "content_list.json", blocks)
            saved = json.loads((source / "result.json").read_text())
            save(
                destination / "result.json",
                {**saved, "config": "java-page-context", "deduplication": dedup},
            )
        phases["attach_and_deduplicate_seconds"] = time.monotonic() - phase_started
    except Exception as exc:
        saved_responses = sum(
            (trial / "captions" / (job["id"] + ".json")).is_file() for job in planned
        )
        save(
            trial / "failure.json",
            {
                "state": "error",
                "error_type": type(exc).__name__,
                "seconds": time.monotonic() - started,
                "completed_phases": phases,
                "planned": len(planned),
                "saved_response_files": saved_responses,
                "note": "No successful completion receipt. Partial native artifacts and request receipts remain preserved.",
            },
        )
        raise
    finally:
        sampler.stop.set()
        sampler.thread.join()
    save(
        trial / "complete.json",
        {
            "seconds": time.monotonic() - started,
            "phases": phases,
            "native_trial": native_trial,
            "output_run": output_run,
            "planned": len(planned),
            "applied": applied,
            "failed": failed,
            "peak_memory_bytes": sampler.peak_memory,
            "peak_swap_bytes": sampler.peak_swap,
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "pymupdf_version": pymupdf.__version__,
            "note": "Frozen page-plan execution. Includes fresh source inspection, OCR, render, remote captions and artifact adaptation. Excludes chunking, indexing and generalization of routing.",
        },
    )
    print(json.dumps(json.loads((trial / "complete.json").read_text())), flush=True)


if __name__ == "__main__":
    main()
