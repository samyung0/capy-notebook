#!/usr/bin/env python3
"""Local diagnostic: production RapidOCR lines ordered by PP-DocLayoutV3 regions.

No production imports are changed. ``prepare-controls`` adds two source-defined
negative controls before inference. ``run`` freezes inputs, code and rubrics in a
new output directory. ``score`` can recheck saved results without loading models.
The rasterized digital pages are diagnostic OCR controls, not production routes.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import resource
import shutil
import sys
import time
from dataclasses import asdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CHECKS = ROOT / "bench/parsers/fixtures/odl-layout-ocr-checks.json"
sys.path.insert(0, str(ROOT))


def dump(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare_controls(inputs: Path) -> None:
    import pymupdf

    manifest_path = inputs / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    checks = json.loads(CHECKS.read_text())
    for name in ("unit-bearing-table", "alternating-outline"):
        case_id = name + "-p01"
        if any(row["id"] == case_id for row in manifest):
            raise ValueError(f"Control already exists: {case_id}")
        doc = pymupdf.open()
        page = doc.new_page(width=600, height=800)
        regions = {}
        order = []

        def line(key: str, y: float, left: str, right: str = "") -> None:
            page.insert_text((60, y), left, fontsize=13, fontname="helv")
            if right:
                page.insert_text((405, y), right, fontsize=13, fontname="helv")
            regions[key] = [80, (y - 18) / 800 * 1000, 950, (y + 5) / 800 * 1000]
            order.append(key)

        if name == "unit-bearing-table":
            line("title", 65, "Cargo mass by destination")
            line("header", 130, "Destination", "Recorded mass")
            for y in (108, 146, 524):
                page.draw_line((55, y), (565, y), width=1)
            ports = ["Alder", "Birch", "Cedar", "Dover", "Elm", "Fir", "Grove", "Hazel"]
            for i, port in enumerate(ports):
                line(f"row{i}", 180 + i * 45, f"{port} port", f"{i + 1},000,000 kg")
            line(
                "footer",
                580,
                "Mass includes packaging and excludes transport equipment.",
            )
        else:
            line("title", 65, "Fieldwork checklist")
            for i, (heading, body) in enumerate(
                [
                    ("A. Prepare", "Inspect the bottles and record their empty mass."),
                    ("B. Collect", "Keep one sealed sample from each location."),
                    ("C. Transport", "Store all samples in the insulated container."),
                    ("D. Measure", "Weigh each sample before removing the seal."),
                ]
            ):
                line(f"heading{i}", 150 + i * 120, heading)
                line(f"body{i}", 188 + i * 120, body)
        pdf = inputs / f"{case_id}.pdf"
        doc.save(pdf)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(3.2, 3.2), alpha=False)
        image = inputs / f"{case_id}.png"
        pix.save(image)
        (inputs / f"{case_id}.source.txt").write_text(page.get_text())
        manifest.append(
            {
                "id": case_id,
                "source": str(pdf.relative_to(ROOT)),
                "page": 1,
                "source_sha256": sha(pdf),
                "image_sha256": sha(image),
                "role": "synthetic negative control, frozen before inference",
                "source_native_chars": len(page.get_text()),
            }
        )
        checks["cases"][case_id] = {"regions": regions, "sequences": [order]}
        doc.close()
    dump(manifest_path, manifest)
    dump(CHECKS, checks)


def area(box: list[float]) -> float:
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def overlap(a: list[float], b: list[float]) -> float:
    return area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def order_lines(
    blocks: list[dict], regions: list[dict]
) -> tuple[list[int], list[int | None]]:
    """Order mapped lines by the model; unmapped lines retain their baseline slots.

    Every recognized line occurs exactly once. Table contents remain row-major
    within a single model region, using no alphabetic/numeric content heuristic.
    Partial mapping is an experimental arm, not a production fallback policy.
    """
    assignments = []
    for block in blocks:
        box = block["bbox"]
        matches = [
            (
                overlap(box, region["bbox"]) / max(area(box), 1e-9),
                -area(region["bbox"]),
                i,
            )
            for i, region in enumerate(regions)
        ]
        best = max(matches, default=(0, 0, None))
        assignments.append(best[2] if best[0] >= 0.5 else None)
    mapped = sorted(
        (i for i, region in enumerate(assignments) if region is not None),
        key=lambda i: (assignments[i], i),
    )
    reordered = iter(mapped)
    order = [
        next(reordered) if region is not None else i
        for i, region in enumerate(assignments)
    ]
    assert sorted(order) == list(range(len(blocks)))
    return order, assignments


def table_row_order(
    blocks: list[dict],
    regions: list[dict],
    assignments: list[int | None],
    initial: list[int],
) -> tuple[list[int], list[dict]]:
    """Development r2: reorder contiguous, completely mapped table regions only.

    Row members must share a vertical interval, preventing transitive chaining
    through a tall cell. The model identifies tables; text content is unused.
    This recovers visual line order, not cell spans or header semantics.
    """
    order = list(initial)
    evidence = []
    for region_id, region in enumerate(regions):
        if region["class"] != "table":
            continue
        members = [
            i for i, assignment in enumerate(assignments) if assignment == region_id
        ]
        positions = [i for i, line in enumerate(order) if line in members]
        if not members:
            continue
        reason = None
        if max(positions) - min(positions) + 1 != len(positions):
            reason = "table lines are not contiguous"
        elif any(
            assignment != region_id and overlap(block["bbox"], region["bbox"]) > 0
            for assignment, block in zip(assignments, blocks)
        ):
            reason = "another or unmapped line intersects table region"
        if reason:
            evidence.append(
                {"region": region_id, "status": "abstain", "reason": reason}
            )
            continue
        rows = []
        for line in sorted(members, key=lambda i: sum(blocks[i]["bbox"][1::2])):
            box = blocks[line]["bbox"]
            if rows and max(rows[-1]["top"], box[1]) < min(rows[-1]["bottom"], box[3]):
                rows[-1]["top"] = max(rows[-1]["top"], box[1])
                rows[-1]["bottom"] = min(rows[-1]["bottom"], box[3])
                rows[-1]["lines"].append(line)
            else:
                rows.append({"top": box[1], "bottom": box[3], "lines": [line]})
        replacement = [
            line
            for row in rows
            for line in sorted(row["lines"], key=lambda i: blocks[i]["bbox"][0])
        ]
        start, end = min(positions), max(positions) + 1
        changed = order[start:end] != replacement
        order[start:end] = replacement
        evidence.append(
            {
                "region": region_id,
                "status": "changed" if changed else "unchanged",
                "rows": len(rows),
                "lines": len(members),
            }
        )
    assert sorted(order) == list(range(len(blocks)))
    return order, evidence


def replay_table_rows(previous: Path, output: Path) -> None:
    """Reuse immutable model outputs; preserve r1 and its frozen source checks."""
    from pipeline.retrieval.packing import pack_blocks

    output.mkdir(parents=True, exist_ok=False)
    for name in ("manifest.json", "checks.json", "provenance.json"):
        shutil.copy2(previous / name, output / name)
    shutil.copy2(__file__, output / "script.py")
    manifest = json.loads((previous / "manifest.json").read_text())
    dump(
        output / "replay.json",
        {
            "source_run": str(previous),
            "script_sha256": sha(Path(__file__)),
            "phase": "development after r1 output inspection; source rubrics unchanged",
        },
    )
    for row in manifest:
        case_id = row["id"]
        path = previous / f"{case_id}.json"
        result = json.loads(path.read_text())
        result["source_result_sha256"] = sha(path)
        order, evidence = table_row_order(
            result["blocks"],
            result["regions"],
            result["assignments"],
            result["orders"]["layout_strict"],
        )
        result["orders"]["layout_and_table_rows"] = order
        result["table_row_repair"] = evidence
        dump(output / f"{case_id}.json", result)
        chunks = pack_blocks([result["blocks"][i] for i in order], frozenset())
        dump(
            output / f"{case_id}.layout_and_table_rows.chunks.json",
            [asdict(chunk) for chunk in chunks],
        )
        (output / f"{case_id}.layout_and_table_rows.txt").write_text(
            "\n".join(result["blocks"][i]["text"] for i in order) + "\n"
        )
    score(output)


def score_case(result: dict, rubric: dict) -> dict:
    """Score only source-annotated cross-region constraints, independently of text."""
    labels = []
    crossing = []
    for i, block in enumerate(result["blocks"]):
        box = block["bbox"]
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        matches = [
            key
            for key, r in rubric["regions"].items()
            if r[0] <= cx <= r[2] and r[1] <= cy <= r[3]
        ]
        if len(matches) > 1:
            raise ValueError(f"Overlapping source regions on line {i}: {matches}")
        labels.append(matches[0] if matches else None)
        spans = [
            key
            for key, r in rubric["regions"].items()
            if overlap(box, r) / max(area(box), 1e-9) >= 0.2
        ]
        if len(spans) > 1:
            crossing.append({"line": i, "regions": spans, "text": block["text"]})
    constraints = set()
    for seq in rubric["sequences"]:
        constraints.update((a, b) for i, a in enumerate(seq) for b in seq[i + 1 :])
    pairs = [
        (i, j)
        for i, a in enumerate(labels)
        for j, b in enumerate(labels)
        if (a, b) in constraints
    ]
    variants = {}
    for name, order in result["orders"].items():
        positions = {line: pos for pos, line in enumerate(order)}
        wrong = [(i, j) for i, j in pairs if positions[i] > positions[j]]
        variants[name] = {
            "wrong_pairs": len(wrong),
            "pairs": len(pairs),
            "error_rate": len(wrong) / len(pairs) if pairs else None,
            "examples": wrong[:12],
        }
        # Independent infographic panels have no unique mutual reading order;
        # count interleaving instead of imposing an arbitrary panel sequence.
        groups = rubric.get("cohesion_groups", [])
        sequence = [labels[i] for i in order if labels[i] in groups]
        variants[name]["group_fragments"] = {
            group: sum(
                label == group and (i == 0 or sequence[i - 1] != group)
                for i, label in enumerate(sequence)
            )
            for group in groups
        }
    return {
        "id": result["id"],
        "lines": len(labels),
        "scored_lines": sum(x is not None for x in labels),
        "region_line_counts": {key: labels.count(key) for key in rubric["regions"]},
        "crossing_gold_regions": crossing,
        "unmapped_lines": result["unmapped_lines"],
        "layout_regions": len(result["regions"]),
        "ocr_seconds": result["ocr_seconds"],
        "layout_seconds": result["layout_seconds"],
        "strict_active": result["strict_active"],
        "variants": variants,
    }


def score(run: Path) -> None:
    checks = json.loads((run / "checks.json").read_text())
    manifest = json.loads((run / "manifest.json").read_text())
    results = [
        score_case(
            json.loads((run / f"{row['id']}.json").read_text()),
            checks["cases"][row["id"]],
        )
        for row in manifest
    ]
    dump(run / "scores.json", results)
    for row in results:
        rates = " ".join(
            f"{key}={value['wrong_pairs']}/{value['pairs']}"
            for key, value in row["variants"].items()
        )
        print(
            f"{row['id']}: {rates} unmapped={row['unmapped_lines']} "
            f"layout={row['layout_seconds']:.3f}s",
            flush=True,
        )


def run(inputs: Path, output: Path, models: Path) -> None:
    # The production model configuration is imported only after its path is set.
    os.environ["CAPY_RAPIDOCR_MODEL_DIR"] = str(models)
    import numpy as np
    import psutil
    from PIL import Image, ImageDraw
    from pipeline.retrieval.packing import pack_blocks
    from rapid_layout import ModelType, RapidLayout

    from parser.odl import ocr

    output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((inputs / "manifest.json").read_text())
    for row in manifest:
        if (
            sha(ROOT / row["source"]) != row["source_sha256"]
            or sha(inputs / f"{row['id']}.png") != row["image_sha256"]
        ):
            raise ValueError(f"Source or image hash changed: {row['id']}")
    shutil.copy2(inputs / "manifest.json", output / "manifest.json")
    shutil.copy2(CHECKS, output / "checks.json")
    shutil.copy2(__file__, output / "script.py")
    layout_config = {
        "model_type": ModelType.PP_DOC_LAYOUTV3,
        "model_dir_or_path": models / "pp_doc_layoutv3.onnx",
        "engine_type": "onnxruntime",
        "engine_cfg": {"intra_op_num_threads": 4, "inter_op_num_threads": 1},
        "conf_thresh": 0.5,
        "iou_thresh": 0.5,
    }
    provenance = {
        "platform": platform.platform(),
        "python": sys.version,
        "dependencies": {
            name: importlib.metadata.version(name)
            for name in [
                "rapidocr",
                "rapid-layout",
                "onnxruntime",
                "numpy",
                "pymupdf",
                "pillow",
            ]
        },
        "models": {p.name: sha(p) for p in sorted(models.glob("*.onnx"))},
        "script_sha256": sha(Path(__file__)),
        "checks_sha256": sha(CHECKS),
        "production_ocr_sha256": sha(ROOT / "parser/odl/ocr.py"),
        "production_packing_sha256": sha(
            ROOT / "pipeline/pipeline/retrieval/packing.py"
        ),
        "configuration": {
            key: str(value) if isinstance(value, (Path, ModelType)) else value
            for key, value in layout_config.items()
        },
        "assignment_threshold": 0.5,
        "notes": (
            "One local CPU run, no capacity claim. Same production OCR text and "
            "page boxes in all arms. Strict arm abstains for any unmapped line. "
            "Rasterized digital pages are forced OCR diagnostics; production "
            "normally uses native text."
        ),
    }
    dump(output / "provenance.json", provenance)
    started = time.perf_counter()
    layout = RapidLayout(**layout_config)
    provenance["layout_load_seconds"] = time.perf_counter() - started
    ocr.reader()
    process = psutil.Process()
    for row in manifest:
        case_id = row["id"]
        image = Image.open(inputs / f"{case_id}.png").convert("RGB")
        started = time.perf_counter()
        lines = ocr.ocr_lines(image)
        ocr_seconds = time.perf_counter() - started
        blocks = ocr.line_blocks(lines, image.size, row["page"] - 1)
        started = time.perf_counter()
        layout_result = layout(np.asarray(image))
        layout_seconds = time.perf_counter() - started
        w, h = image.size
        regions = [
            {
                "bbox": [
                    float(b[0]) / w * 1000,
                    float(b[1]) / h * 1000,
                    float(b[2]) / w * 1000,
                    float(b[3]) / h * 1000,
                ],
                "class": c,
                "score": float(s),
            }
            for b, c, s in zip(
                layout_result.boxes, layout_result.class_names, layout_result.scores
            )
        ]
        proposed, assigned = order_lines(blocks, regions)
        baseline = list(range(len(blocks)))
        unmapped = assigned.count(None)
        orders = {
            "baseline": baseline,
            "layout_partial": proposed,
            "layout_strict": proposed if unmapped == 0 else baseline,
        }
        result = {
            "id": case_id,
            "lines": lines,
            "blocks": blocks,
            "regions": regions,
            "assignments": assigned,
            "orders": orders,
            "unmapped_lines": unmapped,
            "strict_active": unmapped == 0,
            "ocr_seconds": ocr_seconds,
            "layout_seconds": layout_seconds,
            "rss_bytes_after_page": process.memory_info().rss,
            "peak_rss_platform_units": resource.getrusage(
                resource.RUSAGE_SELF
            ).ru_maxrss,
        }
        dump(output / f"{case_id}.json", result)
        for variant, order in orders.items():
            chunks = pack_blocks([blocks[i] for i in order], frozenset())
            dump(
                output / f"{case_id}.{variant}.chunks.json",
                [asdict(chunk) for chunk in chunks],
            )
            (output / f"{case_id}.{variant}.txt").write_text(
                "\n".join(blocks[i]["text"] for i in order) + "\n"
            )
        draw = ImageDraw.Draw(image)
        for i, r in enumerate(regions):
            box = [
                r["bbox"][0] / 1000 * w,
                r["bbox"][1] / 1000 * h,
                r["bbox"][2] / 1000 * w,
                r["bbox"][3] / 1000 * h,
            ]
            draw.rectangle(box, outline="red", width=3)
            draw.text(
                (box[0], box[1]), f"{i}: {r['class']}", fill="blue", stroke_width=1
            )
        image.save(output / f"{case_id}.layout.png")
        print(
            f"finished {case_id}: {len(lines)} OCR lines, {len(regions)} regions, "
            f"OCR {ocr_seconds:.2f}s, layout {layout_seconds:.2f}s",
            flush=True,
        )
    dump(output / "provenance.json", provenance)
    score(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare-controls")
    prepare.add_argument("inputs", type=Path)
    inference = sub.add_parser("run")
    inference.add_argument("inputs", type=Path)
    inference.add_argument("output", type=Path)
    inference.add_argument("models", type=Path)
    scorer = sub.add_parser("score")
    scorer.add_argument("run", type=Path)
    replay = sub.add_parser("table-rows")
    replay.add_argument("previous", type=Path)
    replay.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.command == "prepare-controls":
        prepare_controls(args.inputs.resolve())
    elif args.command == "run":
        run(args.inputs.resolve(), args.output.resolve(), args.models.resolve())
    elif args.command == "table-rows":
        replay_table_rows(args.previous.resolve(), args.output.resolve())
    else:
        score(args.run.resolve())


if __name__ == "__main__":
    main()
