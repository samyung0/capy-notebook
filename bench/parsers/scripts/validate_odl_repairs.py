#!/usr/bin/env python3
"""Freeze and audit the source-family ODL repair validation set.

The ``freeze`` command reads only the staged publisher PDFs and source renders.
It never downloads a file or invokes a parser.  ``baseline`` is a separate,
explicit command that runs the pinned OpenDataLoader Java CLI and records raw
outputs and rejection receipts.  Raster controls reuse source-page gold and do
not count as independent examples.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from collections.abc import Iterable
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = (
    REPO_ROOT / "bench/parsers/fixtures/odl-repair-validation-2026-09-13.json"
)
DEFAULT_RUN_ROOT = (
    REPO_ROOT / "bench/parsers/reports/local/2026-09-13-odl-repair-validation"
)
DEFAULT_JAR = Path(
    "/private/tmp/capy-odl-quality-20260913/py312/lib/python3.12/"
    "site-packages/opendataloader_pdf/jar/opendataloader-pdf-cli.jar"
)

# This is the production parser's Java invocation, copied into the receipt so
# a raw flag-matched arm can be replayed without importing production code.
PRODUCTION_ODL_FLAGS = (
    "--format",
    "json,markdown",
    "--image-output",
    "external",
    "--markdown-with-html",
    "--threads",
    "1",
    "--table-method",
    "cluster",
    "--include-header-footer",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT.resolve()))
    except ValueError:
        return str(path)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def norm(value: str) -> str:
    value = value.casefold()
    value = value.replace("−", "-").replace("–", "-").replace("—", "-")
    value = value.replace("×", "x").replace("μ", "u").replace("µ", "u")
    return re.sub(r"[^\w]+", " ", value, flags=re.UNICODE).strip()


def strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from strings(key)
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def text_stream(value: Any) -> str:
    return "\n".join(strings(value))


def count_inversions(expected: list[str], observed: list[str]) -> int:
    positions = {value: index for index, value in enumerate(expected)}
    values = [positions[value] for value in observed if value in positions]
    return sum(
        left > right
        for index, left in enumerate(values)
        for right in values[index + 1 :]
    )


def resolve_under(root: Path, relative: str) -> Path:
    path = (root / relative).resolve()
    if root.resolve() not in path.parents and path != root.resolve():
        raise ValueError(f"path escapes run root: {relative}")
    return path


def load_fixture(path: Path) -> dict[str, Any]:
    fixture = read_json(path)
    if not isinstance(fixture, dict):
        raise TypeError("fixture must be an object")
    return fixture


def validate_shape(fixture: dict[str, Any], run_root: Path) -> dict[str, Any]:
    sources = fixture.get("sources")
    pages = fixture.get("pages")
    if not isinstance(sources, list) or not isinstance(pages, list):
        raise TypeError("fixture needs sources and pages arrays")

    source_by_id: dict[str, dict[str, Any]] = {}
    families: set[str] = set()
    for source in sources:
        source_id = source.get("id")
        family = source.get("publisher_family")
        if not source_id or source_id in source_by_id:
            raise ValueError(f"duplicate or missing source id: {source_id!r}")
        if not family or family in families:
            raise ValueError(f"duplicate or missing publisher family: {family!r}")
        source_by_id[source_id] = source
        families.add(family)
        resolve_under(run_root, source["local_pdf"])

    expected_page_ids = {
        f"{source_id}-p{page:02d}"
        for source_id, source in source_by_id.items()
        for page in source["selected_pages"]
    }
    page_by_id: dict[str, dict[str, Any]] = {}
    for page in pages:
        page_id = page.get("id")
        source_id = page.get("source")
        native_page = page.get("native_page")
        if not page_id or page_id in page_by_id:
            raise ValueError(f"duplicate or missing page id: {page_id!r}")
        if source_id not in source_by_id:
            raise ValueError(f"unknown page source: {source_id!r}")
        if page_id not in expected_page_ids:
            raise ValueError(f"page is not selected in its source: {page_id}")
        if (
            not isinstance(native_page, int)
            or not 1 <= native_page <= source_by_id[source_id]["native_pages"]
        ):
            raise ValueError(f"invalid native page for {page_id}")
        region_ids = {region["id"] for region in page.get("regions", [])}
        order = page.get("reading_order", [])
        if not region_ids or set(order) != region_ids or len(order) != len(region_ids):
            raise ValueError(f"reading_order does not cover regions on {page_id}")
        for region in page["regions"]:
            box = region.get("bbox")
            if (
                not isinstance(box, list)
                or len(box) != 4
                or any(
                    not isinstance(number, (int, float)) or not 0 <= number <= 1000
                    for number in box
                )
                or box[0] >= box[2]
                or box[1] >= box[3]
            ):
                raise ValueError(f"invalid 0-1000 bbox on {page_id}: {box!r}")
        for anchor in page.get("anchors", []):
            if anchor.get("region") not in region_ids:
                raise ValueError(f"anchor points at unknown region on {page_id}")
        for table in page.get("tables", []):
            checked = table.get("checked_rows", [])
            if table.get("source_row_count", 0) < len(checked):
                raise ValueError(f"checked rows exceed source rows in {table['id']}")
        page_by_id[page_id] = page

    if set(page_by_id) != expected_page_ids:
        missing = sorted(expected_page_ids - set(page_by_id))
        extra = sorted(set(page_by_id) - expected_page_ids)
        raise ValueError(f"selected page mismatch; missing={missing}, extra={extra}")

    selected_count = len(pages)
    native_pages = sum(source["native_pages"] for source in sources)
    checked_rows = sum(
        len(table.get("checked_rows", []))
        for page in pages
        for table in page.get("tables", [])
    )
    page_budget = fixture["protocol"]["selected_page_budget"]
    row_budget = fixture["protocol"]["table_row_target"]
    if not page_budget[0] <= selected_count <= page_budget[1]:
        raise ValueError(
            f"selected page count {selected_count} outside budget {page_budget}"
        )
    if not row_budget[0] <= checked_rows <= row_budget[1]:
        raise ValueError(
            f"checked table row count {checked_rows} outside budget {row_budget}"
        )
    if native_pages > fixture["protocol"]["native_page_budget"]:
        raise ValueError(f"native page count {native_pages} exceeds budget")

    raster_ids: set[str] = set()
    for raster in fixture.get("raster_controls", []):
        raster_id = raster.get("id")
        if not raster_id or raster_id in raster_ids:
            raise ValueError(f"duplicate or missing raster id: {raster_id!r}")
        raster_ids.add(raster_id)
        if raster.get("source") not in source_by_id:
            raise ValueError(f"unknown raster source: {raster.get('source')!r}")
        gold_page = raster.get("gold_page")
        if gold_page not in page_by_id:
            raise ValueError(f"raster gold page is not selected: {gold_page!r}")
        if raster["source_page"] != page_by_id[gold_page]["native_page"]:
            raise ValueError(f"raster source page differs from gold page: {raster_id}")
        resolve_under(run_root, raster["local_pdf"])
        resolve_under(run_root, raster["derived_from_png"])

    page_ids = set(page_by_id)
    table_ids = {table["id"] for page in pages for table in page.get("tables", [])}
    negative_count = 0
    for negative in fixture.get("negative_cases", []):
        if negative.get("base_page") not in page_ids:
            raise ValueError(f"negative case points at unknown page: {negative}")
        if negative.get("table") and negative["table"] not in table_ids:
            raise ValueError(f"negative case points at unknown table: {negative}")
        negative_count += 1

    return {
        "source_count": len(sources),
        "publisher_family_count": len(families),
        "native_pages": native_pages,
        "selected_source_pages": selected_count,
        "checked_table_rows": checked_rows,
        "raster_controls": len(raster_ids),
        "negative_cases": negative_count,
        "source_by_id": source_by_id,
        "page_by_id": page_by_id,
    }


def scan_existing_manifests(
    fixture: dict[str, Any], source_by_id: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    records = []
    needles = [
        needle
        for source in source_by_id.values()
        for needle in (source["landing_url"], source["pdf_url"], source["sha256"])
    ]
    for manifest_name in fixture.get("existing_manifest_paths", []):
        path = REPO_ROOT / manifest_name
        if not path.is_file():
            raise FileNotFoundError(f"existing manifest is missing: {manifest_name}")
        data = read_json(path)
        content = set(strings(data))
        matches = [needle for needle in needles if needle in content]
        records.append(
            {
                "path": manifest_name,
                "sha256": sha256(path),
                "candidate_url_or_hash_matches": matches,
            }
        )
    if any(record["candidate_url_or_hash_matches"] for record in records):
        raise ValueError(
            "a selected source URL or hash already occurs in an existing manifest"
        )
    return records


def source_pdf_record(source: dict[str, Any], run_root: Path) -> dict[str, Any]:
    path = resolve_under(run_root, source["local_pdf"])
    if not path.is_file():
        raise FileNotFoundError(f"staged source PDF is missing: {path}")
    actual_hash = sha256(path)
    actual_bytes = path.stat().st_size
    if actual_hash != source["sha256"] or actual_bytes != source["bytes"]:
        raise ValueError(
            f"source hash/size mismatch for {source['id']}: "
            f"expected {source['sha256']}/{source['bytes']}, "
            f"got {actual_hash}/{actual_bytes}"
        )
    try:
        import pymupdf
    except ImportError:  # pragma: no cover - runtime-specific fallback
        import fitz as pymupdf
    document = pymupdf.open(path)
    page_count = len(document)
    document.close()
    if page_count != source["native_pages"]:
        raise ValueError(f"page count mismatch for {source['id']}: {page_count}")
    return {
        "id": source["id"],
        "local_pdf": rel(path),
        "bytes": actual_bytes,
        "sha256": actual_hash,
        "native_pages": page_count,
    }


def source_render_records(
    fixture: dict[str, Any], run_root: Path, page_by_id: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    records = []
    for page in fixture["pages"]:
        path = resolve_under(run_root, page["source_png"])
        if not path.is_file():
            raise FileNotFoundError(f"source render is missing: {path}")
        try:
            from PIL import Image
        except ImportError as error:  # pragma: no cover - runtime-specific
            raise RuntimeError(
                "freeze needs Pillow to inspect source render dimensions"
            ) from error
        with Image.open(path) as image:
            width, height = image.size
            image_format = image.format
        if max(width, height) != 2560:
            raise ValueError(f"source render {path} does not have max edge 2560")
        records.append(
            {
                "id": page["id"],
                "source": page["source"],
                "native_page": page["native_page"],
                "path": rel(path),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
                "width": width,
                "height": height,
                "format": image_format,
                "gold_viewed_before_parser_output": True,
            }
        )
    return records


def raster_records(
    fixture: dict[str, Any],
    run_root: Path,
    source_by_id: dict[str, dict[str, Any]],
    page_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    try:
        import pymupdf
    except ImportError:  # pragma: no cover - runtime-specific fallback
        import fitz as pymupdf
    records = []
    for raster in fixture.get("raster_controls", []):
        path = resolve_under(run_root, raster["local_pdf"])
        if not path.is_file():
            raise FileNotFoundError(f"raster control is missing: {path}")
        actual_hash = sha256(path)
        if actual_hash != raster["sha256"] or path.stat().st_size != raster["bytes"]:
            raise ValueError(f"raster hash/size mismatch for {raster['id']}")
        document = pymupdf.open(path)
        page_count = len(document)
        page_rect = (
            [round(value, 3) for value in document[0].rect] if page_count else []
        )
        document.close()
        source = source_by_id[raster["source"]]
        source_path = resolve_under(run_root, source["local_pdf"])
        source_document = pymupdf.open(source_path)
        source_rect = [
            round(value, 3) for value in source_document[raster["source_page"] - 1].rect
        ]
        source_document.close()
        if page_count != raster["page_count"] or page_rect != source_rect:
            raise ValueError(f"raster page geometry mismatch for {raster['id']}")
        png_path = resolve_under(run_root, raster["derived_from_png"])
        records.append(
            {
                "id": raster["id"],
                "source": raster["source"],
                "source_page": raster["source_page"],
                "gold_page": raster["gold_page"],
                "local_pdf": rel(path),
                "derived_from_png": rel(png_path),
                "bytes": path.stat().st_size,
                "sha256": actual_hash,
                "page_count": page_count,
                "page_rect": page_rect,
                "max_edge": raster["max_edge"],
                "independent_example": False,
            }
        )
    return records


def negative_results(
    fixture: dict[str, Any], page_by_id: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    results = []
    for negative in fixture.get("negative_cases", []):
        page = page_by_id[negative["base_page"]]
        if negative["operation"] == "swap_checked_rows":
            table = next(
                table for table in page["tables"] if table["id"] == negative["table"]
            )
            rows = table.get("checked_rows", [])
            indices = negative["indices"]
            if len(rows) <= max(indices):
                raise ValueError(
                    f"negative row swap has no checked rows: {negative['id']}"
                )
            swapped = list(range(len(rows)))
            swapped[indices[0]], swapped[indices[1]] = (
                swapped[indices[1]],
                swapped[indices[0]],
            )
            observed = [str(index) for index in swapped]
            expected = [str(index) for index in range(len(rows))]
        elif negative["operation"] == "swap_regions":
            expected = page["reading_order"]
            observed = list(expected)
            indices = negative["region_indices"]
            if len(observed) <= max(indices):
                raise ValueError(
                    f"negative region swap has no regions: {negative['id']}"
                )
            observed[indices[0]], observed[indices[1]] = (
                observed[indices[1]],
                observed[indices[0]],
            )
        else:
            raise ValueError(f"unknown negative operation: {negative['operation']}")
        wrong_pairs = count_inversions(expected, observed)
        results.append(
            {
                "id": negative["id"],
                "base_page": negative["base_page"],
                "operation": negative["operation"],
                "wrong_pairs": wrong_pairs,
                "expected_min_wrong_pairs": negative["expected_min_wrong_pairs"],
                "passed": wrong_pairs >= negative["expected_min_wrong_pairs"],
            }
        )
    if not all(result["passed"] for result in results):
        raise ValueError("a deliberate negative permutation was not detected")
    return results


def freeze(args: argparse.Namespace) -> int:
    fixture_path = args.fixture.resolve()
    run_root = args.run_root.resolve()
    fixture = load_fixture(fixture_path)
    shape = validate_shape(fixture, run_root)
    source_records = [
        source_pdf_record(source, run_root) for source in fixture["sources"]
    ]
    manifest_records = scan_existing_manifests(fixture, shape["source_by_id"])
    render_records = source_render_records(fixture, run_root, shape["page_by_id"])
    control_records = raster_records(
        fixture, run_root, shape["source_by_id"], shape["page_by_id"]
    )
    negatives = negative_results(fixture, shape["page_by_id"])
    fixture_hash = sha256(fixture_path)
    script_hash = sha256(Path(__file__).resolve())
    freeze_dir = run_root / "freeze"
    receipt = {
        "schema_version": 1,
        "kind": "source-gold-freeze",
        "frozen_at_utc": utc_now(),
        "fixture": {"path": rel(fixture_path), "sha256": fixture_hash},
        "script": {"path": rel(Path(__file__).resolve()), "sha256": script_hash},
        "protocol": fixture["protocol"],
        "selection": {
            "source_count": shape["source_count"],
            "publisher_family_count": shape["publisher_family_count"],
            "native_pages": shape["native_pages"],
            "selected_source_pages": shape["selected_source_pages"],
            "checked_table_rows": shape["checked_table_rows"],
            "raster_controls": shape["raster_controls"],
            "negative_cases": shape["negative_cases"],
        },
        "source_pdfs": source_records,
        "source_renders": render_records,
        "raster_controls": control_records,
        "existing_manifest_scan": manifest_records,
        "negative_results": negatives,
        "parser_outputs_viewed_before_freeze": False,
        "baseline_status": "not-run",
        "candidate_status": "not-run",
    }
    write_json(freeze_dir / "frozen.json", receipt)
    shutil.copy2(fixture_path, freeze_dir / "fixture.json")
    shutil.copy2(Path(__file__).resolve(), freeze_dir / "validate_odl_repairs.py")
    write_json(
        freeze_dir / "rejection-receipt.json",
        {
            "schema_version": 1,
            "kind": "source-selection-rejection-receipt",
            "fixture_sha256": fixture_hash,
            "rejected_sources": [],
            "rejected_pages": [],
            "reason": (
                "No source or page was rejected after hash, page-count, render, "
                "manifest, and shape checks."
            ),
            "parser_outputs_viewed": False,
        },
    )
    print(
        json.dumps(
            {
                "status": "frozen",
                "fixture_sha256": fixture_hash,
                "sources": shape["source_count"],
                "native_pages": shape["native_pages"],
                "selected_source_pages": shape["selected_source_pages"],
                "checked_table_rows": shape["checked_table_rows"],
                "raster_controls": shape["raster_controls"],
                "negative_cases": shape["negative_cases"],
                "receipt": rel(freeze_dir / "frozen.json"),
            },
            ensure_ascii=False,
        )
    )
    return 0


def verify_freeze(
    fixture_path: Path, run_root: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    receipt_path = run_root / "freeze/frozen.json"
    if not receipt_path.is_file():
        raise FileNotFoundError("run freeze before baseline")
    receipt = read_json(receipt_path)
    if receipt["fixture"]["sha256"] != sha256(fixture_path):
        raise ValueError("fixture changed after freeze")
    if receipt["script"]["sha256"] != sha256(Path(__file__).resolve()):
        raise ValueError("validation script changed after freeze")
    return load_fixture(fixture_path), receipt


def find_native_json(target: Path, stem: str) -> Path | None:
    preferred = target / f"{stem}.json"
    if preferred.is_file():
        return preferred
    candidates = sorted(
        path for path in target.glob("*.json") if path.name != "run.json"
    )
    return candidates[0] if len(candidates) == 1 else None


def probe_native(
    native: Any,
    fixture_pages: list[dict[str, Any]],
    fixture_tables: list[dict[str, Any]],
) -> dict[str, Any]:
    stream = text_stream(native)
    normalized_stream = norm(stream)
    anchors = []
    for page in fixture_pages:
        positions = []
        missing = []
        for anchor in page.get("anchors", []):
            needle = norm(anchor["text"])
            position = normalized_stream.find(needle)
            if position < 0:
                missing.append(anchor["text"])
            else:
                positions.append(position)
        anchors.append(
            {
                "page": page["id"],
                "scope": "raw-document-text-stream",
                "missing": missing,
                "present": len(missing) == 0,
                "anchor_positions_monotonic": positions == sorted(positions),
            }
        )
    rows = []
    for table in fixture_tables:
        for index, row in enumerate(table.get("checked_rows", [])):
            cell_presence = [norm(cell) in normalized_stream for cell in row]
            rows.append(
                {
                    "table": table["id"],
                    "row_index": index,
                    "scope": "raw-document-text-stream",
                    "cells_present": cell_presence,
                    "all_cells_present": all(cell_presence),
                }
            )
    return {
        "anchor_probes": anchors,
        "checked_row_cell_probes": rows,
        "scope_warning": (
            "These probes search the raw document stream. They do not prove page "
            "assignment, cell association, or end-to-end chunk quality."
        ),
    }


def run_baseline(args: argparse.Namespace) -> int:
    fixture_path = args.fixture.resolve()
    run_root = args.run_root.resolve()
    fixture, _ = verify_freeze(fixture_path, run_root)
    jar = args.jar.resolve()
    if not jar.is_file():
        raise FileNotFoundError(f"Java CLI jar is missing: {jar}")
    run_name = args.run_name
    output_root = run_root / "baseline" / run_name
    if output_root.exists():
        raise FileExistsError(f"baseline output already exists: {output_root}")
    output_root.mkdir(parents=True)
    jar_record = {"path": str(jar), "sha256": sha256(jar), "bytes": jar.stat().st_size}
    run_record: dict[str, Any] = {
        "schema_version": 1,
        "kind": "raw-java-baseline",
        "output_version": "raw-java-baseline-v1",
        "started_at_utc": utc_now(),
        "run_name": run_name,
        "fixture": {"path": rel(fixture_path), "sha256": sha256(fixture_path)},
        "freeze_receipt_sha256": sha256(run_root / "freeze/frozen.json"),
        "script_sha256": sha256(Path(__file__).resolve()),
        "java": {"binary": args.java_bin, "jar": jar_record, "threads": args.threads},
        "sources": [],
    }
    rejections: list[dict[str, Any]] = []
    for source in fixture["sources"]:
        source_path = resolve_under(run_root, source["local_pdf"])
        target = output_root / source["id"]
        target.mkdir()
        command = [
            args.java_bin,
            "-jar",
            str(jar),
            str(source_path),
            "--output-dir",
            str(target),
            "--format",
            "json,markdown",
            "--image-output",
            "external",
            "--markdown-with-html",
            "--threads",
            str(args.threads),
        ]
        started = time.monotonic()
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=args.timeout, check=False
        )
        elapsed = time.monotonic() - started
        (target / "stdout.log").write_text(completed.stdout, encoding="utf-8")
        (target / "stderr.log").write_text(completed.stderr, encoding="utf-8")
        native_path = find_native_json(target, Path(source["local_pdf"]).stem)
        result: dict[str, Any] = {
            "id": source["id"],
            "source_pdf": rel(source_path),
            "command": command,
            "exit_code": completed.returncode,
            "elapsed_seconds": elapsed,
            "native_json": rel(native_path) if native_path else None,
            "output_files": sorted(
                rel(path) for path in target.rglob("*") if path.is_file()
            ),
        }
        if completed.returncode != 0 or native_path is None:
            rejection = {
                "source": source["id"],
                "exit_code": completed.returncode,
                "reason": "java_cli_failed"
                if completed.returncode
                else "native_json_missing",
                "stderr_tail": completed.stderr[-2000:],
            }
            rejections.append(rejection)
            result["status"] = "rejected"
        else:
            native = read_json(native_path)
            result["status"] = "completed"
            result["native_json_sha256"] = sha256(native_path)
            result["native_json_bytes"] = native_path.stat().st_size
            result["native_keys"] = (
                sorted(native.keys()) if isinstance(native, dict) else []
            )
            result["probe"] = probe_native(
                native,
                [page for page in fixture["pages"] if page["source"] == source["id"]],
                [
                    table
                    for page in fixture["pages"]
                    if page["source"] == source["id"]
                    for table in page.get("tables", [])
                ],
            )
        run_record["sources"].append(result)

    run_record["finished_at_utc"] = utc_now()
    run_record["completed_sources"] = sum(
        item["status"] == "completed" for item in run_record["sources"]
    )
    run_record["rejected_sources"] = len(rejections)
    results_path = run_root / "results" / f"{run_name}.json"
    write_json(results_path, run_record)
    write_json(
        run_root / "rejections" / f"{run_name}.json",
        {
            "schema_version": 1,
            "kind": "raw-java-baseline-rejection-receipt",
            "run_name": run_name,
            "fixture_sha256": sha256(fixture_path),
            "freeze_receipt_sha256": sha256(run_root / "freeze/frozen.json"),
            "rejections": rejections,
        },
    )
    print(
        json.dumps(
            {
                "status": "baseline-complete"
                if not rejections
                else "baseline-with-rejections",
                "run_name": run_name,
                "completed_sources": run_record["completed_sources"],
                "rejected_sources": len(rejections),
                "results": rel(results_path),
            }
        )
    )
    return 0 if not rejections else 2


def run_matched_baseline(args: argparse.Namespace) -> int:
    """Run raw Java with the production parser's frozen invocation flags.

    This arm is deliberately separate from ``baseline``: the original raw
    receipt used the minimal CLI invocation and remains immutable evidence.
    The matched arm uses the frozen source/gold and the production Java flags,
    but still adapts and packs only during the later score command.
    """
    fixture_path = args.fixture.resolve()
    run_root = args.run_root.resolve()
    fixture, freeze_receipt, shape = verify_candidate_freeze(fixture_path, run_root)
    jar = args.jar.resolve()
    if not jar.is_file():
        raise FileNotFoundError(f"Java CLI jar is missing: {jar}")
    run_name = args.run_name
    output_root = run_root / "baseline" / run_name
    if output_root.exists():
        raise FileExistsError(f"baseline output already exists: {output_root}")
    output_root.mkdir(parents=True)
    jar_record = {"path": str(jar), "sha256": sha256(jar), "bytes": jar.stat().st_size}
    run_record: dict[str, Any] = {
        "schema_version": 1,
        "kind": "production-java-matched-baseline",
        "output_version": "raw-java-production-flags-v1",
        "started_at_utc": utc_now(),
        "run_name": run_name,
        "fixture": {"path": rel(fixture_path), "sha256": sha256(fixture_path)},
        "freeze_receipt_sha256": sha256(run_root / "freeze/frozen.json"),
        "frozen_script_sha256": freeze_receipt["script"]["sha256"],
        "validator_script_sha256": sha256(Path(__file__).resolve()),
        "java": {
            "binary": args.java_bin,
            "jar": jar_record,
            "jvm_heap": args.jvm_heap,
            "headless": True,
            "flags": list(PRODUCTION_ODL_FLAGS),
        },
        "selection": {
            key: shape[key]
            for key in [
                "source_count",
                "native_pages",
                "selected_source_pages",
                "checked_table_rows",
                "raster_controls",
            ]
        },
        "sources": [],
    }
    rejections: list[dict[str, Any]] = []
    for source in fixture["sources"]:
        source_path = resolve_under(run_root, source["local_pdf"])
        target = output_root / source["id"]
        target.mkdir()
        command = [
            args.java_bin,
            f"-Xmx{args.jvm_heap}",
            "-Djava.awt.headless=true",
            "-jar",
            str(jar),
            str(source_path),
            "--output-dir",
            str(target),
            *PRODUCTION_ODL_FLAGS,
        ]
        started = time.monotonic()
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=args.timeout,
            check=False,
        )
        elapsed = time.monotonic() - started
        (target / "stdout.log").write_text(completed.stdout, encoding="utf-8")
        native_path = find_native_json(target, Path(source["local_pdf"]).stem)
        result: dict[str, Any] = {
            "id": source["id"],
            "source_pdf": rel(source_path),
            "command": command,
            "exit_code": completed.returncode,
            "elapsed_seconds": elapsed,
            "native_json": rel(native_path) if native_path else None,
            "output_files": sorted(
                rel(path) for path in target.rglob("*") if path.is_file()
            ),
        }
        if completed.returncode != 0 or native_path is None:
            rejection = {
                "source": source["id"],
                "exit_code": completed.returncode,
                "reason": "java_cli_failed"
                if completed.returncode
                else "native_json_missing",
                "output_tail": completed.stdout[-2000:],
            }
            rejections.append(rejection)
            result["status"] = "rejected"
        else:
            native = read_json(native_path)
            result["status"] = "completed"
            result["native_json_sha256"] = sha256(native_path)
            result["native_json_bytes"] = native_path.stat().st_size
            result["native_keys"] = (
                sorted(native.keys()) if isinstance(native, dict) else []
            )
            result["probe"] = probe_native(
                native,
                [page for page in fixture["pages"] if page["source"] == source["id"]],
                [
                    table
                    for page in fixture["pages"]
                    if page["source"] == source["id"]
                    for table in page.get("tables", [])
                ],
            )
        run_record["sources"].append(result)
        print(
            json.dumps(
                {
                    "source": source["id"],
                    "status": result["status"],
                    "seconds": elapsed,
                    "native_json": result["native_json"],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )

    run_record["finished_at_utc"] = utc_now()
    run_record["completed_sources"] = sum(
        item["status"] == "completed" for item in run_record["sources"]
    )
    run_record["rejected_sources"] = len(rejections)
    results_path = run_root / "results" / f"{run_name}.json"
    write_json(results_path, run_record)
    write_json(
        run_root / "rejections" / f"{run_name}.json",
        {
            "schema_version": 1,
            "kind": "production-java-matched-baseline-rejection-receipt",
            "run_name": run_name,
            "fixture_sha256": sha256(fixture_path),
            "freeze_receipt_sha256": sha256(run_root / "freeze/frozen.json"),
            "rejections": rejections,
        },
    )
    print(
        json.dumps(
            {
                "status": "matched-baseline-complete"
                if not rejections
                else "matched-baseline-with-rejections",
                "run_name": run_name,
                "completed_sources": run_record["completed_sources"],
                "rejected_sources": len(rejections),
                "results": rel(results_path),
            }
        )
    )
    return 0 if not rejections else 2


# ---------------------------------------------------------------- candidate


def match_norm(value: object) -> str:
    """Normalize source and parser text for scoped, human-readable checks."""
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    text = text.replace("−", "-").replace("–", "-").replace("—", "-")
    text = text.replace("×", "x").replace("μ", "u").replace("µ", "u")
    text = re.sub(r"(?<=\d)\s*x\s*(?=\d)", " x ", text)
    return re.sub(r"[^\w]+", " ", text, flags=re.UNICODE).strip()


def box_area(box: list[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def box_overlap(first: list[float], second: list[float]) -> float:
    return box_area(
        [
            max(first[0], second[0]),
            max(first[1], second[1]),
            min(first[2], second[2]),
            min(first[3], second[3]),
        ]
    )


def region_for_box(box: list[float], page: dict[str, Any]) -> str | None:
    """Assign one source rubric region by center, then meaningful overlap."""
    regions = page.get("regions", [])
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    centered = [
        region
        for region in regions
        if region["bbox"][0] <= cx <= region["bbox"][2]
        and region["bbox"][1] <= cy <= region["bbox"][3]
    ]
    if centered:
        return max(
            centered,
            key=lambda region: (
                box_overlap(box, region["bbox"]) / max(box_area(box), 1e-9),
                -box_area(region["bbox"]),
            ),
        )["id"]
    candidates = [
        (
            box_overlap(box, region["bbox"]) / max(box_area(box), 1e-9),
            -box_area(region["bbox"]),
            region["id"],
        )
        for region in regions
    ]
    best = max(candidates, default=(0.0, 0.0, None))
    return best[2] if best[0] >= 0.2 else None


def collapse_labels(labels: list[str | None]) -> list[str]:
    result: list[str] = []
    for label in labels:
        if label is not None and (not result or result[-1] != label):
            result.append(label)
    return result


def region_pair_score(
    labels: list[str | None], expected: list[str]
) -> tuple[int, int, dict[str, int]]:
    """Score every mapped block/region occurrence against the same denominator."""
    positions = {label: index for index, label in enumerate(expected)}
    scored = [label for label in labels if label in positions]
    counts = {label: scored.count(label) for label in expected}
    pairs = sum(
        counts[a] * counts[b]
        for index, a in enumerate(expected)
        for b in expected[index + 1 :]
    )
    wrong = sum(
        positions[left] > positions[right]
        for index, left in enumerate(scored)
        for right in scored[index + 1 :]
    )
    return wrong, pairs, counts


def region_sequence_from_blocks(
    blocks: list[dict], page: dict[str, Any]
) -> dict[str, Any]:
    page_idx = page["native_page"] - 1
    labels = [
        region_for_box(block["bbox"], page)
        for block in blocks
        if block.get("page_idx") == page_idx and isinstance(block.get("bbox"), list)
    ]
    observed = collapse_labels(labels)
    expected = page["reading_order"]
    wrong, pairs, counts = region_pair_score(labels, expected)
    return {
        "observed": observed,
        "missing": [label for label in expected if label not in observed],
        "counts": counts,
        "wrong_pairs": wrong,
        "pairs": pairs,
        "error_rate": wrong / pairs if pairs else None,
    }


def region_sequence_from_chunks(
    chunks: list[Any], page: dict[str, Any]
) -> dict[str, Any]:
    expected = page["reading_order"]
    labels: list[str | None] = []
    for chunk in chunks:
        for region in getattr(chunk, "regions", []):
            if region.page != page["native_page"]:
                continue
            labels.append(region_for_box(region.bbox, page))
    observed = collapse_labels(labels)
    wrong, pairs, counts = region_pair_score(labels, expected)
    return {
        "observed": observed,
        "missing": [label for label in expected if label not in observed],
        "counts": counts,
        "wrong_pairs": wrong,
        "pairs": pairs,
        "error_rate": wrong / pairs if pairs else None,
    }


def parse_html_table(value: object) -> tuple[list[str], list[list[str]]]:
    from odl.table_html import Table

    parser = Table()
    parser.feed(str(value or ""))
    parser.close()
    headers, rows = parser.grid()
    if headers and any(headers):
        return headers, rows
    # OpenDataLoader's native table cells are often marked TD even when the
    # first row is visibly a header. Keep those rows for row/cell checks while
    # leaving header association explicitly unscored.
    return [], [
        [cell.text for cell in row for _ in range(cell.colspan)] for row in parser.rows
    ]


def cell_matches(expected: object, observed: object) -> bool:
    left, right = match_norm(expected), match_norm(observed)
    return bool(left) and (left == right or left in right)


def row_matches(expected: list[str], observed: list[str]) -> bool:
    return matching_row_slice(expected, observed) is not None


def matching_row_slice(expected: list[str], observed: list[str]) -> list[str] | None:
    selected: list[str] = []
    position = 0
    for wanted in expected:
        found = next(
            (
                index
                for index in range(position, len(observed))
                if cell_matches(wanted, observed[index])
            ),
            None,
        )
        if found is None:
            return None
        selected.append(observed[found])
        position = found + 1
    return selected


def table_blocks_for(
    blocks: list[dict], page: dict[str, Any], table: dict[str, Any]
) -> list[dict]:
    page_idx = page["native_page"] - 1
    result = []
    for block in blocks:
        box = block.get("bbox")
        if block.get("type") != "table" or block.get("page_idx") != page_idx:
            continue
        if not isinstance(box, list) or box_area(box) <= 0:
            continue
        if box_overlap(box, table["bbox"]) / max(box_area(table["bbox"]), 1e-9) >= 0.2:
            result.append(block)
    return result


def table_block_score(
    blocks: list[dict], page: dict[str, Any], table: dict[str, Any]
) -> dict[str, Any]:
    candidates = table_blocks_for(blocks, page, table)
    parsed: list[dict[str, Any]] = []
    for block in candidates:
        try:
            headers, rows = parse_html_table(block.get("table_body", ""))
        except (TypeError, ValueError):
            continue
        parsed.append({"headers": headers, "rows": rows, "bbox": block.get("bbox")})
    headers = table.get("header", [])
    header_results = []
    for expected in headers:
        header_results.append(
            any(
                cell_matches(expected, observed)
                for item in parsed
                for observed in (
                    item["headers"] or [cell for row in item["rows"] for cell in row]
                )
            )
        )
    expected_rows = table.get("checked_rows", [])
    matched: list[dict[str, int]] = []
    missing: list[int] = []
    for index, expected in enumerate(expected_rows):
        found = None
        for table_index, item in enumerate(parsed):
            for row_index, observed in enumerate(item["rows"]):
                if row_matches(expected, observed):
                    found = {"table_index": table_index, "row_index": row_index}
                    break
            if found is not None:
                break
        if found is None:
            missing.append(index)
        else:
            matched.append({"expected_index": index, **found})
    row_positions = [item["row_index"] for item in matched]
    wrong_pairs = sum(
        left > right
        for i, left in enumerate(row_positions)
        for right in row_positions[i + 1 :]
    )
    checked_cells = len(expected_rows) * (len(expected_rows[0]) if expected_rows else 0)
    matched_cells = 0
    for item in matched:
        expected = expected_rows[item["expected_index"]]
        observed_rows = parsed[item["table_index"]]["rows"]
        for observed in observed_rows:
            selected = matching_row_slice(expected, observed)
            if selected is not None:
                matched_cells += sum(
                    cell_matches(left, right) for left, right in zip(expected, selected)
                )
                break
    return {
        "table_blocks": len(candidates),
        "parsed_tables": len(parsed),
        "headers_expected": len(headers),
        "headers_present": sum(header_results),
        "header_missing": [
            header for header, present in zip(headers, header_results) if not present
        ],
        "header_association": (
            "explicit-header-tags"
            if any(item["headers"] for item in parsed)
            else "unscored-native-cells-have-no-header-tags"
        ),
        "checked_rows": len(expected_rows),
        "matched_rows": len(matched),
        "missing_rows": missing,
        "checked_cells": checked_cells,
        "matched_cells": matched_cells,
        "row_order_wrong_pairs": wrong_pairs,
        "row_matches": matched,
        "status": "scored" if parsed else "no-typed-table-block",
    }


def chunk_lines_for_table(
    chunks: list[Any], page: dict[str, Any], table: dict[str, Any]
) -> list[str]:
    lines: list[str] = []
    for chunk in chunks:
        if not any(
            region.page == page["native_page"]
            and box_overlap(region.bbox, table["bbox"])
            / max(box_area(table["bbox"]), 1e-9)
            >= 0.2
            for region in getattr(chunk, "regions", [])
        ):
            continue
        lines.extend(line for line in chunk.text.splitlines() if line.count("|") >= 1)
    return lines


def table_chunk_score(
    chunks: list[Any], page: dict[str, Any], table: dict[str, Any]
) -> dict[str, Any]:
    lines = chunk_lines_for_table(chunks, page, table)
    expected_rows = table.get("checked_rows", [])
    matches: list[dict[str, int]] = []
    missing: list[int] = []
    for index, expected in enumerate(expected_rows):
        found = None
        for line_index, line in enumerate(lines):
            observed = [part.strip() for part in line.split("|")]
            if row_matches(expected, observed):
                found = {"expected_index": index, "line_index": line_index}
                break
        if found is None:
            missing.append(index)
        else:
            matches.append(found)
    positions = [item["line_index"] for item in matches]
    wrong_pairs = sum(
        left > right for i, left in enumerate(positions) for right in positions[i + 1 :]
    )
    checked_cells = len(expected_rows) * (len(expected_rows[0]) if expected_rows else 0)
    matched_cells = 0
    for match in matches:
        expected = expected_rows[match["expected_index"]]
        observed = [part.strip() for part in lines[match["line_index"]].split("|")]
        selected = matching_row_slice(expected, observed)
        if selected is not None:
            matched_cells += sum(
                cell_matches(left, right) for left, right in zip(expected, selected)
            )
    return {
        "pipe_lines": len(lines),
        "checked_rows": len(expected_rows),
        "matched_rows": len(matches),
        "checked_cells": checked_cells,
        "matched_cells": matched_cells,
        "missing_rows": missing,
        "row_order_wrong_pairs": wrong_pairs,
        "row_matches": matches,
        "scope": "final-packed-chunk-pipe-lines",
        "status": "scored" if lines else "unscored-no-pipe-table-lines",
    }


def anchor_score(
    blocks: list[dict], chunks: list[Any], page: dict[str, Any]
) -> dict[str, Any]:
    result = []
    page_idx = page["native_page"] - 1
    for anchor in page.get("anchors", []):
        needle = match_norm(anchor["text"])
        block_hits = [
            block
            for block in blocks
            if block.get("page_idx") == page_idx
            and isinstance(block.get("bbox"), list)
            and region_for_box(block["bbox"], page) == anchor["region"]
            and needle in match_norm(block.get("text", ""))
        ]
        chunk_hits = [
            chunk
            for chunk in chunks
            if needle in match_norm(chunk.text)
            and any(
                region.page == page["native_page"]
                and region_for_box(region.bbox, page) == anchor["region"]
                for region in getattr(chunk, "regions", [])
            )
        ]
        result.append(
            {
                "text": anchor["text"],
                "region": anchor["region"],
                "block_present": bool(block_hits),
                "chunk_present": bool(chunk_hits),
            }
        )
    return {
        "anchors": result,
        "missing_blocks": sum(not x["block_present"] for x in result),
        "missing_chunks": sum(not x["chunk_present"] for x in result),
    }


def serialize_chunks(chunks: list[Any]) -> list[dict[str, Any]]:
    return [asdict(chunk) for chunk in chunks]


def candidate_hashes(root: Path, model_dir: Path) -> dict[str, Any]:
    files = [
        "parser/odl/adapter.py",
        "parser/odl/columns.py",
        "parser/odl/context.py",
        "parser/odl/exponents.py",
        "parser/odl/fonts.py",
        "parser/odl/furniture.py",
        "parser/odl/geometry.py",
        "parser/odl/headings.py",
        "parser/odl/hidden.py",
        "parser/odl/java.py",
        "parser/odl/layout.py",
        "parser/odl/lists.py",
        "parser/odl/ocr.py",
        "parser/odl/order.py",
        "parser/odl/refine.py",
        "parser/odl/source_grid.py",
        "parser/odl/source_text.py",
        "parser/odl/styles.py",
        "parser/odl/table_html.py",
        "parser/odl/tables.py",
        "pipeline/pipeline/retrieval/chunking.py",
        "pipeline/pipeline/retrieval/headings.py",
        "pipeline/pipeline/retrieval/packing.py",
    ]
    models = {path.name: sha256(path) for path in sorted(model_dir.glob("*.onnx"))}
    return {
        "source_sha256": {name: sha256(root / name) for name in files},
        "model_sha256": models,
    }


def verify_candidate_freeze(
    fixture_path: Path, run_root: Path
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    receipt_path = run_root / "freeze/frozen.json"
    frozen_script = run_root / "freeze/validate_odl_repairs.py"
    if not receipt_path.is_file() or not frozen_script.is_file():
        raise FileNotFoundError("run freeze before candidate validation")
    receipt = read_json(receipt_path)
    fixture = load_fixture(fixture_path)
    if receipt["fixture"]["sha256"] != sha256(fixture_path):
        raise ValueError("fixture changed after freeze")
    if receipt["script"]["sha256"] != sha256(frozen_script):
        raise ValueError("frozen validation script copy changed")
    shape = validate_shape(fixture, run_root)
    for source in fixture["sources"]:
        source_pdf_record(source, run_root)
    return fixture, receipt, shape


def source_page_sizes(path: Path) -> list[dict[str, float]]:
    import pymupdf

    with pymupdf.open(path) as document:
        return [
            {"width": page.rect.width, "height": page.rect.height} for page in document
        ]


def load_baseline_blocks(
    source: dict[str, Any],
    run_root: Path,
    baseline_run_name: str = "raw-java-baseline-r1",
) -> list[dict]:
    from odl.adapter import odl_content_list

    native_path = (
        run_root
        / "baseline"
        / baseline_run_name
        / source["id"]
        / f"{Path(source['local_pdf']).stem}.json"
    )
    if not native_path.is_file():
        candidates = sorted(native_path.parent.glob("*.json"))
        if len(candidates) != 1:
            raise FileNotFoundError(
                f"baseline native JSON is missing for {source['id']}"
            )
        native_path = candidates[0]
    native = read_json(native_path)
    return odl_content_list(
        native, source_page_sizes(resolve_under(run_root, source["local_pdf"]))
    )


def pack_final(blocks: list[dict], pdf: Path, furniture: frozenset[str]) -> list[Any]:
    from pipeline.retrieval.confidence import ocr_pages, score_chunks
    from pipeline.retrieval.headings import retain_headings
    from pipeline.retrieval.packing import pack_blocks

    chunks = pack_blocks(blocks, furniture)
    chunks = retain_headings(blocks, pdf, chunks)
    score_chunks(chunks, pdf, ocr=ocr_pages(blocks))
    return chunks


def run_raster_ocr_controls(
    fixture: dict[str, Any],
    run_root: Path,
    output_root: Path,
    model_dir: Path,
    page_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    import pymupdf
    from odl import layout, ocr

    output_dir = output_root / "raster-ocr"
    output_dir.mkdir(parents=True)
    records = []
    for control in fixture.get("raster_controls", []):
        raster_path = resolve_under(run_root, control["local_pdf"])
        gold_page = page_by_id[control["gold_page"]]
        # The raster is a one-page derivative, but its boxes are the source
        # page's coordinates. Score against a page-number-one view of the same
        # frozen regions.
        raster_page = {**gold_page, "native_page": 1}
        with pymupdf.open(raster_path) as document:
            image = ocr.render(document[0])
        lines = ocr.ocr_lines(image)
        blocks = ocr.line_blocks(lines, image.size, 0)
        boxes = layout.regions(image, model_dir)
        ordered, decision = layout.order_blocks(blocks, boxes)
        identity = {id(block): index for index, block in enumerate(blocks)}
        current_order = [identity[id(block)] for block in ordered]
        old_score = region_sequence_from_blocks(blocks, raster_page)
        current_blocks = [blocks[index] for index in current_order]
        current_score = region_sequence_from_blocks(current_blocks, raster_page)
        record = {
            "id": control["id"],
            "source": control["source"],
            "source_page": control["source_page"],
            "gold_page": control["gold_page"],
            "raster_pdf": rel(raster_path),
            "render_size": list(image.size),
            "lines": lines,
            "layout_boxes": boxes,
            "line_count": len(blocks),
            "layout_region_count": len(boxes),
            "decision": decision,
            "strict_active": current_order != list(range(len(blocks))),
            "old_order": list(range(len(blocks))),
            "current_order": current_order,
            "old_score": old_score,
            "current_score": current_score,
            "configuration": {
                "max_edge": ocr.MAX_EDGE,
                "threads": ocr.THREADS,
                "text_score": ocr.TEXT_SCORE,
                "layout_model": "PP_DOC_LAYOUTV3",
                "layout_conf_thresh": 0.5,
                "layout_iou_thresh": 0.5,
                "layout_engine_cfg": {
                    "intra_op_num_threads": 4,
                    "inter_op_num_threads": 1,
                },
            },
        }
        write_json(output_dir / f"{control['id']}.json", record)
        records.append(record)
    return records


def compare_source(
    source: dict[str, Any],
    fixture: dict[str, Any],
    run_root: Path,
    candidate_blocks: list[dict],
    candidate_chunks: list[Any],
    *,
    baseline_run_name: str = "raw-java-baseline-r1",
    baseline_controls_root: Path | None = None,
) -> dict[str, Any]:
    baseline_blocks = load_baseline_blocks(source, run_root, baseline_run_name)
    source_pdf = resolve_under(run_root, source["local_pdf"])
    baseline_chunks = pack_final(baseline_blocks, source_pdf, frozenset())
    baseline_dir = (
        baseline_controls_root
        if baseline_controls_root is not None
        else run_root / "candidate" / "production-candidate-r1" / "baseline-controls"
    ) / source["id"]
    baseline_dir.mkdir(parents=True, exist_ok=True)
    write_json(baseline_dir / "content_list.json", baseline_blocks)
    write_json(baseline_dir / "chunks.json", serialize_chunks(baseline_chunks))
    pages = [page for page in fixture["pages"] if page["source"] == source["id"]]
    page_results = []
    for page in pages:
        tables = []
        for table in [
            table for page_table in page.get("tables", []) for table in [page_table]
        ]:
            tables.append(
                {
                    "id": table["id"],
                    "baseline_blocks": table_block_score(baseline_blocks, page, table),
                    "candidate_blocks": table_block_score(
                        candidate_blocks, page, table
                    ),
                    "baseline_chunks": table_chunk_score(baseline_chunks, page, table),
                    "candidate_chunks": table_chunk_score(
                        candidate_chunks, page, table
                    ),
                }
            )
        page_results.append(
            {
                "id": page["id"],
                "baseline_blocks": region_sequence_from_blocks(baseline_blocks, page),
                "candidate_blocks": region_sequence_from_blocks(candidate_blocks, page),
                "baseline_chunks": region_sequence_from_chunks(baseline_chunks, page),
                "candidate_chunks": region_sequence_from_chunks(candidate_chunks, page),
                "baseline_anchors": anchor_score(
                    baseline_blocks, baseline_chunks, page
                ),
                "candidate_anchors": anchor_score(
                    candidate_blocks, candidate_chunks, page
                ),
                "tables": tables,
            }
        )
    return {
        "source": source["id"],
        "baseline_block_count": len(baseline_blocks),
        "candidate_block_count": len(candidate_blocks),
        "baseline_chunk_count": len(baseline_chunks),
        "candidate_chunk_count": len(candidate_chunks),
        "pages": page_results,
    }


def run_candidate(args: argparse.Namespace) -> int:
    fixture_path = args.fixture.resolve()
    run_root = args.run_root.resolve()
    fixture, freeze_receipt, shape = verify_candidate_freeze(fixture_path, run_root)
    model_dir = args.model_dir.resolve()
    if not model_dir.is_dir():
        raise FileNotFoundError(f"RapidOCR model directory is missing: {model_dir}")
    output_root = run_root / "candidate" / args.run_name
    if output_root.exists():
        raise FileExistsError(f"candidate output already exists: {output_root}")
    output_root.mkdir(parents=True)
    os.environ["CAPY_RAPIDOCR_MODEL_DIR"] = str(model_dir)
    sys.path.insert(0, str(REPO_ROOT / "parser"))
    sys.path.insert(0, str(REPO_ROOT / "pipeline"))
    from importlib import metadata

    from odl.refine import parse_pdf

    dependencies = {}
    for name in [
        "rapidocr",
        "rapid-layout",
        "onnxruntime",
        "numpy",
        "pymupdf",
        "pillow",
        "pypdf",
    ]:
        try:
            dependencies[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            dependencies[name] = "missing"
    run_record: dict[str, Any] = {
        "schema_version": 1,
        "kind": "production-odl-candidate-validation",
        "output_version": "production-odl-refined-v3-candidate-r1",
        "started_at_utc": utc_now(),
        "run_name": args.run_name,
        "fixture": {"path": rel(fixture_path), "sha256": sha256(fixture_path)},
        "freeze_receipt_sha256": sha256(run_root / "freeze/frozen.json"),
        "frozen_script_sha256": freeze_receipt["script"]["sha256"],
        "candidate_script_sha256": sha256(Path(__file__).resolve()),
        "selection": {
            key: shape[key]
            for key in [
                "source_count",
                "native_pages",
                "selected_source_pages",
                "checked_table_rows",
                "raster_controls",
            ]
        },
        "runtime": {
            "python": sys.version,
            "dependencies": dependencies,
            "models": {
                path.name: sha256(path) for path in sorted(model_dir.glob("*.onnx"))
            },
            "model_dir": str(model_dir),
        },
        "helpers": candidate_hashes(REPO_ROOT, model_dir),
        "sources": [],
        "raster_ocr": [],
    }
    source_results = []
    rejections: list[dict[str, Any]] = []
    for source in fixture["sources"]:
        source_path = resolve_under(run_root, source["local_pdf"])
        target = output_root / source["id"]
        target.mkdir()
        work = Path(tempfile.mkdtemp(prefix="odl-candidate-"))
        started = time.monotonic()
        try:
            output = parse_pdf(
                source_path.read_bytes(), work, java_timeout_s=args.timeout
            )
            page_pdf = source_path
            if output.parsed_pdf is not None:
                page_pdf = target / "parsed.pdf"
                page_pdf.write_bytes(output.parsed_pdf)
            chunks = pack_final(
                output.content_list, page_pdf, frozenset(output.furniture)
            )
            write_json(target / "content_list.json", output.content_list)
            write_json(target / "chunks.json", serialize_chunks(chunks))
            (target / "document.md").write_text(output.markdown, encoding="utf-8")
            candidate_result = compare_source(
                source, fixture, run_root, output.content_list, chunks
            )
            result = {
                "id": source["id"],
                "status": "completed",
                "elapsed_seconds": time.monotonic() - started,
                "page_count": output.page_count,
                "block_count": len(output.content_list),
                "chunk_count": len(chunks),
                "ocr_pages": output.ocr_pages,
                "repaired_fonts": output.repaired_fonts,
                "furniture": output.furniture,
                "phases": output.phases,
                "content_list_sha256": sha256(target / "content_list.json"),
                "chunks_sha256": sha256(target / "chunks.json"),
                "comparison": candidate_result,
            }
            write_json(target / "result.json", result)
            source_results.append(result)
            print(
                json.dumps(
                    {
                        "source": source["id"],
                        "status": "completed",
                        "seconds": result["elapsed_seconds"],
                        "blocks": result["block_count"],
                        "chunks": result["chunk_count"],
                        "ocr_pages": result["ocr_pages"],
                    }
                ),
                flush=True,
            )
        except Exception as error:  # noqa: BLE001 - receipt records per-source rejection
            rejection = {
                "source": source["id"],
                "reason": type(error).__name__,
                "detail": str(error),
            }
            rejections.append(rejection)
            result = {
                "id": source["id"],
                "status": "rejected",
                "elapsed_seconds": time.monotonic() - started,
                "rejection": rejection,
            }
            write_json(target / "result.json", result)
            source_results.append(result)
            print(json.dumps(result), flush=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    run_record["sources"] = source_results
    run_record["raster_ocr"] = run_raster_ocr_controls(
        fixture,
        run_root,
        output_root,
        model_dir,
        {page["id"]: page for page in fixture["pages"]},
    )
    run_record["finished_at_utc"] = utc_now()
    run_record["completed_sources"] = sum(
        item["status"] == "completed" for item in source_results
    )
    run_record["rejected_sources"] = len(rejections)
    results_path = run_root / "results" / f"{args.run_name}.json"
    write_json(results_path, run_record)
    write_json(
        run_root / "rejections" / f"{args.run_name}.json",
        {
            "schema_version": 1,
            "kind": "production-odl-candidate-rejection-receipt",
            "run_name": args.run_name,
            "fixture_sha256": sha256(fixture_path),
            "freeze_receipt_sha256": sha256(run_root / "freeze/frozen.json"),
            "rejections": rejections,
        },
    )
    print(
        json.dumps(
            {
                "status": "candidate-complete"
                if not rejections
                else "candidate-with-rejections",
                "run_name": args.run_name,
                "completed_sources": run_record["completed_sources"],
                "rejected_sources": len(rejections),
                "results": rel(results_path),
            }
        )
    )
    return 0 if not rejections else 2


def load_saved_chunks(path: Path) -> list[Any]:
    """Load the exact final chunks saved by a completed candidate run."""
    from pipeline.retrieval.chunking import Chunk, Region

    records = read_json(path)
    if not isinstance(records, list):
        raise TypeError(f"saved chunks are not a list: {path}")
    chunks = []
    for index, record in enumerate(records):
        if not isinstance(record, dict) or not isinstance(record.get("text"), str):
            raise TypeError(f"invalid saved chunk {index} in {path}")
        regions = []
        for region in record.get("regions", []):
            if not isinstance(region, dict) or not isinstance(region.get("page"), int):
                raise TypeError(f"invalid saved chunk region {index} in {path}")
            bbox = region.get("bbox")
            if not isinstance(bbox, list) or len(bbox) != 4:
                raise ValueError(f"invalid saved chunk bbox {index} in {path}")
            regions.append(Region(page=region["page"], bbox=bbox))
        chunks.append(
            Chunk(
                text=record["text"],
                section_path=record.get("section_path", ""),
                page_start=record.get("page_start"),
                page_end=record.get("page_end"),
                regions=regions,
                reference=record.get("reference", False),
                confidence=record.get("confidence"),
                confidence_reasons=record.get("confidence_reasons", []),
            )
        )
    return chunks


def score_candidate_against_baseline(args: argparse.Namespace) -> int:
    """Rescore saved candidate blocks/chunks against a selected Java baseline."""
    fixture_path = args.fixture.resolve()
    run_root = args.run_root.resolve()
    sys.path.insert(0, str(REPO_ROOT / "parser"))
    sys.path.insert(0, str(REPO_ROOT / "pipeline"))
    fixture, freeze_receipt, shape = verify_candidate_freeze(fixture_path, run_root)
    baseline_result_path = run_root / "results" / f"{args.baseline_run_name}.json"
    candidate_result_path = run_root / "results" / f"{args.candidate_run_name}.json"
    if not baseline_result_path.is_file():
        raise FileNotFoundError(
            f"matched baseline receipt is missing: {baseline_result_path}"
        )
    if not candidate_result_path.is_file():
        raise FileNotFoundError(
            f"candidate receipt is missing: {candidate_result_path}"
        )
    baseline_result = read_json(baseline_result_path)
    candidate_result = read_json(candidate_result_path)
    if baseline_result.get("completed_sources") != len(fixture["sources"]):
        raise ValueError("selected baseline is incomplete")
    if candidate_result.get("completed_sources") != len(fixture["sources"]):
        raise ValueError("selected candidate is incomplete")
    model_dir = args.model_dir.resolve()
    if not model_dir.is_dir():
        raise FileNotFoundError(f"RapidOCR model directory is missing: {model_dir}")
    current_helpers = candidate_hashes(REPO_ROOT, model_dir)
    output_root = run_root / "comparison" / args.run_name
    if output_root.exists():
        raise FileExistsError(f"comparison output already exists: {output_root}")
    output_root.mkdir(parents=True)
    source_results = []
    for source in fixture["sources"]:
        candidate_dir = run_root / "candidate" / args.candidate_run_name / source["id"]
        blocks_path = candidate_dir / "content_list.json"
        chunks_path = candidate_dir / "chunks.json"
        if not blocks_path.is_file() or not chunks_path.is_file():
            raise FileNotFoundError(
                f"saved candidate artifacts are missing for {source['id']}"
            )
        candidate_blocks = read_json(blocks_path)
        saved_candidate_chunks = load_saved_chunks(chunks_path)
        if not isinstance(candidate_blocks, list):
            raise TypeError(f"saved candidate blocks are not a list for {source['id']}")
        candidate_source_result = next(
            item
            for item in candidate_result["sources"]
            if item.get("id") == source["id"]
        )
        candidate_pdf = candidate_dir / "parsed.pdf"
        if not candidate_pdf.is_file():
            candidate_pdf = resolve_under(run_root, source["local_pdf"])
        candidate_furniture = frozenset(candidate_source_result.get("furniture", []))
        candidate_chunks = pack_final(
            candidate_blocks, candidate_pdf, candidate_furniture
        )
        repacked_dir = output_root / "candidate-repacked" / source["id"]
        repacked_chunks_path = repacked_dir / "chunks.json"
        write_json(repacked_chunks_path, serialize_chunks(candidate_chunks))
        comparison = compare_source(
            source,
            fixture,
            run_root,
            candidate_blocks,
            candidate_chunks,
            baseline_run_name=args.baseline_run_name,
            baseline_controls_root=output_root / "baseline-controls",
        )
        source_results.append(
            {
                "id": source["id"],
                "status": "completed",
                "candidate_content_list_sha256": sha256(blocks_path),
                "candidate_chunks_sha256": sha256(chunks_path),
                "candidate_repack": {
                    "input_saved_chunks_sha256": sha256(chunks_path),
                    "input_saved_chunk_count": len(saved_candidate_chunks),
                    "repacked_chunks_sha256": sha256(repacked_chunks_path),
                    "repacked_chunk_count": len(candidate_chunks),
                    "furniture": sorted(candidate_furniture),
                    "pdf": rel(candidate_pdf),
                    "reason": (
                        "Cached final-r3 candidate blocks were repacked with the "
                        "current production packer before matched scoring."
                    ),
                },
                "comparison": comparison,
            }
        )
    result = {
        "schema_version": 1,
        "kind": "production-odl-matched-baseline-score",
        "output_version": "production-odl-matched-baseline-score-v1",
        "started_at_utc": utc_now(),
        "run_name": args.run_name,
        "baseline_run_name": args.baseline_run_name,
        "candidate_run_name": args.candidate_run_name,
        "fixture": {"path": rel(fixture_path), "sha256": sha256(fixture_path)},
        "freeze_receipt_sha256": sha256(run_root / "freeze/frozen.json"),
        "frozen_script_sha256": freeze_receipt["script"]["sha256"],
        "scoring_script_sha256": sha256(Path(__file__).resolve()),
        "baseline_result_sha256": sha256(baseline_result_path),
        "candidate_result_sha256": sha256(candidate_result_path),
        "selection": {
            key: shape[key]
            for key in [
                "source_count",
                "native_pages",
                "selected_source_pages",
                "checked_table_rows",
                "raster_controls",
            ]
        },
        "baseline_java": baseline_result.get("java"),
        "candidate_artifact_script_sha256": candidate_result.get(
            "candidate_script_sha256"
        ),
        "candidate_artifact_helpers": candidate_result.get("helpers"),
        "current_helpers": current_helpers,
        "raster_ocr_reused_from": {
            "path": rel(candidate_result_path),
            "sha256": sha256(candidate_result_path),
            "reason": (
                "This command rescored saved native blocks/chunks; the fresh OCR "
                "controls remain the unchanged final-r3 receipt."
            ),
        },
        "sources": source_results,
        "finished_at_utc": utc_now(),
        "completed_sources": len(source_results),
        "rejected_sources": 0,
    }
    results_path = run_root / "results" / f"{args.run_name}.json"
    write_json(results_path, result)
    write_json(
        run_root / "rejections" / f"{args.run_name}.json",
        {
            "schema_version": 1,
            "kind": "production-odl-matched-baseline-score-rejection-receipt",
            "run_name": args.run_name,
            "fixture_sha256": sha256(fixture_path),
            "freeze_receipt_sha256": sha256(run_root / "freeze/frozen.json"),
            "rejections": [],
        },
    )
    print(
        json.dumps(
            {
                "status": "matched-score-complete",
                "run_name": args.run_name,
                "completed_sources": len(source_results),
                "results": rel(results_path),
            }
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=[
            "freeze",
            "baseline",
            "baseline-matched",
            "candidate",
            "score-candidate",
        ],
    )
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--run-root", type=Path, default=DEFAULT_RUN_ROOT)
    parser.add_argument("--java-bin", default="/usr/bin/java")
    parser.add_argument("--jar", type=Path, default=DEFAULT_JAR)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--run-name", default="raw-java-baseline-r1")
    parser.add_argument("--baseline-run-name", default="production-java-matched-r1")
    parser.add_argument("--candidate-run-name", default="production-candidate-final-r3")
    parser.add_argument("--jvm-heap", default="1g")
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path("/private/tmp/capy-odl-quality-20260913/models"),
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "freeze":
            return freeze(args)
        if args.command == "baseline":
            return run_baseline(args)
        if args.command == "baseline-matched":
            return run_matched_baseline(args)
        if args.command == "candidate":
            return run_candidate(args)
        return score_candidate_against_baseline(args)
    except (
        FileNotFoundError,
        FileExistsError,
        ValueError,
        TypeError,
        RuntimeError,
        subprocess.TimeoutExpired,
    ) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
