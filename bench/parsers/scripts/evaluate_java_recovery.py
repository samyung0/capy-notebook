"""Apply saved OCR/captions to native blocks and evaluate with the real chunker.

This never calls a provider. Each variant is an explicit list of saved runs;
failed requests remain absent and are counted, rather than replaced silently.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
from functools import partial
from pathlib import Path

from bench_java_recovery import deduplicate_images, ocr_blocks, saved_response
from compare_opendataloader import odl_content_list, save
from evaluate_opendataloader import evaluate


def apply_saved(
    blocks: list[dict],
    jobs: list[dict],
    directory: Path,
    mode: str,
    binding: dict | None = None,
) -> dict:
    counts = {
        "selected": len(jobs),
        "ok": 0,
        "failed_or_absent": 0,
        "decorative": 0,
        "applied": 0,
        "tables_replaced": 0,
        "invalid_structure": [],
    }
    for job in jobs:
        result = saved_response(directory, job, binding)
        if result.get("state") != "ok":
            counts["failed_or_absent"] += 1
            continue
        counts["ok"] += 1
        if mode != "ocr" and result["text"] == "DECORATIVE":
            counts["decorative"] += 1
            continue
        if mode == "structured":
            from structured_recovery import structured_response

            try:
                recovered = structured_response(result["text"], job)
            except (ValueError, TypeError, KeyError):
                counts["invalid_structure"].append(job["id"])
                continue
            blocks.extend(recovered)
            counts["applied"] += len(recovered)
        elif mode == "ocr":
            for occurrence in job["occurrences"]:
                target = next(
                    i
                    for i, b in enumerate(blocks)
                    if b.get("img_path") == occurrence["img_path"]
                )
                recovered = ocr_blocks(result, occurrence)
                blocks[target + 1 : target + 1] = recovered
                counts["applied"] += len(recovered)
        elif job["kind"] in {"page", "region"}:
            if mode == "caption-replace-tables":
                x0, y0, x1, y1 = job["bbox"]
                replaced = [
                    b
                    for b in blocks
                    if b.get("type") == "table"
                    and b["page_idx"] == job["page"]
                    and x0 <= b["bbox"][0]
                    and y0 <= b["bbox"][1]
                    and x1 >= b["bbox"][2]
                    and y1 >= b["bbox"][3]
                ]
                blocks[:] = [b for b in blocks if b not in replaced]
                counts["tables_replaced"] += len(replaced)
            blocks.append(
                {
                    "type": "image",
                    "page_idx": job["page"],
                    "bbox": job["bbox"],
                    "img_path": job["image"],
                    "description": result["text"],
                    "_recovery": "caption-" + job["kind"],
                }
            )
            counts["applied"] += 1
        else:
            targets = {o["img_path"] for o in job["occurrences"]}
            for block in blocks:
                if block.get("img_path") in targets:
                    block["description"] = result["text"]
                    counts["applied"] += 1
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("experiment", type=Path)
    parser.add_argument("variants", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--checks", type=Path, required=True)
    parser.add_argument(
        "--chunking", choices=["current", "structured"], default="current"
    )
    parser.add_argument("--figure-tokens", choices=[400, 800], type=int, default=400)
    args = parser.parse_args()
    from pipeline.retrieval.chunking import chunk_content_list

    chunker = chunk_content_list
    if args.chunking == "structured":
        from structured_recovery import chunk_structured

        chunker = partial(chunk_structured, figure_tokens=args.figure_tokens)
    args.output.mkdir(parents=True, exist_ok=False)
    corpus = json.loads((args.baseline / "corpus.json").read_text())["entries"]
    specification = json.loads(args.checks.read_text())
    if any(
        "source" not in check
        or not any(key in check for key in ["anchors", "row", "ordered"])
        for check in specification["checks"]
    ):
        raise ValueError(
            "--checks requires the executable source/anchor schema in opendataloader-checks.json; java-recovery-checks.json is a separate semantic review question set"
        )
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
    output_records = []
    variants = json.loads(args.variants.read_text())["variants"]
    for variant in variants:
        for entry in corpus:
            if entry["suite"] != variant["suite"]:
                continue
            case = entry["id"]
            native_root = (
                args.baseline
                if variant["parser"] == "mineru"
                else args.experiment / variant.get("native_root", ".")
            )
            source = native_root / "results" / variant["native_run"] / case
            image_source = (
                args.experiment / variant["image_root"] / case
                if variant.get("image_root")
                else source
            )
            reference = json.loads(
                (args.baseline / "prepared" / f"{case}.reference.json").read_text()
            )
            native_result = (
                json.loads((source / "result.json").read_text())
                if (source / "result.json").exists()
                else {
                    "id": case,
                    "state": "unavailable",
                    "input_sha256": entry["pdf_sha256"],
                    "reason": "native result is absent",
                }
            )
            if native_result["state"] != "ok":
                directory = args.output / variant["name"] / case
                directory.mkdir(parents=True)
                save(directory / "result.json", native_result)
                record = evaluate(directory, entry, reference, checks, chunker=chunker)
                output_records.append(
                    {
                        **record,
                        "run": variant["name"],
                        "case": case,
                        "steps": [],
                        "recovery_unavailable": True,
                    }
                )
                continue
            blocks = (
                json.loads((source / "content_list.json").read_text())
                if variant["parser"] == "mineru"
                else odl_content_list(
                    json.loads((source / f"{case}.json").read_text()), reference
                )
            )
            blocks = copy.deepcopy(blocks)
            steps = []
            if variant.get("repair_encoding"):
                from structured_recovery import repair_encoded_text

                inventory = next(
                    record
                    for record in json.loads(
                        (args.experiment / variant["repair_encoding"]).read_text()
                    )["records"]
                    if record["id"] == case
                )
                if inventory["pdf_sha256"] != entry["pdf_sha256"]:
                    raise ValueError("encoding repair source hash mismatch")
                steps.append(
                    {
                        "encoding_glyph_replacements": repair_encoded_text(
                            blocks, inventory
                        )
                    }
                )
            for step in variant.get("steps", []):
                if step["mode"] == "layout":
                    manifest = json.loads(
                        (args.experiment / step["run"] / "complete.json").read_text()
                    )
                    selected = any(
                        record["case"] == case for record in manifest["records"]
                    )
                    path = args.experiment / step["run"] / case / "content_list.json"
                    if path.exists():
                        recovered = json.loads(path.read_text())
                        blocks.extend(recovered)
                        steps.append(
                            {
                                "run": step["run"],
                                "state": "ok",
                                "applied": len(recovered),
                            }
                        )
                    else:
                        steps.append(
                            {
                                "run": step["run"],
                                "state": "unavailable" if selected else "not_selected",
                                "applied": 0,
                            }
                        )
                    continue
                jobs = [
                    j
                    for j in json.loads((args.experiment / step["jobs"]).read_text())[
                        "jobs"
                    ]
                    if j["case"] == case and j["kind"] in step["kinds"]
                ]
                if step.get("include_ids") is not None:
                    jobs = [j for j in jobs if j["id"] in step["include_ids"]]
                if step.get("exclude_ids"):
                    jobs = [j for j in jobs if j["id"] not in step["exclude_ids"]]
                for job in jobs:
                    if job["kind"] == "java":
                        for occurrence in job["occurrences"]:
                            if (
                                hashlib.sha256(
                                    (image_source / occurrence["img_path"]).read_bytes()
                                ).hexdigest()
                                != job["image_sha256"]
                            ):
                                raise ValueError(
                                    "native image differs from recovery input"
                                )
                binding = (
                    json.loads((args.experiment / step["binding"]).read_text())
                    if step.get("binding")
                    else None
                )
                counts = apply_saved(
                    blocks, jobs, args.experiment / step["run"], step["mode"], binding
                )
                steps.append(
                    {"run": step["run"], "binding": step.get("binding"), **counts}
                )
            if variant.get("deduplicate_recovered_text"):
                from structured_recovery import drop_exact_recovered_text

                steps.append(
                    {"exact_recovered_duplicates": drop_exact_recovered_text(blocks)}
                )
            # Keep each source's native order, and insert appended recovery images by page.
            blocks.sort(key=lambda b: b["page_idx"])
            directory = args.output / variant["name"] / case
            directory.mkdir(parents=True)
            image_hashes = {
                path: hashlib.sha256((image_source / path).read_bytes()).hexdigest()
                for path in {b["img_path"] for b in blocks if b.get("img_path")}
            }
            dedup = deduplicate_images(blocks, image_source, directory)
            save(directory / "content_list.json", blocks)
            save(
                directory / "result.json",
                {
                    **native_result,
                    "config": "recovery-evaluation",
                    "native_wall_s": native_result.get("wall_s"),
                    "native_peak_memory_bytes": native_result.get("peak_memory_bytes"),
                    "wall_s": None,
                    "peak_memory_bytes": None,
                    "timing_note": "saved-output quality evaluation; native timing is separate from recovery",
                    "image_source": str(image_source),
                    "source_image_sha256": image_hashes,
                },
            )
            record = evaluate(directory, entry, reference, checks, chunker=chunker)
            output_records.append(
                {
                    **record,
                    "run": variant["name"],
                    "case": case,
                    "steps": steps,
                    "deduplication": dedup,
                }
            )
        rows = [r for r in output_records if r["run"] == variant["name"]]
        probes = [p for r in rows for p in r["probes"]]
        print(
            variant["name"],
            json.dumps(
                {
                    "cases": len(rows),
                    "raw_pass": sum(p["raw_pass"] for p in probes),
                    "chunk_pass": sum(p["chunk_pass"] for p in probes),
                    "probes": len(probes),
                }
            ),
            flush=True,
        )
    save(
        args.output / "evaluation.json",
        {
            "records": output_records,
            "variants": variants,
            "chunking": args.chunking,
            "figure_tokens": args.figure_tokens,
            "checks_sha256": hashlib.sha256(args.checks.read_bytes()).hexdigest(),
            "chunker_sha256": hashlib.sha256(
                (
                    Path(__file__).resolve().parents[3]
                    / "pipeline/pipeline/retrieval/chunking.py"
                ).read_bytes()
            ).hexdigest(),
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "structured_chunker_sha256": hashlib.sha256(
                Path(__file__).with_name("structured_recovery.py").read_bytes()
            ).hexdigest()
            if args.chunking == "structured"
            else None,
        },
    )
    shutil.copy2(args.variants, args.output / "variants.json")


if __name__ == "__main__":
    main()
