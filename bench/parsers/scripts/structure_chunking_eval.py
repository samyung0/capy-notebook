#!/usr/bin/env python3
"""Evaluate structure-aware packing on frozen OpenDataLoader artifacts.

``prepare`` verifies the frozen source/question hashes and parses only sources
without saved native artifacts. ``evaluate`` compares current packing, hard
native list/table boundaries, and the same boundaries with strictly validated
caption/continuation metadata. It never writes an application database.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import subprocess
import time
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = ROOT / "bench/parsers/fixtures/structure_chunking_fixtures.json"
DEFAULT_RUN_ROOT = ROOT / "bench/parsers/reports/local/2026-09-13-structure-chunking"
DEFAULT_JAR = Path(
    "/private/tmp/capy-odl-quality-20260913/py312/lib/python3.12/"
    "site-packages/opendataloader_pdf/jar/opendataloader-pdf-cli.jar"
)
ODL_FLAGS = (
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
ATOMIC_TYPES = frozenset({"list", "table"})


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def resolve(path: str) -> Path:
    lexical = (ROOT / path).absolute()
    if ROOT.absolute() not in lexical.parents and lexical != ROOT.absolute():
        raise ValueError(f"path escapes repository: {path}")
    return lexical.resolve()


def norm(text: object) -> str:
    value = unicodedata.normalize("NFKC", str(text or "")).casefold()
    return re.sub(r"[^\w]+", "", value, flags=re.UNICODE)


def node_text(node: dict) -> str:
    parts = [node["content"]] if isinstance(node.get("content"), str) else []
    for key in ("kids", "list items", "toc items"):
        parts.extend(
            node_text(child) for child in node.get(key, []) if isinstance(child, dict)
        )
    return " ".join(parts)


def native_nodes(document: dict) -> tuple[dict[int, dict], dict[int, int | None]]:
    by_id: dict[int, dict] = {}
    parents: dict[int, int | None] = {}

    def walk(node: object, parent: int | None = None) -> None:
        if isinstance(node, list):
            for child in node:
                walk(child, parent)
            return
        if not isinstance(node, dict):
            return
        node_id = node.get("id")
        active_parent = parent
        if isinstance(node_id, int):
            by_id[node_id] = node
            parents[node_id] = parent
            active_parent = node_id
        for key in ("kids", "rows", "cells", "list items", "toc items"):
            walk(node.get(key, []), active_parent)

    walk(document)
    return by_id, parents


def page_sizes(pdf: Path) -> list[dict[str, float]]:
    import pymupdf

    with pymupdf.open(pdf) as document:
        return [
            {"width": page.rect.width, "height": page.rect.height} for page in document
        ]


def find_native_json(target: Path, stem: str) -> Path:
    preferred = list(target.rglob(f"{stem}.json"))
    candidates = preferred or [
        path
        for path in target.rglob("*.json")
        if path.name not in {"receipt.json", "sources.json"}
    ]
    if len(candidates) != 1:
        raise FileNotFoundError(
            f"expected one native JSON in {target}, got {candidates}"
        )
    return candidates[0]


def verify_fixture(fixture_path: Path) -> dict:
    fixture = read_json(fixture_path)
    for record in fixture["question_fixtures"]:
        path = resolve(record["path"])
        if sha256(path) != record["sha256"]:
            raise ValueError(f"question fixture changed: {path}")
    for source in fixture["sources"]:
        if source.get("pdf"):
            pdf = resolve(source["pdf"])
        else:
            pdf = resolve(source["artifact_dir"]) / "source.pdf"
        if sha256(pdf) != source["pdf_sha256"]:
            raise ValueError(f"source changed: {source['id']}")
    return fixture


def source_paths(source: dict, run_root: Path) -> tuple[Path, Path, Path, Path | None]:
    if source["id"] == "jlpt-n1-2019":
        base = resolve(source["artifact_dir"])
        return (
            resolve(source["pdf"]),
            base / "production-native.json",
            base / "refined-content-list.json",
            None,
        )
    if source.get("artifact_dir"):
        base = resolve(source["artifact_dir"])
        furniture = base / "furniture.json"
        return (
            base / "source.pdf",
            base / "native/source.json",
            base / "raw.json",
            furniture if furniture.is_file() else None,
        )
    base = run_root / "prepared" / source["id"]
    return resolve(source["pdf"]), base / "native.json", base / "raw.json", None


def prepare(args: argparse.Namespace) -> None:
    fixture_path = args.fixture.resolve()
    fixture = verify_fixture(fixture_path)
    run_root = args.run_root.resolve()
    if run_root.exists():
        raise FileExistsError(f"run root already exists: {run_root}")
    run_root.mkdir(parents=True)
    snapshot = run_root / "freeze"
    snapshot.mkdir()
    shutil.copy2(fixture_path, snapshot / fixture_path.name)
    shutil.copy2(Path(__file__), snapshot / Path(__file__).name)
    jar = args.jar.resolve()
    if not jar.is_file():
        raise FileNotFoundError(jar)
    records = []
    for source in fixture["sources"]:
        pdf, native_path, raw_path, furniture_path = source_paths(source, run_root)
        started = time.monotonic()
        command = None
        if not native_path.is_file():
            target = native_path.parent / "odl"
            target.mkdir(parents=True)
            command = [
                args.java,
                "-Xmx3g",
                "-Djava.awt.headless=true",
                "-jar",
                str(jar),
                str(pdf),
                "--output-dir",
                str(target),
                *ODL_FLAGS,
            ]
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=args.timeout,
                check=False,
            )
            (native_path.parent / "stdout.log").write_text(
                completed.stdout, encoding="utf-8"
            )
            (native_path.parent / "stderr.log").write_text(
                completed.stderr, encoding="utf-8"
            )
            if completed.returncode:
                raise RuntimeError(
                    f"ODL failed for {source['id']}: {completed.stderr[-1000:]}"
                )
            generated = find_native_json(target, pdf.stem)
            shutil.copy2(generated, native_path)
            from odl.adapter import odl_content_list

            write_json(
                raw_path, odl_content_list(read_json(native_path), page_sizes(pdf))
            )
        records.append(
            {
                "id": source["id"],
                "role": source["role"],
                "language": source["language"],
                "pdf": str(pdf),
                "pdf_sha256": sha256(pdf),
                "native": str(native_path),
                "native_sha256": sha256(native_path),
                "blocks": str(raw_path),
                "blocks_sha256": sha256(raw_path),
                "furniture": str(furniture_path) if furniture_path else None,
                "command": command,
                "elapsed_seconds": round(time.monotonic() - started, 3),
            }
        )
        print(json.dumps({"prepared": source["id"]}), flush=True)
    write_json(run_root / "sources.json", records)
    write_json(
        run_root / "freeze.json",
        {
            "schema_version": 1,
            "frozen_at_utc": utc_now(),
            "fixture": {"path": str(fixture_path), "sha256": sha256(fixture_path)},
            "script_sha256": sha256(snapshot / Path(__file__).name),
            "jar": {"path": str(jar), "sha256": sha256(jar)},
            "sources_sha256": sha256(run_root / "sources.json"),
            "candidate_results_viewed": False,
        },
    )


def strict_relationships(nodes: dict[int, dict]) -> dict[str, Any]:
    valid_pairs: set[frozenset[int]] = set()
    captions: dict[int, int] = {}
    rejected = Counter()
    seen: set[tuple[int, str, int]] = set()
    continuation_total = 0
    caption_total = 0
    for node_id, node in nodes.items():
        for key, inverse in (
            ("next list id", "previous list id"),
            ("previous list id", "next list id"),
            ("next table id", "previous table id"),
            ("previous table id", "next table id"),
        ):
            target_id = node.get(key)
            if not isinstance(target_id, int) or (node_id, key, target_id) in seen:
                continue
            seen.add((node_id, key, target_id))
            continuation_total += 1
            target = nodes.get(target_id)
            if not target:
                rejected["missing_target"] += 1
            elif target.get("type") != node.get("type"):
                rejected["different_type"] += 1
            elif target.get(inverse) != node_id:
                rejected["not_reciprocal"] += 1
            elif not isinstance(node.get("page number"), int) or not isinstance(
                target.get("page number"), int
            ):
                rejected["missing_page"] += 1
            elif abs(node["page number"] - target["page number"]) > 1:
                rejected["page_gap"] += 1
            elif node.get("level") != target.get("level"):
                rejected["different_level"] += 1
            else:
                valid_pairs.add(frozenset((node_id, target_id)))
        target_id = node.get("linked content id")
        if not isinstance(target_id, int):
            continue
        caption_total += 1
        target = nodes.get(target_id)
        if node.get("type") != "caption":
            rejected["link_source_not_caption"] += 1
        elif not target:
            rejected["caption_missing_target"] += 1
        elif target.get("type") not in {"table", "image", "picture"}:
            rejected["caption_wrong_target_type"] += 1
        elif node.get("page number") != target.get("page number"):
            rejected["caption_cross_page"] += 1
        else:
            source_box = node.get("bounding box")
            target_box = target.get("bounding box")
            if not (
                isinstance(source_box, list)
                and len(source_box) == 4
                and isinstance(target_box, list)
                and len(target_box) == 4
            ):
                rejected["caption_missing_bbox"] += 1
            elif min(source_box[2], target_box[2]) <= max(source_box[0], target_box[0]):
                rejected["caption_no_horizontal_overlap"] += 1
            elif (
                max(
                    0,
                    max(source_box[1], target_box[1])
                    - min(source_box[3], target_box[3]),
                )
                > 100
            ):
                rejected["caption_too_far"] += 1
            else:
                captions[node_id] = target_id
    return {
        "continuation_records": continuation_total,
        "valid_continuation_pairs": valid_pairs,
        "caption_records": caption_total,
        "valid_captions": captions,
        "rejected": dict(rejected),
    }


def enrich_relationships(
    blocks: list[dict], nodes: dict[int, dict], relations: dict[str, Any]
) -> list[dict]:
    result = [dict(block) for block in blocks]
    by_id = {
        block.get("_native_id"): block
        for block in result
        if isinstance(block.get("_native_id"), int)
    }
    remove: set[int] = set()
    for caption_id, target_id in relations["valid_captions"].items():
        caption = by_id.get(caption_id)
        target = by_id.get(target_id)
        source = nodes[caption_id]
        text = str(source.get("content") or "").strip()
        if not caption or not target or not text:
            continue
        if target.get("type") == "table":
            target["table_caption"] = [text]
            target["_native_table_title"] = text
        elif target.get("type") == "image":
            target["image_caption"] = [text]
        remove.add(caption_id)
    return [block for block in result if block.get("_native_id") not in remove]


def pack_structural(
    blocks: list[dict],
    furniture: frozenset[str],
    continuation_pairs: set[frozenset[int]] | None = None,
) -> list[Any]:
    """Keep every native list/table atomic; retain headings as context seeds."""
    from pipeline.retrieval.packing import pack_blocks

    pairs = continuation_pairs or set()
    chunks: list[Any] = []
    pending: list[dict] = []
    headings: list[dict] = []

    def flush() -> None:
        if pending:
            chunks.extend(pack_blocks(headings + pending, furniture))
            pending.clear()

    index = 0
    while index < len(blocks):
        block = blocks[index]
        if block.get("type") == "text" and block.get("text_level", 0) > 0:
            flush()
            level = int(block["text_level"])
            while headings and int(headings[-1].get("text_level", 1)) >= level:
                headings.pop()
            headings.append(block)
            index += 1
            continue
        if block.get("type") not in ATOMIC_TYPES:
            pending.append(block)
            index += 1
            continue
        flush()
        group = [block]
        while index + 1 < len(blocks):
            following = blocks[index + 1]
            ids = frozenset((block.get("_native_id"), following.get("_native_id")))
            if (
                following.get("type") not in ATOMIC_TYPES
                or None in ids
                or ids not in pairs
            ):
                break
            group.append(following)
            block = following
            index += 1
        chunks.extend(pack_blocks(headings + group, furniture))
        index += 1
    flush()
    return chunks


def serialize_chunk(chunk: Any) -> dict[str, Any]:
    return {
        "text": chunk.text,
        "section_path": chunk.section_path,
        "indexed_text": chunk.indexed_text(),
        "page_start": chunk.page_start,
        "page_end": chunk.page_end,
        "regions": [region.as_dict() for region in chunk.regions],
        "reference": chunk.reference,
    }


def member_ids(chunk: dict, blocks: list[dict]) -> list[int]:
    members = []
    for region in chunk["regions"]:
        for block in blocks:
            node_id = block.get("_native_id")
            page = block.get("page_idx")
            if (
                isinstance(node_id, int)
                and isinstance(page, int)
                and page + 1 == region["page"]
                and block.get("bbox") == region["bbox"]
                and node_id not in members
            ):
                members.append(node_id)
    return members


def node_bbox(node: dict, sizes: list[dict[str, float]]) -> dict | None:
    page = node.get("page number")
    box = node.get("bounding box")
    if not isinstance(page, int) or not 1 <= page <= len(sizes):
        return None
    if not isinstance(box, list) or len(box) != 4:
        return None
    width, height = sizes[page - 1]["width"], sizes[page - 1]["height"]
    x0, y0, x1, y1 = box
    return {
        "page": page,
        "bbox": [
            round(x0 / width * 1000, 3),
            round((height - y1) / height * 1000, 3),
            round(x1 / width * 1000, 3),
            round((height - y0) / height * 1000, 3),
        ],
        "space": "page-1000-topleft",
    }


def attach_cell_regions(
    chunks: list[dict], nodes: dict[int, dict], parents: dict[int, int | None], sizes
) -> dict[str, int]:
    cells_by_table: dict[int, list[dict]] = {}
    total = 0
    for node_id, node in nodes.items():
        if node.get("type") != "table cell":
            continue
        parent = parents.get(node_id)
        while parent is not None and nodes.get(parent, {}).get("type") != "table":
            parent = parents.get(parent)
        region = node_bbox(node, sizes)
        text = norm(node_text(node))
        if parent is not None and region and text:
            total += 1
            cells_by_table.setdefault(parent, []).append(
                {"native_cell_id": node_id, "text": text, **region}
            )
    attached_ids: set[int] = set()
    repeated = absent = 0
    for chunk in chunks:
        chunk_text = norm(chunk["text"])
        matches = []
        for table_id in set(chunk["member_ids"]):
            table_cells = cells_by_table.get(table_id, [])
            frequencies = Counter(cell["text"] for cell in table_cells)
            for cell in table_cells:
                if frequencies[cell["text"]] > 1:
                    repeated += 1
                    continue
                if len(cell["text"]) < 2 or cell["text"] not in chunk_text:
                    absent += 1
                    continue
                matches.append({k: v for k, v in cell.items() if k != "text"})
        unique = {(item["native_cell_id"], item["page"]): item for item in matches}
        chunk["cell_regions"] = list(unique.values())
        attached_ids.update(item["native_cell_id"] for item in unique.values())
    return {
        "native_cells_with_usable_bbox_and_text": total,
        "unique_cell_ids_attached": len(attached_ids),
        "repeated_text_abstentions": repeated,
        "absent_text_abstentions": absent,
    }


def percentile(values: list[int], fraction: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[math.ceil(fraction * len(ordered)) - 1]


def chunk_stats(chunks: list[dict]) -> dict[str, Any]:
    from pipeline.retrieval.chunking import estimate_tokens

    sizes = [estimate_tokens(chunk["text"]) for chunk in chunks]
    mixed_list_prose = 0
    multiple_atomic = 0
    for chunk in chunks:
        kinds = chunk["member_types"]
        if "list" in kinds and any(kind not in {"list", "heading"} for kind in kinds):
            mixed_list_prose += 1
        if sum(kind in ATOMIC_TYPES for kind in kinds) > 1:
            multiple_atomic += 1
    return {
        "chunks": len(chunks),
        "tokens": {
            "mean": mean(sizes) if sizes else 0,
            "median": median(sizes) if sizes else 0,
            "p95": percentile(sizes, 0.95),
            "max": max(sizes, default=0),
        },
        "chunks_crossing_pages": sum(
            chunk["page_start"] is not None
            and chunk["page_end"] is not None
            and chunk["page_start"] != chunk["page_end"]
            for chunk in chunks
        ),
        "chunks_with_multiple_regions": sum(
            len(chunk["regions"]) > 1 for chunk in chunks
        ),
        "mean_regions_per_chunk": mean([len(chunk["regions"]) for chunk in chunks])
        if chunks
        else 0,
        "chunks_mixing_list_and_prose": mixed_list_prose,
        "chunks_with_multiple_list_or_table_nodes": multiple_atomic,
    }


def load_questions(fixture: dict) -> list[dict]:
    selected = []
    for record in fixture["question_fixtures"]:
        wanted = set(record["question_ids"])
        questions = read_json(resolve(record["path"]))["questions"]
        selected.extend(question for question in questions if question["id"] in wanted)
        found = {question["id"] for question in questions if question["id"] in wanted}
        if found != wanted:
            raise ValueError(f"missing question ids: {wanted - found}")
    return selected


def token_terms(text: str) -> list[str]:
    from pipeline.retrieval.chunking import tokenize_for_search

    return re.findall(r"[^\W_]+", tokenize_for_search(text).casefold(), re.UNICODE)


def bm25_rank(chunks: list[dict], query: str) -> list[int]:
    documents = [Counter(token_terms(chunk["indexed_text"])) for chunk in chunks]
    lengths = [sum(document.values()) for document in documents]
    average = mean(lengths) if lengths else 1
    query_terms = set(token_terms(query))
    frequencies = {
        term: sum(term in document for document in documents) for term in query_terms
    }
    scored = []
    for index, document in enumerate(documents):
        score = 0.0
        for term in query_terms:
            frequency = document.get(term, 0)
            if not frequency:
                continue
            df = frequencies[term]
            inverse = math.log(1 + (len(documents) - df + 0.5) / (df + 0.5))
            denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * lengths[index] / average)
            score += inverse * frequency * 2.2 / denominator
        scored.append((score, index))
    return [index for _, index in sorted(scored, key=lambda item: (-item[0], item[1]))]


def retrieval_metrics(chunks: list[dict], questions: list[dict]) -> dict[str, Any]:
    records = []
    for question in questions:
        relevant = set()
        for index, chunk in enumerate(chunks):
            if chunk["source_id"] not in question["source_ids"]:
                continue
            pages = {
                evidence.get("pdf_page")
                for evidence in question.get("evidence", [])
                if evidence.get("source_id") == chunk["source_id"]
            }
            if any(
                isinstance(page, int)
                and chunk["page_start"] is not None
                and chunk["page_end"] is not None
                and chunk["page_start"] <= page <= chunk["page_end"]
                for page in pages
            ):
                relevant.add(index)
        ranking = bm25_rank(chunks, question["question"])
        rank = next(
            (
                position
                for position, index in enumerate(ranking, 1)
                if index in relevant
            ),
            None,
        )
        records.append(
            {
                "id": question["id"],
                "split": question["split"],
                "language": question["language"],
                "rank": rank,
                "hit_at_5": rank is not None and rank <= 5,
            }
        )
    return {
        "questions": len(records),
        "hit_at_5": sum(record["hit_at_5"] for record in records),
        "mrr": mean(
            [1 / record["rank"] if record["rank"] else 0 for record in records]
        ),
        "by_split": {
            split: {
                "questions": sum(record["split"] == split for record in records),
                "hit_at_5": sum(
                    record["hit_at_5"] for record in records if record["split"] == split
                ),
            }
            for split in sorted({record["split"] for record in records})
        },
        "records": records,
    }


def evidence_coverage(chunks: list[dict], questions: list[dict]) -> dict[str, Any]:
    records = []
    for question in questions:
        for evidence in question.get("evidence", []):
            literal = evidence.get("literal_source_text")
            if not isinstance(literal, str) or not literal.strip():
                continue
            expected = set(token_terms(literal))
            if not expected:
                continue
            candidates = [
                chunk
                for chunk in chunks
                if chunk["source_id"] == evidence["source_id"]
                and chunk["page_start"] is not None
                and chunk["page_end"] is not None
                and chunk["page_start"] <= evidence["pdf_page"] <= chunk["page_end"]
            ]
            best = max(
                (
                    len(expected & set(token_terms(chunk["text"]))) / len(expected)
                    for chunk in candidates
                ),
                default=0,
            )
            records.append({"id": question["id"], "coverage": best})
    return {
        "evidence_spans": len(records),
        "mean_max_unique_term_coverage": mean(
            [record["coverage"] for record in records]
        )
        if records
        else None,
        "complete_spans": sum(record["coverage"] == 1 for record in records),
        "records": records,
    }


def source_probe_metrics(chunks: list[dict], probes: list[dict]) -> dict[str, Any]:
    records = []
    for probe in probes:
        candidates = [
            chunk
            for chunk in chunks
            if chunk["source_id"] == probe["source_id"]
            and chunk["page_start"] is not None
            and chunk["page_end"] is not None
            and chunk["page_start"] <= probe["page"] <= chunk["page_end"]
        ]
        matches = [
            chunk
            for chunk in candidates
            if all(
                norm(anchor) in norm(chunk["text"])
                for anchor in probe["required_anchors"]
            )
        ]
        clean = [
            chunk
            for chunk in matches
            if not any(
                norm(anchor) in norm(chunk["text"])
                for anchor in probe["forbidden_anchors"]
            )
        ]
        best = min(matches, key=lambda chunk: len(chunk["text"])) if matches else None
        records.append(
            {
                "id": probe["id"],
                "complete": bool(matches),
                "clean": bool(clean),
                "regions": len(best["regions"]) if best else None,
                "tokens": len(token_terms(best["text"])) if best else None,
                "page_start": best["page_start"] if best else None,
                "page_end": best["page_end"] if best else None,
                "bbox": best["regions"]
                if probe["id"] == "jlpt-question-10-opening" and best
                else None,
            }
        )
    return {
        "probes": len(records),
        "complete": sum(record["complete"] for record in records),
        "clean": sum(record["clean"] for record in records),
        "records": records,
    }


def evaluate(args: argparse.Namespace) -> None:
    from pipeline.retrieval.packing import pack_blocks

    fixture = verify_fixture(args.fixture.resolve())
    run_root = args.run_root.resolve()
    freeze = read_json(run_root / "freeze.json")
    if freeze["fixture"]["sha256"] != sha256(args.fixture.resolve()):
        raise ValueError("fixture changed after prepare")
    if freeze["sources_sha256"] != sha256(run_root / "sources.json"):
        raise ValueError("prepared source receipt changed")
    prepared = {record["id"]: record for record in read_json(run_root / "sources.json")}
    all_arms = {"current": [], "hard_boundaries": [], "validated_relationships": []}
    summaries: dict[str, dict] = {}
    relationship_summary = Counter()
    for source in fixture["sources"]:
        receipt = prepared[source["id"]]
        pdf = Path(receipt["pdf"])
        native = read_json(Path(receipt["native"]))
        blocks = read_json(Path(receipt["blocks"]))
        furniture_value = (
            read_json(Path(receipt["furniture"])) if receipt.get("furniture") else []
        )
        furniture = frozenset(
            furniture_value if isinstance(furniture_value, list) else []
        )
        nodes, parents = native_nodes(native)
        relations = strict_relationships(nodes)
        relationship_summary["continuation_records"] += relations[
            "continuation_records"
        ]
        relationship_summary["valid_continuation_pairs"] += len(
            relations["valid_continuation_pairs"]
        )
        relationship_summary["caption_records"] += relations["caption_records"]
        relationship_summary["valid_captions"] += len(relations["valid_captions"])
        relationship_summary.update(
            {f"rejected_{key}": value for key, value in relations["rejected"].items()}
        )
        candidate_blocks = enrich_relationships(blocks, nodes, relations)
        objects = {
            "current": pack_blocks(blocks, furniture),
            "hard_boundaries": pack_structural(blocks, furniture),
            "validated_relationships": pack_structural(
                candidate_blocks,
                furniture,
                relations["valid_continuation_pairs"],
            ),
        }
        source_summary = {}
        source_summary["relationships"] = {
            "continuation_records": relations["continuation_records"],
            "valid_continuation_pairs": len(relations["valid_continuation_pairs"]),
            "caption_records": relations["caption_records"],
            "valid_captions": len(relations["valid_captions"]),
            "rejected": relations["rejected"],
        }
        for arm, arm_objects in objects.items():
            arm_chunks = [serialize_chunk(chunk) for chunk in arm_objects]
            members_from = (
                candidate_blocks if arm == "validated_relationships" else blocks
            )
            for chunk in arm_chunks:
                chunk["source_id"] = source["id"]
                chunk["member_ids"] = member_ids(chunk, members_from)
                chunk["member_types"] = [
                    nodes.get(node_id, {}).get("type")
                    for node_id in chunk["member_ids"]
                ]
            cell_stats = None
            if arm == "validated_relationships":
                cell_stats = attach_cell_regions(
                    arm_chunks, nodes, parents, page_sizes(pdf)
                )
            source_summary[arm] = {
                "stats": chunk_stats(arm_chunks),
                "cell_regions": cell_stats,
            }
            all_arms[arm].extend(arm_chunks)
            write_json(run_root / "chunks" / arm / f"{source['id']}.json", arm_chunks)
        summaries[source["id"]] = source_summary
    result = {
        "schema_version": 1,
        "evaluated_at_utc": utc_now(),
        "fixture_sha256": sha256(args.fixture.resolve()),
        "freeze_sha256": sha256(run_root / "freeze.json"),
        "sources_sha256": sha256(run_root / "sources.json"),
        "relationships": dict(relationship_summary),
        "sources": summaries,
        "arms": {},
    }
    questions = load_questions(fixture)
    for arm, chunks in all_arms.items():
        result["arms"][arm] = {
            "stats": chunk_stats(chunks),
            "probes": source_probe_metrics(chunks, fixture["source_span_probes"]),
            "evidence_coverage": evidence_coverage(chunks, questions),
            "lexical_retrieval": retrieval_metrics(chunks, questions),
        }
    write_json(run_root / "results.json", result)
    print(json.dumps({"results": str(run_root / "results.json")}, indent=2))


def check(args: argparse.Namespace) -> None:
    run_root = args.run_root.resolve()
    fixture = verify_fixture(args.fixture.resolve())
    freeze = read_json(run_root / "freeze.json")
    result = read_json(run_root / "results.json")
    assert freeze["fixture"]["sha256"] == sha256(args.fixture.resolve())
    assert freeze["sources_sha256"] == sha256(run_root / "sources.json")
    assert result["fixture_sha256"] == sha256(args.fixture.resolve())
    assert set(result["arms"]) == {
        "current",
        "hard_boundaries",
        "validated_relationships",
    }
    assert result["arms"]["current"]["probes"]["probes"] == len(
        fixture["source_span_probes"]
    )
    print(
        json.dumps(
            {"status": "ok", "results_sha256": sha256(run_root / "results.json")}
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("prepare", "evaluate", "check"))
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--run-root", type=Path, default=DEFAULT_RUN_ROOT)
    parser.add_argument("--jar", type=Path, default=DEFAULT_JAR)
    parser.add_argument("--java", default="java")
    parser.add_argument("--timeout", type=int, default=900)
    args = parser.parse_args()
    {"prepare": prepare, "evaluate": evaluate, "check": check}[args.command](args)


if __name__ == "__main__":
    main()
