"""Prepare and measure image-only recovery on the frozen parser corpus.

Uses the real Capy image prompt, but no application database, cache or jobs.
Caption failures are recorded without switching models or retrying a request.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib.metadata
import io
import json
import os
import platform
import re
import subprocess
import time
from pathlib import Path

from compare_opendataloader import save
from PIL import Image


def saved_response(directory: Path, job: dict, binding: dict | None = None) -> dict:
    """Bind a receipt to its exact run, or an explicitly pinned legacy archive."""
    run_bytes = (directory / "run.json").read_bytes()
    run_hash = hashlib.sha256(run_bytes).hexdigest()
    run = json.loads(run_bytes)
    jobs = {j["id"]: j for j in run["jobs"]}
    if len(jobs) != len(run["jobs"]):
        raise ValueError("duplicate saved job IDs")
    saved = jobs.get(job["id"])
    if saved is None or any(
        saved[key] != job[key] for key in ["image_sha256", "pdf_sha256"]
    ):
        raise ValueError("saved run source hashes differ from the selected job")
    path = directory / f"{job['id']}.json"
    if not path.exists():
        return {"state": "absent"}
    data = path.read_bytes()
    receipt = json.loads(data)
    if receipt.get("job") != job["id"]:
        raise ValueError("saved receipt belongs to another job")
    if receipt.get("run_sha256"):
        if receipt["run_sha256"] != run_hash:
            raise ValueError("saved receipt belongs to another request configuration")
        for key in ["image_sha256", "pdf_sha256"]:
            if receipt.get(key) != job[key]:
                raise ValueError("saved receipt source hash mismatch")
    else:
        if (
            not binding
            or binding.get("run_sha256") != run_hash
            or binding.get("responses", {}).get(job["id"])
            != hashlib.sha256(data).hexdigest()
        ):
            raise ValueError("legacy receipt requires an explicit archive binding")
        for key in ["image_sha256", "pdf_sha256"]:
            if key in receipt and receipt[key] != job[key]:
                raise ValueError("legacy receipt source hash mismatch")
    if (
        receipt.get("state") == "ok"
        and run.get("model")
        and receipt.get("actual_model", receipt.get("response", {}).get("model"))
        != run["model"]
    ):
        raise ValueError("saved response model differs from the run model")
    return receipt


def ocr_blocks(record: dict, occurrence: dict) -> list[dict]:
    width, height = record["size"]
    x0, y0, x1, y1 = occurrence["bbox"]
    blocks = []
    for line in record["lines"]:
        xs, ys = zip(*line["box"])
        box = [
            x0 + min(xs) / width * (x1 - x0),
            y0 + min(ys) / height * (y1 - y0),
            x0 + max(xs) / width * (x1 - x0),
            y0 + max(ys) / height * (y1 - y0),
        ]
        blocks.append(
            {
                "type": "text",
                "text": line["text"],
                "page_idx": occurrence["page"],
                "bbox": box,
                "_recovery": "rapidocr-line",
                "_ocr_score": line["score"],
            }
        )
    return blocks


def deduplicate_images(blocks: list[dict], source: Path, destination: Path) -> dict:
    """Materialize actual content-addressed image files, preserving every placement."""
    started = time.monotonic()
    destination.mkdir(parents=True, exist_ok=True)
    seen = set()
    before_bytes = 0
    placements = 0
    for block in blocks:
        if not block.get("img_path"):
            continue
        path = source / block["img_path"]
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        relative = Path("images") / (digest + path.suffix.lower())
        before_bytes += len(data)
        placements += 1
        if relative not in seen:
            (destination / relative).parent.mkdir(parents=True, exist_ok=True)
            (destination / relative).write_bytes(data)
            seen.add(relative)
        block["img_path"] = str(relative)
    return {
        "placements": placements,
        "unique_files": len(seen),
        "placement_bytes": before_bytes,
        "stored_bytes": sum((destination / p).stat().st_size for p in seen),
        "seconds": time.monotonic() - started,
    }


def layout_ocr(args: argparse.Namespace) -> None:
    """Ask Java to order OCR lines using a disposable, visible-text-only PDF."""
    import pymupdf
    from compare_opendataloader import Sampler, odl_content_list

    jobs = json.loads((args.ocr_run / "run.json").read_text())["jobs"]
    corpus = {
        e["id"]: e
        for e in json.loads((args.baseline / "corpus.json").read_text())["entries"]
    }
    args.output.mkdir(parents=True, exist_ok=False)
    font = pymupdf.Font("cjk")
    sampler = Sampler(args.output / "resources.csv")
    sampler.thread.start()
    started = time.monotonic()
    records = []
    try:
        for case in sorted({j["case"] for j in jobs}):
            case_started = time.monotonic()
            entry = corpus[case]
            target = args.output / case
            target.mkdir()
            pdf = target / f"{case}.pdf"
            lines = 0
            pages = set()
            with (
                pymupdf.open(args.baseline / entry["pdf"]) as original,
                pymupdf.open() as document,
            ):
                for page in original:
                    document.new_page(width=page.rect.width, height=page.rect.height)
                for job in [j for j in jobs if j["case"] == case]:
                    result = json.loads(
                        (args.ocr_run / f"{job['id']}.json").read_text()
                    )
                    if result["state"] != "ok" or result["job"] != job["id"]:
                        raise ValueError("OCR input is incomplete")
                    if (
                        result.get("image_sha256", job["image_sha256"])
                        != job["image_sha256"]
                    ):
                        raise ValueError("OCR image hash mismatch")
                    width, height = result["size"]
                    for occurrence in job["occurrences"]:
                        page = document[occurrence["page"]]
                        pages.add(occurrence["page"])
                        x0, y0, x1, y1 = occurrence["bbox"]
                        for line in result["lines"]:
                            xs, ys = zip(*line["box"])
                            left = (
                                (x0 + min(xs) / width * (x1 - x0))
                                * page.rect.width
                                / 1000
                            )
                            top = (
                                (y0 + min(ys) / height * (y1 - y0))
                                * page.rect.height
                                / 1000
                            )
                            line_width = (
                                (max(xs) - min(xs))
                                / width
                                * (x1 - x0)
                                * page.rect.width
                                / 1000
                            )
                            line_height = (
                                (max(ys) - min(ys))
                                / height
                                * (y1 - y0)
                                * page.rect.height
                                / 1000
                            )
                            fontsize = line_height / (font.ascender - font.descender)
                            point = pymupdf.Point(left, top + fontsize * font.ascender)
                            text_width = font.text_length(
                                line["text"], fontsize=fontsize
                            )
                            if text_width <= 0:
                                raise ValueError("empty OCR text line")
                            writer = pymupdf.TextWriter(page.rect)
                            writer.append(
                                point, line["text"], font=font, fontsize=fontsize
                            )
                            writer.write_text(
                                page,
                                morph=(
                                    point,
                                    pymupdf.Matrix(line_width / text_width, 1),
                                ),
                            )
                            lines += 1
                document.subset_fonts()
                document.save(pdf, garbage=4, deflate=True)
            render_seconds = time.monotonic() - case_started
            command = [
                "opendataloader-pdf",
                str(pdf),
                "--output-dir",
                str(target),
                "--format",
                "json,markdown",
                "--threads",
                "1",
                "--table-method",
                "cluster",
                "--include-header-footer",
            ]
            with (target / "converter.log").open("w") as log:
                subprocess.run(
                    command,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=120,
                    check=True,
                )
            reference = json.loads(
                (args.baseline / "prepared" / f"{case}.reference.json").read_text()
            )
            native = json.loads((target / f"{case}.json").read_text())
            blocks = odl_content_list(native, reference)
            save(target / "content_list.json", blocks)
            record = {
                "case": case,
                "lines": lines,
                "pages": sorted(pages),
                "blocks": len(blocks),
                "render_seconds": render_seconds,
                "seconds": time.monotonic() - case_started,
                "pdf_sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
                "command": command,
            }
            records.append(record)
            save(target / "result.json", record)
            print(case, round(record["seconds"], 3), flush=True)
    finally:
        sampler.stop.set()
        sampler.thread.join()
    save(
        args.output / "complete.json",
        {
            "seconds": time.monotonic() - started,
            "records": records,
            "peak_memory_bytes": sampler.peak_memory,
            "peak_swap_bytes": sampler.peak_swap,
            "font": font.name,
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
    )


def recovery_bands(page: dict, padding: float) -> list[list[float]]:
    """Full-width bands retain nearby legends; overlapping bands are rendered once."""
    width, height = page["width"], page["height"]
    rectangles = page["stroke_vector_regions"] + [
        [x0 * width / 1000, y0 * height / 1000, x1 * width / 1000, y1 * height / 1000]
        for x0, y0, x1, y1 in page["java_tables"]
    ]
    spans = sorted(
        (max(0, r[1] - padding), min(height, r[3] + padding)) for r in rectangles
    )
    merged = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [[0, start, width, end] for start, end in merged]


def page_recovery_reasons(page: dict, figure_pages: set[int]) -> list[str]:
    if "scan" in page["flags"]:
        return []
    return [
        flag
        for flag in ["vector", "table", "text_gap", "source_table", "encoded_text"]
        if flag in page["flags"]
    ] + (["captionable_image"] if page["page"] in figure_pages else [])


def scan_recovery_reasons(result: dict) -> list[str]:
    """Frozen benchmark signals for failed OCR lines, tables and two columns."""
    if result.get("state") != "ok":
        return ["ocr_incomplete"]
    width, _ = result["size"]
    boxes = []
    for line in result["lines"]:
        xs, ys = zip(*line["box"], strict=True)
        boxes.append((min(xs), min(ys), max(xs), max(ys), line["text"], line["score"]))
    reasons = []
    if any(
        x1 - x0 > width / 4 and sum(c.isalnum() for c in text) < 3 and score < 0.8
        for x0, _, x1, _, text, score in boxes
    ):
        reasons.append("ocr_empty_line")
    numeric = sorted(
        ((y0 + y1) / 2, y1 - y0)
        for _, y0, _, y1, text, _ in boxes
        if re.fullmatch(r"[+−\-]?[\d.,]+[%§‡†*]?", text.strip())
    )
    bands = []
    for center, height in numeric:
        if bands and abs(center - bands[-1][0]) <= min(height, bands[-1][1]) / 2:
            bands[-1][2] += 1
        else:
            bands.append([center, height, 1])
    if sum(count >= 3 for _, _, count in bands) >= 2:
        reasons.append("ocr_numeric_columns")
    prose = [
        (x0, x1)
        for x0, _, x1, _, text, _ in boxes
        if width * 0.2 <= x1 - x0 <= width * 0.55 and len(text) >= 20
    ]
    if (
        sum(x0 < width * 0.2 for x0, _ in prose) >= 5
        and sum(x0 > width * 0.4 for x0, _ in prose) >= 5
    ):
        reasons.append("ocr_two_columns")
    return reasons


def captionable_pages(
    blocks: list[dict], directory: Path, paths: list[str]
) -> set[int]:
    digests = {
        path: hashlib.sha256((directory / path).read_bytes()).hexdigest()
        for path in {b["img_path"] for b in blocks if b.get("img_path")}
    }
    selected = {digests[path] for path in paths}
    return {b["page_idx"] for b in blocks if digests.get(b.get("img_path")) in selected}


def scan_page_reasons(
    jobs: list[dict],
    directory: Path,
    pdf_sha256: str,
    image_root: Path | None = None,
    binding: dict | None = None,
) -> list[str]:
    reasons = []
    for job in jobs:
        if job["pdf_sha256"] != pdf_sha256:
            raise ValueError("OCR source does not match the selected PDF")
        path = (
            image_root / job["case"] / job["occurrences"][0]["img_path"]
            if image_root
            else Path(job["image"])
        )
        if hashlib.sha256(path.read_bytes()).hexdigest() != job["image_sha256"]:
            raise ValueError("OCR source image hash mismatch")
        reasons.extend(scan_recovery_reasons(saved_response(directory, job, binding)))
    return list(dict.fromkeys(reasons))


def page_contexts(args: argparse.Namespace) -> None:
    """Render selected original pages, preserving visible context around figures."""
    import pymupdf

    args.output.mkdir(parents=True, exist_ok=False)
    evaluation = json.loads((args.baseline / "evaluation.json").read_text())
    native_run = getattr(args, "native_run", None) or f"{args.suite}-odl-java-cluster"
    native_records = {
        r["case"]: r for r in evaluation["records"] if r["run"] == native_run
    }
    jobs, inspected, skipped_scans = [], 0, 0
    ocr_pages = {}
    binding = json.loads(args.ocr_binding.read_text()) if args.ocr_binding else None
    if args.ocr_run:
        for job in json.loads((args.ocr_run / "run.json").read_text())["jobs"]:
            for occurrence in job["occurrences"]:
                ocr_pages.setdefault((job["case"], occurrence["page"]), []).append(job)
    started = time.monotonic()
    for record in json.loads(args.inventory.read_text())["records"]:
        if record["suite"] != args.suite:
            continue
        native = native_records[record["id"]]
        pdf = args.baseline / record["pdf"]
        if (
            native["state"] != "ok"
            or native["input_sha256"] != record["pdf_sha256"]
            or hashlib.sha256(pdf.read_bytes()).hexdigest() != record["pdf_sha256"]
        ):
            raise ValueError("page selection requires matching complete native inputs")
        native_dir = args.baseline / "results" / native_run / record["id"]
        blocks = json.loads((native_dir / "content_list.json").read_text())
        figure_pages = captionable_pages(
            blocks, native_dir, native["captionable_paths"]
        )
        with pymupdf.open(pdf) as document:
            for page in record["pages"]:
                inspected += 1
                reasons = page_recovery_reasons(page, figure_pages)
                if args.repaired_encoding:
                    reasons = [r for r in reasons if r != "encoded_text"]
                if "scan" in page["flags"] and args.ocr_run:
                    reasons = scan_page_reasons(
                        ocr_pages[record["id"], page["page"]],
                        args.ocr_run,
                        record["pdf_sha256"],
                        args.ocr_image_root,
                        binding,
                    )
                skipped_scans += "scan" in page["flags"] and not reasons
                if not reasons:
                    continue
                render_started = time.monotonic()
                job_id = f"context-{record['id']}-p{page['page'] + 1}"
                path = args.output / (job_id + ".png")
                source = document[page["page"]]
                scale = args.max_edge / max(source.rect.width, source.rect.height)
                source.get_pixmap(
                    matrix=pymupdf.Matrix(scale, scale), alpha=False
                ).save(path)
                jobs.append(
                    {
                        "id": job_id,
                        "kind": "page",
                        "case": record["id"],
                        "page": page["page"],
                        "source_page": page["source_page"],
                        "lang": record["lang"],
                        "image": str(path.resolve()),
                        "image_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "pdf_sha256": record["pdf_sha256"],
                        "bbox": [0, 0, 1000, 1000],
                        "selection_reasons": reasons,
                        "render_seconds": time.monotonic() - render_started,
                    }
                )
    save(
        args.output / "jobs.json",
        {
            "jobs": jobs,
            "inspected_pages": inspected,
            "skipped_scan_pages": skipped_scans,
            "seconds": time.monotonic() - started,
            "render_max_edge": args.max_edge,
            "repaired_encoding": args.repaired_encoding,
            "native_run": native_run,
            "ocr_run": str(args.ocr_run) if args.ocr_run else None,
            "ocr_image_root": str(args.ocr_image_root) if args.ocr_image_root else None,
            "ocr_binding_sha256": hashlib.sha256(
                args.ocr_binding.read_bytes()
            ).hexdigest()
            if args.ocr_binding
            else None,
            "pymupdf_version": pymupdf.__version__,
            "inventory_sha256": hashlib.sha256(args.inventory.read_bytes()).hexdigest(),
            "native_evaluation_sha256": hashlib.sha256(
                (args.baseline / "evaluation.json").read_bytes()
            ).hexdigest(),
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
    )
    print(
        json.dumps(
            {
                "selected_pages": len(jobs),
                "inspected_pages": inspected,
                "skipped_scan_pages": skipped_scans,
            }
        )
    )


def regions(args: argparse.Namespace) -> None:
    import pymupdf

    args.output.mkdir(parents=True, exist_ok=False)
    jobs = []
    started = time.monotonic()
    for record in json.loads(args.inventory.read_text())["records"]:
        if record["suite"] != args.suite:
            continue
        pdf = args.baseline / record["pdf"]
        if hashlib.sha256(pdf.read_bytes()).hexdigest() != record["pdf_sha256"]:
            raise ValueError("PDF hash mismatch")
        with pymupdf.open(pdf) as document:
            for page in record["pages"]:
                if "scan" in page["flags"]:
                    continue
                for index, box in enumerate(recovery_bands(page, args.padding)):
                    call_started = time.monotonic()
                    job_id = f"region-{record['id']}-p{page['page'] + 1}-r{index + 1}"
                    path = args.output / f"{job_id}.png"
                    clip = pymupdf.Rect(box)
                    scale = args.max_edge / max(clip.width, clip.height)
                    document[page["page"]].get_pixmap(
                        matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False
                    ).save(path)
                    jobs.append(
                        {
                            "id": job_id,
                            "kind": "region",
                            "case": record["id"],
                            "page": page["page"],
                            "source_page": page["source_page"],
                            "lang": record["lang"],
                            "image": str(path.resolve()),
                            "image_sha256": hashlib.sha256(
                                path.read_bytes()
                            ).hexdigest(),
                            "pdf_sha256": record["pdf_sha256"],
                            "bbox": [
                                box[0] / page["width"] * 1000,
                                box[1] / page["height"] * 1000,
                                box[2] / page["width"] * 1000,
                                box[3] / page["height"] * 1000,
                            ],
                            "render_seconds": time.monotonic() - call_started,
                        }
                    )
    save(
        args.output / "jobs.json",
        {
            "jobs": jobs,
            "seconds": time.monotonic() - started,
            "pymupdf_version": pymupdf.__version__,
            "padding_points": args.padding,
            "render_max_edge": args.max_edge,
            "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
    )
    print(json.dumps({"jobs": len(jobs), "seconds": time.monotonic() - started}))


def prepare(baseline: Path, root: Path) -> None:
    import pymupdf

    corpus = json.loads((baseline / "corpus.json").read_text())
    evaluation = json.loads((baseline / "evaluation.json").read_text())
    (root / "images").mkdir(parents=True, exist_ok=True)
    jobs = []
    for entry in corpus["entries"]:
        if entry["suite"] != "screen":
            continue
        pdf_path = baseline / entry["pdf"]
        with pymupdf.open(pdf_path) as document:
            for index, page in enumerate(document):
                started = time.monotonic()
                path = root / "images" / f"{entry['id']}__p{index + 1}.png"
                matrix = pymupdf.Matrix(
                    2560 / max(page.rect.width, page.rect.height),
                    2560 / max(page.rect.width, page.rect.height),
                )
                page.get_pixmap(matrix=matrix, alpha=False).save(path)
                jobs.append(
                    {
                        "id": f"page-{entry['id']}-p{index + 1}",
                        "kind": "page",
                        "case": entry["id"],
                        "page": index,
                        "source_page": entry["source_pages"][index],
                        "lang": entry["lang"],
                        "image": str(path.resolve()),
                        "image_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "pdf_sha256": entry["pdf_sha256"],
                        "bbox": [0, 0, 1000, 1000],
                        "render_seconds": time.monotonic() - started,
                    }
                )
    for run, label in [
        ("screen-odl-java-cluster", "java"),
        ("screen-mineru-auto", "mineru"),
    ]:
        for record in evaluation["records"]:
            if record["run"] != run:
                continue
            directory = baseline / "results" / run / record["case"]
            blocks = json.loads((directory / "content_list.json").read_text())
            occurrences = {}
            for block in blocks:
                if block.get("type") not in {"image", "chart"}:
                    continue
                path = directory / block["img_path"]
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                occurrences.setdefault(digest, []).append(
                    {
                        "page": block["page_idx"],
                        "bbox": block["bbox"],
                        "img_path": block["img_path"],
                    }
                )
            for index, relative in enumerate(record["captionable_paths"]):
                path = baseline / "results" / run / record["case"] / relative
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                jobs.append(
                    {
                        "id": f"{label}-{record['case']}-{index}",
                        "kind": label,
                        "case": record["case"],
                        "image": str(path.resolve()),
                        "image_sha256": digest,
                        "pdf_sha256": record["input_sha256"],
                        "occurrences": occurrences[digest],
                        "render_seconds": 0,
                    }
                )
    save(root / "jobs.json", {"pymupdf_version": pymupdf.__version__, "jobs": jobs})
    print(
        json.dumps(
            {
                "jobs": len(jobs),
                "by_kind": {
                    kind: sum(j["kind"] == kind for j in jobs)
                    for kind in ["page", "java", "mineru"]
                },
            }
        )
    )


def encode(path: Path, max_edge: int) -> tuple[bytes, tuple[int, int]]:
    with Image.open(path) as image:
        image.load()
        if image.mode in ("RGBA", "LA", "P"):
            image = image.convert("RGBA")
            flattened = Image.new("RGB", image.size, "white")
            flattened.paste(image, mask=image.split()[-1])
            image = flattened
        else:
            image = image.convert("RGB")
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=80, optimize=True)
        return buffer.getvalue(), image.size


async def captions(args: argparse.Namespace) -> None:
    import httpx
    from dotenv import dotenv_values

    image_prompt = args.prompt_file.read_text()
    provider = (
        json.loads(args.provider_config.read_text())
        if args.provider_config
        else {
            "endpoint": "https://api.deepinfra.com/v1/openai/chat/completions",
            "key_env": "DEEPINFRA_API_KEY",
            "body": {
                "model": "zai-org/GLM-5.3-Flash",
                "reasoning_effort": "low",
                "max_tokens": 8192,
            },
        }
    )
    if not provider["endpoint"].startswith("https://") or any(
        field in provider["body"] for field in ["messages", "tools", "stream"]
    ):
        raise ValueError(
            "provider config must use HTTPS and synchronous image-only requests"
        )
    key = dotenv_values(args.key_env).get(provider["key_env"])
    if not key:
        raise ValueError("the configured provider credential is required")
    jobs = [
        j for j in json.loads(args.jobs.read_text())["jobs"] if j["kind"] in args.kinds
    ]
    if len({job["id"] for job in jobs}) != len(jobs):
        raise ValueError("duplicate caption job IDs")
    if args.ids:
        jobs = [j for j in jobs if j["id"] in args.ids]
        if len(jobs) != len(set(args.ids)):
            raise ValueError("one or more requested job IDs are absent")
    if not jobs or len(jobs) > args.request_limit:
        raise ValueError("job count is empty or exceeds the explicit request limit")
    args.output.mkdir(parents=True, exist_ok=False)
    run = {
        **provider["body"],
        "endpoint": provider["endpoint"],
        "request_options": provider["body"],
        "max_edge": args.max_edge,
        "concurrency": args.concurrency,
        "request_limit": args.request_limit,
        "jobs": jobs,
        "prompt": image_prompt,
        "prompt_sha256": hashlib.sha256(image_prompt.encode()).hexdigest(),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "host": platform.platform(),
        "started_unix": time.time(),
    }
    save(args.output / "run.json", run)
    run_hash = hashlib.sha256((args.output / "run.json").read_bytes()).hexdigest()
    (args.output / "runner.py.snapshot").write_bytes(Path(__file__).read_bytes())
    semaphore = asyncio.Semaphore(args.concurrency)
    started = time.monotonic()
    async with httpx.AsyncClient(
        timeout=180, limits=httpx.Limits(max_connections=args.concurrency)
    ) as client:

        async def one(job):
            async with semaphore:
                call_started = time.monotonic()
                record = {
                    "job": job["id"],
                    "state": "error",
                    "run_sha256": run_hash,
                    "image_sha256": job["image_sha256"],
                    "pdf_sha256": job["pdf_sha256"],
                    "started_unix": time.time(),
                }
                try:
                    path = Path(job["image"])
                    if (
                        hashlib.sha256(path.read_bytes()).hexdigest()
                        != job["image_sha256"]
                    ):
                        raise ValueError("image hash mismatch")
                    data, size = encode(path, args.max_edge)
                    record.update(
                        encoded_sha256=hashlib.sha256(data).hexdigest(),
                        encoded_bytes=len(data),
                        encoded_size=size,
                    )
                    response = await client.post(
                        run["endpoint"],
                        headers={"Authorization": f"Bearer {key}"},
                        json={
                            **provider["body"],
                            "messages": [
                                {
                                    "role": "user",
                                    "content": [
                                        {"type": "text", "text": image_prompt},
                                        {
                                            "type": "image_url",
                                            "image_url": {
                                                "url": "data:image/jpeg;base64,"
                                                + base64.b64encode(data).decode()
                                            },
                                        },
                                    ],
                                }
                            ],
                        },
                    )
                    record["http_status"] = response.status_code
                    body = json.loads(response.text.replace(key, "[REDACTED]"))
                    record["response"] = body
                    response.raise_for_status()
                    record["actual_model"] = body.get("model")
                    if record["actual_model"] != run["model"]:
                        raise ValueError("response model differs from requested model")
                    choice = body["choices"][0]
                    record.update(
                        text=choice["message"]["content"],
                        finish_reason=choice.get("finish_reason"),
                        usage=body.get("usage"),
                    )
                    record["state"] = (
                        "ok"
                        if record["text"] and record["finish_reason"] == "stop"
                        else "incomplete"
                    )
                except (
                    httpx.HTTPError,
                    OSError,
                    ValueError,
                    KeyError,
                    IndexError,
                    TypeError,
                ) as exc:
                    # Never include request headers or the image payload in errors.
                    record["error_type"] = type(exc).__name__
                record["seconds"] = time.monotonic() - call_started
                save(args.output / f"{job['id']}.json", record)
                print(
                    job["id"], record["state"], round(record["seconds"], 3), flush=True
                )
                return record

        records = await asyncio.gather(*(one(job) for job in jobs))
    save(
        args.output / "complete.json",
        {
            "seconds": time.monotonic() - started,
            "requests": len(records),
            "ok": sum(r["state"] == "ok" for r in records),
        },
    )


def ocr(args: argparse.Namespace) -> None:
    import numpy
    from compare_opendataloader import Sampler
    from rapidocr import RapidOCR

    jobs = [
        j for j in json.loads(args.jobs.read_text())["jobs"] if j["kind"] in args.kinds
    ]
    if len({job["id"] for job in jobs}) != len(jobs):
        raise ValueError("duplicate OCR job IDs")
    if args.ids:
        jobs = [j for j in jobs if j["id"] in args.ids]
        if len(jobs) != len(set(args.ids)):
            raise ValueError("one or more requested job IDs are absent")
    if not jobs:
        raise ValueError("no OCR jobs selected")
    args.output.mkdir(parents=True, exist_ok=False)
    model_files = {
        "Det": args.models / "PP-OCRv6_det_small.onnx",
        "Rec": args.models / "PP-OCRv6_rec_small.onnx",
        "Cls": args.models / "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    }
    for path in model_files.values():
        if not path.is_file():
            raise ValueError(f"missing pinned model file: {path.name}")
    params = {
        **{f"{task}.model_path": str(path) for task, path in model_files.items()},
        "EngineConfig.onnxruntime.intra_op_num_threads": args.threads,
        "EngineConfig.onnxruntime.use_cuda": False,
        "Global.text_score": 0.5,
    }
    run = {
        "jobs": jobs,
        "max_edge": args.max_edge,
        "threads": args.threads,
        "params": params,
        "models": {
            task: {
                "name": path.name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for task, path in model_files.items()
        },
        "rapidocr_version": importlib.metadata.version("rapidocr"),
        "onnxruntime_version": importlib.metadata.version("onnxruntime"),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "environment": {
            name: os.environ.get(name)
            for name in ["OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"]
        },
        "started_unix": time.time(),
    }
    save(args.output / "run.json", run)
    (args.output / "runner.py.snapshot").write_bytes(Path(__file__).read_bytes())
    sampler = Sampler(args.output / "resources.csv")
    run_hash = hashlib.sha256((args.output / "run.json").read_bytes()).hexdigest()
    sampler.thread.start()
    started = time.monotonic()
    try:
        reader = RapidOCR(params=params)
        load_seconds = time.monotonic() - started
        ok = 0
        for job in jobs:
            call_started = time.monotonic()
            record = {
                "job": job["id"],
                "state": "error",
                "run_sha256": run_hash,
                "image_sha256": job["image_sha256"],
                "pdf_sha256": job["pdf_sha256"],
            }
            try:
                path = Path(job["image"])
                if hashlib.sha256(path.read_bytes()).hexdigest() != job["image_sha256"]:
                    raise ValueError("image hash mismatch")
                with Image.open(path) as source:
                    image = source.convert("RGB")
                    image.thumbnail(
                        (args.max_edge, args.max_edge), Image.Resampling.LANCZOS
                    )
                    record["size"] = image.size
                    result = reader(numpy.asarray(image))
                lines = []
                if result.boxes is not None:
                    lines = [
                        {"box": box.tolist(), "text": text, "score": float(score)}
                        for box, text, score in zip(
                            result.boxes, result.txts, result.scores
                        )
                    ]
                record.update(
                    state="ok",
                    lines=lines,
                    text="\n".join(line["text"] for line in lines),
                )
                ok += 1
            except Exception as exc:  # noqa: BLE001 - retain each native-engine failure as a benchmark result
                record.update(error_type=type(exc).__name__, error=str(exc))
            record["seconds"] = time.monotonic() - call_started
            save(args.output / f"{job['id']}.json", record)
            print(job["id"], record["state"], round(record["seconds"], 3), flush=True)
    finally:
        sampler.stop.set()
        sampler.thread.join()
    save(
        args.output / "complete.json",
        {
            "seconds": time.monotonic() - started,
            "model_load_seconds": load_seconds,
            "requests": len(jobs),
            "ok": ok,
            "peak_memory_bytes": sampler.peak_memory,
            "peak_swap_bytes": sampler.peak_swap,
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("baseline", type=Path)
    prepare_parser.add_argument("root", type=Path)
    layout_parser = commands.add_parser("layout-ocr")
    layout_parser.add_argument("baseline", type=Path)
    layout_parser.add_argument("ocr_run", type=Path)
    layout_parser.add_argument("output", type=Path)
    region_parser = commands.add_parser("regions")
    region_parser.add_argument("baseline", type=Path)
    region_parser.add_argument("inventory", type=Path)
    region_parser.add_argument("output", type=Path)
    region_parser.add_argument(
        "--suite", choices=["screen", "full", "long"], required=True
    )
    region_parser.add_argument("--padding", type=float, required=True)
    region_parser.add_argument("--max-edge", type=int, required=True)
    context_parser = commands.add_parser("context-pages")
    context_parser.add_argument("baseline", type=Path)
    context_parser.add_argument("inventory", type=Path)
    context_parser.add_argument("output", type=Path)
    context_parser.add_argument(
        "--suite", choices=["screen", "full", "long"], required=True
    )
    context_parser.add_argument("--max-edge", type=int, required=True)
    context_parser.add_argument(
        "--native-run", help="Exact saved native run to inspect"
    )
    context_parser.add_argument("--ocr-run", type=Path)
    context_parser.add_argument("--ocr-image-root", type=Path)
    context_parser.add_argument("--ocr-binding", type=Path)
    context_parser.add_argument("--repaired-encoding", action="store_true")
    caption_parser = commands.add_parser("caption")
    caption_parser.add_argument("jobs", type=Path)
    caption_parser.add_argument("output", type=Path)
    caption_parser.add_argument("--key-env", type=Path, required=True)
    caption_parser.add_argument("--provider-config", type=Path)
    caption_parser.add_argument("--prompt-file", type=Path, required=True)
    caption_parser.add_argument(
        "--kinds",
        nargs="+",
        choices=["page", "java", "mineru", "region"],
        required=True,
    )
    caption_parser.add_argument("--ids", nargs="+")
    caption_parser.add_argument("--max-edge", type=int, required=True)
    caption_parser.add_argument("--concurrency", type=int, required=True)
    caption_parser.add_argument("--request-limit", type=int, required=True)
    ocr_parser = commands.add_parser("ocr")
    ocr_parser.add_argument("jobs", type=Path)
    ocr_parser.add_argument("output", type=Path)
    ocr_parser.add_argument(
        "--kinds",
        nargs="+",
        choices=["page", "java", "mineru", "region"],
        required=True,
    )
    ocr_parser.add_argument("--ids", nargs="+")
    ocr_parser.add_argument("--models", type=Path, required=True)
    ocr_parser.add_argument("--max-edge", type=int, required=True)
    ocr_parser.add_argument("--threads", type=int, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.baseline, args.root)
    elif args.command == "caption":
        asyncio.run(captions(args))
    elif args.command == "regions":
        regions(args)
    elif args.command == "context-pages":
        page_contexts(args)
    elif args.command == "layout-ocr":
        layout_ocr(args)
    else:
        ocr(args)


if __name__ == "__main__":
    main()
