#!/usr/bin/env python3
"""Evaluate one conservative boundary between unrelated adjacent atomic blocks."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import time
import unicodedata
from collections import Counter
from dataclasses import asdict
from datetime import datetime, timezone
from itertools import pairwise
from pathlib import Path
from statistics import mean, median
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "bench/parsers/fixtures/section_boundary_fixtures.json"
RUN_ROOT = ROOT / "bench/parsers/reports/local/2026-09-13-section-boundaries"
ATOMIC_TYPES = frozenset({"list", "table"})
EMBED_ROOT = RUN_ROOT / "embedding"
REUSE_ROOT = (
    ROOT / "bench/parsers/reports/local/2026-09-13-structure-chunking/embedding"
)
JLPT_REUSE_ROOT = ROOT / "bench/rag/reports/local/2026-09-13-jlpt-lookup"
MODEL = "Qwen/Qwen3-Embedding-4B"
ENDPOINT = "https://api.deepinfra.com/v1/openai/embeddings"
DIMENSIONS = 2560


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


def resolve(path: str) -> Path:
    lexical = (ROOT / path).absolute()
    if lexical != ROOT.absolute() and ROOT.absolute() not in lexical.parents:
        raise ValueError(f"path escapes repository: {path}")
    return lexical.resolve()


def norm(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(text))).casefold()


def node_text(node: dict) -> str:
    parts = []
    for key in ("content", "text"):
        if isinstance(node.get(key), str):
            parts.append(node[key])
    for key in ("kids", "list items", "toc items", "rows", "cells"):
        parts.extend(
            node_text(child) for child in node.get(key, []) if isinstance(child, dict)
        )
    return "\n".join(value for value in parts if value)


def block_text(block: dict) -> str:
    values = [block.get("text", "")]
    values.extend(block.get("list_items", []))
    values.extend(block.get("table_caption", []))
    if block.get("table_body"):
        values.append(block["table_body"])
    return "\n".join(str(value) for value in values if value)


def native_nodes(document: Any) -> tuple[dict[int, dict], dict[int, int | None]]:
    nodes: dict[int, dict] = {}
    parents: dict[int, int | None] = {}

    def visit(value: Any, parent: int | None = None) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item, parent)
            return
        if not isinstance(value, dict):
            return
        identity = value.get("id")
        current = identity if isinstance(identity, int) else parent
        if isinstance(identity, int):
            if identity in nodes:
                raise ValueError(f"duplicate native node id {identity}")
            nodes[identity] = value
            parents[identity] = parent
        for key in ("kids", "list items", "toc items", "rows", "cells"):
            visit(value.get(key, []), current)

    visit(document)
    return nodes, parents


def accepted_continuations(nodes: dict[int, dict]) -> tuple[set[frozenset[int]], dict]:
    accepted: set[frozenset[int]] = set()
    rejected = Counter()
    examined: set[tuple[int, str, int]] = set()
    for node_id, node in nodes.items():
        for key, inverse in (
            ("next list id", "previous list id"),
            ("previous list id", "next list id"),
            ("next table id", "previous table id"),
            ("previous table id", "next table id"),
        ):
            target_id = node.get(key)
            if not isinstance(target_id, int) or (node_id, key, target_id) in examined:
                continue
            examined.add((node_id, key, target_id))
            target = nodes.get(target_id)
            if target is None:
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
                accepted.add(frozenset((node_id, target_id)))
    return accepted, {
        "records_examined": len(examined),
        "rule_accepted_pairs": len(accepted),
        "rejected": dict(rejected),
        "human_validated": False,
    }


def inherited_headings(blocks: list[dict], end: int) -> list[dict]:
    stack: list[tuple[int, str]] = []
    for block in blocks[:end]:
        level = block.get("text_level")
        text = block.get("text")
        if block.get("type") != "text" or not isinstance(level, int) or level <= 0:
            continue
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, str(text)))
    return [
        {"type": "text", "text_level": level, "text": text} for level, text in stack
    ]


def candidate_pack(
    blocks: list[dict], furniture: frozenset[str], accepted: set[frozenset[int]]
) -> tuple[list, list[dict]]:
    from pipeline.retrieval.packing import pack_blocks

    cuts = []
    for index in range(1, len(blocks)):
        previous, following = blocks[index - 1], blocks[index]
        if (
            previous.get("type") not in ATOMIC_TYPES
            or following.get("type") not in ATOMIC_TYPES
        ):
            continue
        identities = frozenset(
            (previous.get("_native_id"), following.get("_native_id"))
        )
        if None in identities or identities not in accepted:
            cuts.append(
                {
                    "index": index,
                    "previous_native_id": previous.get("_native_id"),
                    "previous_type": previous.get("type"),
                    "following_native_id": following.get("_native_id"),
                    "following_type": following.get("type"),
                    "previous_page": previous.get("page_idx"),
                    "following_page": following.get("page_idx"),
                }
            )
    boundaries = [0, *(cut["index"] for cut in cuts), len(blocks)]
    chunks = []
    for segment_index, (start, end) in enumerate(pairwise(boundaries)):
        seed = inherited_headings(blocks, start) if segment_index else []
        chunks.extend(pack_blocks(seed + copy.deepcopy(blocks[start:end]), furniture))
    return chunks, cuts


def validate_candidate_input(blocks: list[dict], source_id: str) -> None:
    violations = []
    for index in range(1, len(blocks)):
        previous, following = blocks[index - 1], blocks[index]
        if (
            previous.get("type") not in ATOMIC_TYPES
            or following.get("type") not in ATOMIC_TYPES
        ):
            continue
        previous_id = previous.get("_native_id")
        following_id = following.get("_native_id")
        if (
            not isinstance(previous_id, int)
            or not isinstance(following_id, int)
            or previous_id == following_id
        ):
            violations.append(
                {
                    "index": index,
                    "previous_native_id": previous_id,
                    "following_native_id": following_id,
                }
            )
    if violations:
        raise ValueError(
            f"{source_id} has adjacent atomic blocks without two distinct native ids: {violations[:3]}"
        )


def serialize_chunks(
    source: dict, arm: str, chunks: list, blocks: list[dict]
) -> list[dict]:
    nodes, _ = native_nodes(read_json(resolve(source["native"])))
    by_location: dict[tuple[int, tuple], list[dict]] = {}
    for block in blocks:
        page, bbox = block.get("page_idx"), block.get("bbox")
        if isinstance(page, int) and isinstance(bbox, list) and len(bbox) == 4:
            by_location.setdefault((page + 1, tuple(bbox)), []).append(block)
    result = []
    for index, chunk in enumerate(chunks):
        members = []
        for region in chunk.regions:
            for block in by_location.get((region.page, tuple(region.bbox)), []):
                identity = block.get("_native_id")
                if not isinstance(identity, int) or any(
                    member["id"] == identity for member in members
                ):
                    continue
                node = nodes.get(identity, {})
                text = block_text(block) or node_text(node)
                members.append(
                    {
                        "id": identity,
                        "kind": str(block.get("_native_type") or block.get("type")),
                        "text": text,
                    }
                )
        result.append(
            {
                **asdict(chunk),
                "id": f"{arm}:{source['id']}:{index}",
                "file_id": source["id"],
                "indexed_text": chunk.indexed_text(),
                "native_blocks": members,
            }
        )
    return result


def chunk_signature(chunk: dict) -> dict:
    return {
        key: chunk.get(key)
        for key in (
            "text",
            "section_path",
            "page_start",
            "page_end",
            "regions",
            "reference",
        )
    }


def percentile(values: list[int], fraction: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[math.ceil(len(ordered) * fraction) - 1]


def chunk_stats(chunks: list[dict]) -> dict:
    from pipeline.retrieval.chunking import estimate_tokens

    sizes = [estimate_tokens(chunk["text"]) for chunk in chunks]
    confidences = [
        chunk["confidence"]
        for chunk in chunks
        if isinstance(chunk.get("confidence"), (int, float))
    ]
    return {
        "chunks": len(chunks),
        "estimated_tokens": {
            "mean": mean(sizes) if sizes else 0,
            "median": median(sizes) if sizes else 0,
            "p95": percentile(sizes, 0.95),
            "max": max(sizes, default=0),
        },
        "cross_page_chunks": sum(
            chunk["page_start"] is not None
            and chunk["page_end"] is not None
            and chunk["page_start"] != chunk["page_end"]
            for chunk in chunks
        ),
        "mean_regions": mean([len(chunk["regions"]) for chunk in chunks])
        if chunks
        else 0,
        "mean_confidence": mean(confidences) if confidences else None,
        "confidence_below_0_7": sum(value < 0.7 for value in confidences),
    }


def probe_metrics(chunks: list[dict], probes: list[dict]) -> dict:
    records = []
    for probe in probes:
        candidates = [
            chunk
            for chunk in chunks
            if chunk["file_id"] == probe["source_id"]
            and all(
                norm(anchor) in norm(chunk["text"])
                for anchor in probe["required_anchors"]
            )
        ]
        best = min(candidates, key=lambda chunk: len(chunk["text"]), default=None)
        records.append(
            {
                "id": probe["id"],
                "complete": best is not None,
                "clean": best is not None
                and not any(
                    norm(anchor) in norm(best["text"])
                    for anchor in probe.get("forbidden_anchors", [])
                ),
                "chunk_id": best["id"] if best else None,
                "text_sha256": hashlib.sha256(best["indexed_text"].encode()).hexdigest()
                if best
                else None,
                "regions": best["regions"] if best else None,
                "confidence": best["confidence"] if best else None,
            }
        )
    return {
        "probes": len(records),
        "complete": sum(record["complete"] for record in records),
        "clean": sum(record["clean"] for record in records),
        "records": records,
    }


def load_questions(fixture: dict) -> list[dict]:
    questions = []
    source_ids = {source["id"] for source in fixture["sources"]}
    for record in fixture["question_fixtures"]:
        path = resolve(record["path"])
        if sha256(path) != record["sha256"]:
            raise ValueError(f"question fixture changed: {path}")
        wanted = set(record["question_ids"])
        for question in read_json(path)["questions"]:
            if question["id"] in wanted and set(question["source_ids"]) <= source_ids:
                questions.append(question)
    return questions


def load_locator_controls(fixture: dict) -> dict:
    record = fixture["locator_fixture"]
    path = resolve(record["path"])
    if sha256(path) != record["sha256"]:
        raise ValueError("locator fixture changed")
    controls = read_json(path)
    wanted = set(record["case_ids"])
    cases = [case for case in controls["cases"] if case["id"] in wanted]
    if len(cases) != len(wanted):
        raise ValueError("locator fixture is missing frozen cases")
    return {**controls, "cases": cases}


def locator_probes(controls: dict) -> list[dict]:
    return [
        {
            "id": f"locator:{case['id']}",
            "source_id": case["expected"]["source_id"],
            "required_anchors": case["expected"]["anchors"],
            "forbidden_anchors": [],
        }
        for case in controls["cases"]
        if case["expected"]["outcome"] == "resolve"
    ]


def page_proxy(chunks: list[dict], questions: list[dict]) -> dict:
    records = []
    for question in questions:
        relevant = [
            chunk["id"]
            for chunk in chunks
            for evidence in question.get("evidence", [])
            if isinstance(evidence.get("pdf_page"), int)
            and chunk["file_id"] == evidence["source_id"]
            and chunk["page_start"] is not None
            and chunk["page_end"] is not None
            and chunk["page_start"] <= evidence["pdf_page"] <= chunk["page_end"]
        ]
        records.append(
            {
                "id": question["id"],
                "answerability": question["answerability"],
                "gold_page_chunk_ids": relevant,
            }
        )
    return {"questions": len(records), "records": records}


def freeze(args: argparse.Namespace) -> None:
    from pipeline.config import cfg

    fixture = read_json(args.fixture.resolve())
    run_root = args.run_root.resolve()
    if run_root.exists():
        raise FileExistsError(run_root)
    source_receipts = {}
    for source in fixture["sources"]:
        paths = {}
        for key in ("pdf", "blocks", "furniture", "native", "baseline_chunks"):
            path = resolve(source[key])
            expected = source[f"{key}_sha256"]
            if sha256(path) != expected:
                raise ValueError(f"{source['id']} {key} changed")
            paths[key] = {"path": source[key], "sha256": expected}
        validate_candidate_input(read_json(resolve(source["blocks"])), source["id"])
        source_receipts[source["id"]] = paths
    load_questions(fixture)
    load_locator_controls(fixture)
    run_root.mkdir(parents=True)
    write_json(
        run_root / "freeze.json",
        {
            "schema_version": 1,
            "frozen_at_utc": datetime.now(timezone.utc).isoformat(),
            "candidate": "cut only between adjacent list/table blocks unless a reciprocal same-type continuation at matching level within one page is rule-accepted",
            "known_prior": "chosen after the broad structure-chunking outcomes were known; no held-out-selection claim",
            "chunk_tokens": cfg.chunk_tokens,
            "fixture_sha256": sha256(args.fixture.resolve()),
            "script_sha256": sha256(Path(__file__)),
            "sources": source_receipts,
            "locator_fixture_sha256": fixture["locator_fixture"]["sha256"],
            "candidate_results_viewed": False,
        },
    )
    print(
        json.dumps(
            {
                "sources": len(source_receipts),
                "questions": len(load_questions(fixture)),
                "locator_cases": len(load_locator_controls(fixture)["cases"]),
            }
        )
    )


def evaluate(args: argparse.Namespace) -> None:
    from pipeline.config import cfg
    from pipeline.retrieval.confidence import ocr_pages, score_chunks
    from pipeline.retrieval.headings import retain_headings
    from pipeline.retrieval.packing import pack_blocks

    run_root = args.run_root.resolve()
    fixture = read_json(args.fixture.resolve())
    frozen = read_json(run_root / "freeze.json")
    if frozen["fixture_sha256"] != sha256(args.fixture.resolve()):
        raise ValueError("fixture changed after freeze")
    controls = load_locator_controls(fixture)
    if frozen["locator_fixture_sha256"] != fixture["locator_fixture"]["sha256"]:
        raise ValueError("locator fixture receipt changed")
    if cfg.chunk_tokens != frozen["chunk_tokens"]:
        raise ValueError("chunk token configuration changed")
    all_chunks = {"current": [], "adjacent_atomic_boundary": []}
    source_results = {}
    ranking_sources = []
    for source in fixture["sources"]:
        for key, receipt in frozen["sources"][source["id"]].items():
            if sha256(resolve(receipt["path"])) != receipt["sha256"]:
                raise ValueError(f"{source['id']} {key} changed after freeze")
        blocks = read_json(resolve(source["blocks"]))
        validate_candidate_input(blocks, source["id"])
        furniture_value = read_json(resolve(source["furniture"]))
        if isinstance(furniture_value, dict):
            furniture_value = furniture_value.get("furniture")
        if not isinstance(furniture_value, list):
            raise TypeError(f"{source['id']} invalid furniture")
        furniture = frozenset(furniture_value)
        pdf = resolve(source["pdf"])
        nodes, _ = native_nodes(read_json(resolve(source["native"])))
        accepted, relationship_receipt = accepted_continuations(nodes)
        baseline_objects = pack_blocks(copy.deepcopy(blocks), furniture)
        candidate_objects, cuts = candidate_pack(blocks, furniture, accepted)
        arm_objects = {
            "current": retain_headings(blocks, pdf, baseline_objects),
            "adjacent_atomic_boundary": retain_headings(blocks, pdf, candidate_objects),
        }
        for objects in arm_objects.values():
            score_chunks(objects, pdf, ocr=ocr_pages(blocks))
        arms = {
            arm: serialize_chunks(source, arm, chunks, blocks)
            for arm, chunks in arm_objects.items()
        }
        expected = read_json(resolve(source["baseline_chunks"]))
        current_signatures = [chunk_signature(chunk) for chunk in arms["current"]]
        expected_signatures = [chunk_signature(chunk) for chunk in expected]
        first_difference = next(
            (
                index
                for index, (current, retained) in enumerate(
                    zip(current_signatures, expected_signatures, strict=False)
                )
                if current != retained
            ),
            None,
        )
        if first_difference is None and len(current_signatures) != len(
            expected_signatures
        ):
            first_difference = min(len(current_signatures), len(expected_signatures))
        heading_changes = []
        baseline_paths = Counter(chunk["section_path"] for chunk in arms["current"])
        candidate_paths = Counter(
            chunk["section_path"] for chunk in arms["adjacent_atomic_boundary"]
        )
        for path in sorted(set(baseline_paths) | set(candidate_paths)):
            if baseline_paths[path] != candidate_paths[path]:
                heading_changes.append(
                    {
                        "section_path": path,
                        "current": baseline_paths[path],
                        "candidate": candidate_paths[path],
                    }
                )
        source_results[source["id"]] = {
            "retained_baseline_comparison": {
                "matches": current_signatures == expected_signatures,
                "current_chunks": len(current_signatures),
                "retained_chunks": len(expected_signatures),
                "first_difference": first_difference,
            },
            "relationships": relationship_receipt,
            "candidate_cuts": cuts,
            "heading_path_count_changes": heading_changes,
            "arms": {arm: chunk_stats(chunks) for arm, chunks in arms.items()},
        }
        ranking_sources.append(
            {
                "file_id": source["id"],
                "filename": source["filename"],
                "source_ref": source["source_ref"],
            }
        )
        for arm, chunks in arms.items():
            all_chunks[arm].extend(chunks)
            write_json(run_root / "chunks" / arm / f"{source['id']}.json", chunks)
    questions = load_questions(fixture)
    result = {
        "schema_version": 1,
        "freeze_sha256": sha256(run_root / "freeze.json"),
        "fixture_sha256": frozen["fixture_sha256"],
        "sources": source_results,
        "arms": {
            arm: {
                "stats": chunk_stats(chunks),
                "probes": probe_metrics(
                    chunks,
                    [*fixture["source_span_probes"], *locator_probes(controls)],
                ),
                "gold_page_proxy": page_proxy(chunks, questions),
            }
            for arm, chunks in all_chunks.items()
        },
    }
    write_json(run_root / "results.json", result)
    write_json(
        run_root / "ranking-export.json",
        {
            "schema_version": 1,
            "sources": ranking_sources,
            "chunks": all_chunks,
            "cases": controls["cases"],
            "eligibility_note": "native_blocks contain direct refined/native body text only; inherited section paths and physical pages are not native labels",
        },
    )
    print(
        json.dumps(
            {arm: value["stats"]["chunks"] for arm, value in result["arms"].items()}
        )
    )


def check(args: argparse.Namespace) -> None:
    run_root = args.run_root.resolve()
    frozen = read_json(run_root / "freeze.json")
    result = read_json(run_root / "results.json")
    assert result["freeze_sha256"] == sha256(run_root / "freeze.json")
    assert result["fixture_sha256"] == frozen["fixture_sha256"]
    assert set(result["arms"]) == {"current", "adjacent_atomic_boundary"}
    exported = read_json(run_root / "ranking-export.json")
    assert set(exported["chunks"]) == set(result["arms"])
    assert all(
        len(exported["chunks"][arm]) == result["arms"][arm]["stats"]["chunks"]
        for arm in result["arms"]
    )
    print(
        json.dumps(
            {"status": "ok", "results_sha256": sha256(run_root / "results.json")}
        )
    )


def freeze_embeddings(args: argparse.Namespace) -> None:
    from pipeline.prompts.retrieval import qwen3_query
    from pipeline.retrieval.chunking import estimate_tokens

    run_root = args.run_root.resolve()
    embed_root = run_root / "embedding"
    if embed_root.exists():
        raise FileExistsError(embed_root)
    exported = read_json(run_root / "ranking-export.json")
    inputs: dict[str, dict] = {}
    arms = {}
    for arm, chunks in exported["chunks"].items():
        arms[arm] = []
        for chunk in chunks:
            text = chunk["indexed_text"]
            text_hash = hashlib.sha256(text.encode()).hexdigest()
            inputs.setdefault(
                text_hash, {"sha256": text_hash, "kind": "passage", "text": text}
            )
            arms[arm].append(
                {
                    "id": chunk["id"],
                    "file_id": chunk["file_id"],
                    "page_start": chunk["page_start"],
                    "page_end": chunk["page_end"],
                    "text_sha256": text_hash,
                }
            )
    queries = []
    for case in exported["cases"]:
        text = qwen3_query(case["query"])
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        inputs.setdefault(
            text_hash, {"sha256": text_hash, "kind": "query", "text": text}
        )
        queries.append(
            {
                "id": case["id"],
                "query_sha256": text_hash,
                "expected": case["expected"],
            }
        )
    reuse_freeze = read_json(REUSE_ROOT / "freeze.json")
    reuse_complete = read_json(REUSE_ROOT / "embedding-complete.json")
    if reuse_freeze["model"] != MODEL or reuse_freeze["dimensions"] != DIMENSIONS:
        raise ValueError("reuse cache has a different embedding pin")
    if sha256(REUSE_ROOT / "vectors.sqlite3") != reuse_complete["vectors_sha256"]:
        raise ValueError("reuse vector cache changed")
    with sqlite3.connect(REUSE_ROOT / "vectors.sqlite3") as database:
        available = {row[0] for row in database.execute("SELECT sha256 FROM vectors")}
    ordered = [inputs[key] for key in sorted(inputs)]
    reused = [item["sha256"] for item in ordered if item["sha256"] in available]
    pending = [item["sha256"] for item in ordered if item["sha256"] not in available]
    prepared = {"arms": arms, "queries": queries, "inputs": ordered}
    embed_root.mkdir(parents=True)
    write_json(embed_root / "prepared.json", prepared)
    write_json(
        embed_root / "freeze.json",
        {
            "schema_version": 1,
            "status": "frozen after structural results justified an embedding pass and before provider calls",
            "model": MODEL,
            "dimensions": DIMENSIONS,
            "endpoint": ENDPOINT,
            "query_wrapper": "pipeline.prompts.retrieval.qwen3_query",
            "passage_prefix": None,
            "prepared_sha256": sha256(embed_root / "prepared.json"),
            "ranking_export_sha256": sha256(run_root / "ranking-export.json"),
            "structure_results_sha256": sha256(run_root / "results.json"),
            "reuse_cache_sha256": reuse_complete["vectors_sha256"],
            "inputs": len(ordered),
            "passage_inputs": sum(item["kind"] == "passage" for item in ordered),
            "query_inputs": sum(item["kind"] == "query" for item in ordered),
            "reused_inputs": len(reused),
            "new_inputs": len(pending),
            "new_estimated_tokens": sum(
                estimate_tokens(inputs[key]["text"]) for key in pending
            ),
            "provider_token_cap": 1_000_000,
            "script_sha256": sha256(Path(__file__)),
        },
    )
    write_json(embed_root / "reuse.json", {"sha256": reused})
    print(json.dumps(read_json(embed_root / "freeze.json"), ensure_ascii=False))


def freeze_embeddings_v2(args: argparse.Namespace) -> None:
    from pipeline.prompts.retrieval import qwen3_query
    from pipeline.retrieval.chunking import estimate_tokens

    run_root = args.run_root.resolve()
    embed_root = run_root / "embedding"
    target = embed_root / "freeze-v2.json"
    if target.exists():
        raise FileExistsError(target)
    exported = read_json(run_root / "ranking-export.json")
    fixture = read_json(args.fixture.resolve())
    locator_controls = load_locator_controls(fixture)
    legacy_questions = load_questions(fixture)
    source_ids = {source["file_id"] for source in exported["sources"]}
    locator_source_ids = {source["source_id"] for source in locator_controls["sources"]}
    if not locator_source_ids <= source_ids:
        raise ValueError("locator source subset is missing from the full corpus")
    inputs: dict[str, dict] = {}
    arms = {}
    for arm, chunks in exported["chunks"].items():
        arms[arm] = []
        for chunk in chunks:
            text = chunk["indexed_text"]
            text_hash = hashlib.sha256(text.encode()).hexdigest()
            inputs.setdefault(
                text_hash, {"sha256": text_hash, "kind": "passage", "text": text}
            )
            arms[arm].append(
                {
                    "id": chunk["id"],
                    "file_id": chunk["file_id"],
                    "page_start": chunk["page_start"],
                    "page_end": chunk["page_end"],
                    "text_sha256": text_hash,
                }
            )
    queries = []

    def add_query(cohort: str, identity: str, query: str, expected: dict) -> None:
        text = qwen3_query(query)
        text_hash = hashlib.sha256(text.encode()).hexdigest()
        inputs.setdefault(
            text_hash, {"sha256": text_hash, "kind": "query", "text": text}
        )
        queries.append(
            {
                "cohort": cohort,
                "id": identity,
                "raw_query": query,
                "query_sha256": text_hash,
                "expected": expected,
            }
        )

    for case in locator_controls["cases"]:
        add_query("locator-8-source", case["id"], case["query"], case["expected"])
    for question in legacy_questions:
        add_query(
            "legacy-13-source",
            question["id"],
            question["question"],
            {
                "answerability": question["answerability"],
                "evidence": question.get("evidence", []),
            },
        )
    prior_jlpt_freeze = read_json(JLPT_REUSE_ROOT / "freeze.json")
    prior_jlpt_response = read_json(JLPT_REUSE_ROOT / "response.json")
    if (
        prior_jlpt_freeze["pin"]["embedding_model_slug"] != MODEL
        or prior_jlpt_freeze["pin"]["embedding_dim"] != DIMENSIONS
        or prior_jlpt_response["model"] != MODEL
    ):
        raise ValueError("JLPT query reuse has a different embedding pin")
    expected_jlpt_inputs = [
        qwen3_query(query) for query in prior_jlpt_freeze["queries"]
    ]
    if prior_jlpt_freeze["embedding_payload"]["input"][:5] != expected_jlpt_inputs:
        raise ValueError("JLPT query reuse has a different query wrapper")
    jlpt_probe = next(
        probe
        for probe in fixture["source_span_probes"]
        if probe["id"] == "jlpt-question-10-opening"
    )
    for index, query in enumerate(prior_jlpt_freeze["queries"], 1):
        add_query(
            "jlpt-13-source",
            f"jlpt-original-{index}",
            query,
            {
                "source_id": "jlpt-n1-2019",
                "required_anchors": jlpt_probe["required_anchors"],
                "forbidden_anchors": jlpt_probe["forbidden_anchors"],
            },
        )
    reuse_freeze = read_json(REUSE_ROOT / "freeze.json")
    reuse_complete = read_json(REUSE_ROOT / "embedding-complete.json")
    if reuse_freeze["model"] != MODEL or reuse_freeze["dimensions"] != DIMENSIONS:
        raise ValueError("primary reuse cache has a different embedding pin")
    if sha256(REUSE_ROOT / "vectors.sqlite3") != reuse_complete["vectors_sha256"]:
        raise ValueError("primary reuse vector cache changed")
    with sqlite3.connect(REUSE_ROOT / "vectors.sqlite3") as database:
        primary_available = {
            row[0] for row in database.execute("SELECT sha256 FROM vectors")
        }
    ordered = [inputs[key] for key in sorted(inputs)]
    input_keys = {item["sha256"] for item in ordered}
    primary_reuse = sorted(input_keys & primary_available)
    jlpt_reuse = sorted(
        hashlib.sha256(value.encode()).hexdigest() for value in expected_jlpt_inputs
    )
    if set(jlpt_reuse) & set(primary_reuse):
        raise ValueError("JLPT reuse unexpectedly overlaps the primary cache")
    reused = set(primary_reuse) | set(jlpt_reuse)
    pending = [item["sha256"] for item in ordered if item["sha256"] not in reused]
    prepared = {
        "arms": arms,
        "queries": queries,
        "inputs": ordered,
        "cohorts": {
            "locator-8-source": {
                "source_ids": sorted(locator_source_ids),
                "queries": 28,
                "relevance": "frozen locator outcome and exact source anchors",
            },
            "legacy-13-source": {
                "source_ids": sorted(source_ids),
                "queries": len(legacy_questions),
                "relevance": "frozen gold-page overlap proxy, answerability retained",
            },
            "jlpt-13-source": {
                "source_ids": sorted(source_ids),
                "queries": 5,
                "relevance": "frozen required-anchor target; cleanliness separate",
            },
        },
    }
    write_json(embed_root / "prepared-v2.json", prepared)
    write_json(
        target,
        {
            "schema_version": 2,
            "status": "scope-corrected freeze before provider calls; v1 is retained but must not be executed",
            "model": MODEL,
            "dimensions": DIMENSIONS,
            "endpoint": ENDPOINT,
            "query_wrapper": "pipeline.prompts.retrieval.qwen3_query",
            "passage_prefix": None,
            "prepared_sha256": sha256(embed_root / "prepared-v2.json"),
            "ranking_export_sha256": sha256(run_root / "ranking-export.json"),
            "structure_results_sha256": sha256(run_root / "results.json"),
            "locator_fixture_sha256": fixture["locator_fixture"]["sha256"],
            "legacy_question_fixture_sha256": {
                record["path"]: record["sha256"]
                for record in fixture["question_fixtures"]
            },
            "jlpt_prior_freeze_sha256": sha256(JLPT_REUSE_ROOT / "freeze.json"),
            "jlpt_prior_response_sha256": sha256(JLPT_REUSE_ROOT / "response.json"),
            "primary_reuse_cache_sha256": reuse_complete["vectors_sha256"],
            "inputs": len(ordered),
            "passage_inputs": sum(item["kind"] == "passage" for item in ordered),
            "query_inputs": sum(item["kind"] == "query" for item in ordered),
            "primary_reused_inputs": len(primary_reuse),
            "jlpt_reused_inputs": len(jlpt_reuse),
            "reused_inputs": len(reused),
            "new_inputs": len(pending),
            "new_estimated_tokens": sum(
                estimate_tokens(inputs[key]["text"]) for key in pending
            ),
            "provider_token_cap": 1_000_000,
            "cohorts": prepared["cohorts"],
            "script_sha256": sha256(Path(__file__)),
        },
    )
    write_json(
        embed_root / "reuse-v2.json",
        {"primary_sha256": primary_reuse, "jlpt_sha256": jlpt_reuse},
    )
    print(json.dumps(read_json(target), ensure_ascii=False))


def provider_key(args: argparse.Namespace) -> str:
    command = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-i",
        str(args.ssh_key.expanduser()),
        args.ssh_host,
        (
            "sed -n 's/^DEEPINFRA_API_KEY=//p' "
            "/opt/capy-ingest/releases/nonprod/current/uat.queue.env"
        ),
    ]
    completed = subprocess.run(
        command, capture_output=True, text=True, timeout=30, check=True
    )
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError("expected exactly one non-production embedding credential")
    key = lines[0]
    if len(key) >= 2 and key[0] == key[-1] and key[0] in {'"', "'"}:
        key = key[1:-1]
    if not key:
        raise RuntimeError("empty embedding credential")
    return key


def append_jsonl(path: Path, value: dict) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def embed(args: argparse.Namespace) -> None:
    import httpx
    import numpy as np

    embed_root = args.run_root.resolve() / "embedding"
    frozen = read_json(embed_root / "freeze-v2.json")
    prepared = read_json(embed_root / "prepared-v2.json")
    guard = read_json(embed_root / "pre-provider-guard-amendment.json")
    scope = read_json(embed_root / "pre-provider-scope-amendment.json")
    if (
        scope["pre_scope_script_sha256"] != guard["guarded_script_sha256"]
        or scope["scoped_script_sha256"] != sha256(Path(__file__))
        or frozen["script_sha256"] != sha256(Path(__file__))
    ):
        raise ValueError(
            "runner does not match the reviewed pre-provider amendment chain"
        )
    if sha256(embed_root / "prepared-v2.json") != frozen["prepared_sha256"]:
        raise ValueError("prepared inputs changed")
    if sha256(REUSE_ROOT / "vectors.sqlite3") != frozen["primary_reuse_cache_sha256"]:
        raise ValueError("frozen reuse vector cache changed")
    if sha256(JLPT_REUSE_ROOT / "freeze.json") != frozen["jlpt_prior_freeze_sha256"]:
        raise ValueError("frozen JLPT query manifest changed")
    if (
        sha256(JLPT_REUSE_ROOT / "response.json")
        != frozen["jlpt_prior_response_sha256"]
    ):
        raise ValueError("frozen JLPT query vectors changed")
    input_keys = [item["sha256"] for item in prepared["inputs"]]
    if (
        len(input_keys) != frozen["inputs"]
        or len(set(input_keys)) != len(input_keys)
        or sum(item["kind"] == "passage" for item in prepared["inputs"])
        != frozen["passage_inputs"]
        or sum(item["kind"] == "query" for item in prepared["inputs"])
        != frozen["query_inputs"]
    ):
        raise ValueError("prepared input counts do not match the freeze")
    with sqlite3.connect(REUSE_ROOT / "vectors.sqlite3") as source:
        cache_keys = {row[0] for row in source.execute("SELECT sha256 FROM vectors")}
    expected_primary_reuse = sorted(set(input_keys) & cache_keys)
    prior_jlpt = read_json(JLPT_REUSE_ROOT / "freeze.json")
    jlpt_keys_in_order = [
        hashlib.sha256(value.encode()).hexdigest()
        for value in prior_jlpt["embedding_payload"]["input"][:5]
    ]
    expected_jlpt_reuse = sorted(jlpt_keys_in_order)
    expected_reuse = set(expected_primary_reuse) | set(expected_jlpt_reuse)
    reuse_values = read_json(embed_root / "reuse-v2.json")
    if (
        reuse_values["primary_sha256"] != expected_primary_reuse
        or reuse_values["jlpt_sha256"] != expected_jlpt_reuse
        or len(expected_primary_reuse) != frozen["primary_reused_inputs"]
        or len(expected_jlpt_reuse) != frozen["jlpt_reused_inputs"]
        or len(expected_reuse) != frozen["reused_inputs"]
        or len(input_keys) - len(expected_reuse) != frozen["new_inputs"]
    ):
        raise ValueError("reuse set does not match the frozen inputs and cache")
    database = sqlite3.connect(embed_root / "vectors.sqlite3")
    database.execute(
        "CREATE TABLE vectors (sha256 TEXT PRIMARY KEY, value BLOB NOT NULL, origin TEXT NOT NULL)"
    )
    reuse = expected_reuse
    with sqlite3.connect(REUSE_ROOT / "vectors.sqlite3") as source:
        for key, value in source.execute("SELECT sha256, value FROM vectors"):
            if key in expected_primary_reuse:
                database.execute(
                    "INSERT INTO vectors VALUES (?, ?, ?)",
                    (key, value, "reuse-primary"),
                )
    prior_response = read_json(JLPT_REUSE_ROOT / "response.json")
    prior_rows = sorted(prior_response["data"], key=lambda row: row["index"])
    for key, row in zip(jlpt_keys_in_order, prior_rows[:5], strict=True):
        vector = np.asarray(row["embedding"], dtype=np.float32)
        if vector.shape != (DIMENSIONS,) or not np.isfinite(vector).all():
            raise ValueError("invalid reused JLPT query vector")
        database.execute(
            "INSERT INTO vectors VALUES (?, ?, ?)",
            (key, vector.tobytes(), "reuse-jlpt"),
        )
    database.commit()
    pending = [item for item in prepared["inputs"] if item["sha256"] not in reuse]
    key = provider_key(args)
    total_tokens = 0
    receipts = embed_root / "requests.jsonl"
    with httpx.Client(timeout=90) as client:
        for offset in range(0, len(pending), 64):
            batch = pending[offset : offset + 64]
            started = time.perf_counter()
            response = client.post(
                frozen["endpoint"],
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": frozen["model"],
                    "input": [item["text"] for item in batch],
                    "dimensions": frozen["dimensions"],
                    "encoding_format": "float",
                },
            )
            receipt = {
                "offset": offset,
                "count": len(batch),
                "status": response.status_code,
                "elapsed_ms": round(1000 * (time.perf_counter() - started), 3),
                "input_sha256": [item["sha256"] for item in batch],
            }
            if response.status_code != 200:
                append_jsonl(receipts, receipt)
                response.raise_for_status()
            payload = response.json()
            rows = sorted(payload["data"], key=lambda row: row["index"])
            if [row["index"] for row in rows] != list(range(len(batch))):
                raise ValueError("provider returned unexpected embedding indices")
            for item, row in zip(batch, rows, strict=True):
                vector = np.asarray(row["embedding"], dtype=np.float32)
                if (
                    vector.shape != (DIMENSIONS,)
                    or not np.isfinite(vector).all()
                    or np.linalg.norm(vector) == 0
                ):
                    raise ValueError("invalid provider embedding")
                database.execute(
                    "INSERT INTO vectors VALUES (?, ?, ?)",
                    (item["sha256"], vector.tobytes(), "provider"),
                )
            database.commit()
            usage = payload.get("usage") or {}
            total_tokens += int(usage.get("prompt_tokens") or 0)
            receipt.update(usage=usage, response_model=payload.get("model"))
            append_jsonl(receipts, receipt)
            if total_tokens > frozen["provider_token_cap"]:
                raise ValueError("provider token cap exceeded")
            print(
                json.dumps(
                    {
                        "embedded": offset + len(batch),
                        "of": len(pending),
                        "tokens": total_tokens,
                    }
                ),
                flush=True,
            )
    write_json(
        embed_root / "complete.json",
        {
            "inputs": len(prepared["inputs"]),
            "reused_inputs": len(reuse),
            "provider_inputs": len(pending),
            "provider_tokens": total_tokens,
            "prepared_sha256": frozen["prepared_sha256"],
            "requests_sha256": sha256(receipts),
            "vectors_sha256": sha256(embed_root / "vectors.sqlite3"),
        },
    )


def check_embeddings(args: argparse.Namespace) -> None:
    import numpy as np

    embed_root = args.run_root.resolve() / "embedding"
    frozen = read_json(embed_root / "freeze-v2.json")
    prepared = read_json(embed_root / "prepared-v2.json")
    complete = read_json(embed_root / "complete.json")
    assert sha256(embed_root / "prepared-v2.json") == frozen["prepared_sha256"]
    assert complete["prepared_sha256"] == frozen["prepared_sha256"]
    assert sha256(embed_root / "requests.jsonl") == complete["requests_sha256"]
    with sqlite3.connect(embed_root / "vectors.sqlite3") as database:
        rows = list(database.execute("SELECT sha256, value, origin FROM vectors"))
    assert {row[0] for row in rows} == {item["sha256"] for item in prepared["inputs"]}
    assert Counter(row[2] for row in rows) == {
        "reuse-primary": frozen["primary_reused_inputs"],
        "reuse-jlpt": frozen["jlpt_reused_inputs"],
        "provider": complete["provider_inputs"],
    }
    assert all(
        np.frombuffer(row[1], dtype=np.float32).shape == (frozen["dimensions"],)
        and np.isfinite(np.frombuffer(row[1], dtype=np.float32)).all()
        for row in rows
    )
    print(json.dumps({"status": "ok", "vectors_sha256": complete["vectors_sha256"]}))


def freeze_dense_score(args: argparse.Namespace) -> None:
    """Freeze one offline dense scorer before inspecting any ranking outcome."""
    run_root = args.run_root.resolve()
    embed_root = run_root / "embedding"
    output = embed_root / "dense-results.json"
    if output.exists():
        raise FileExistsError(output)
    prepared = read_json(embed_root / "prepared-v2.json")
    ranking = read_json(run_root / "ranking-export.json")
    frozen = read_json(embed_root / "freeze-v2.json")
    complete = read_json(embed_root / "complete.json")
    if sha256(embed_root / "prepared-v2.json") != frozen["prepared_sha256"]:
        raise ValueError("prepared embedding inputs changed")
    if sha256(embed_root / "vectors.sqlite3") != complete["vectors_sha256"]:
        raise ValueError("validated vector database changed")
    if {query["cohort"] for query in prepared["queries"]} != {
        "locator-8-source",
        "legacy-13-source",
        "jlpt-13-source",
    }:
        raise ValueError("unexpected dense cohorts")
    write_json(
        embed_root / "dense-freeze.json",
        {
            "schema_version": 1,
            "status": "frozen after embedding validation and before dense scores",
            "scorer_sha256": sha256(Path(__file__)),
            "executed_provider_runner_sha256": sha256(
                embed_root / "executed-provider-runner.py"
            ),
            "prepared_sha256": sha256(embed_root / "prepared-v2.json"),
            "vectors_sha256": sha256(embed_root / "vectors.sqlite3"),
            "ranking_export_sha256": sha256(run_root / "ranking-export.json"),
            "queries": len(prepared["queries"]),
            "arms": {name: len(rows) for name, rows in prepared["arms"].items()},
            "protocol": {
                "vector_storage": "format every float to six significant digits, cast to IEEE binary16, then cast to float32 for arithmetic",
                "similarity": "exhaustive cosine scan with float32 matrix multiplication; descending cosine then chunk id",
                "candidate_window": 40,
                "output": "soft cap four chunks per source, then first five",
                "locator_qrel": "resolve cases only; same frozen source and every frozen canonical anchor in the exact indexed text after NFKC, whitespace removal, and casefold",
                "legacy_qrel": "any chunk overlapping a frozen evidence PDF page in its frozen source; gold-page overlap proxy only",
                "jlpt_qrel": "same frozen source and every frozen required anchor in one indexed chunk; clean qrel also excludes every frozen forbidden anchor",
                "retained_audit": "full qrel ranks/cosines plus uncapped and soft-capped top-five indexed texts for every query, including abstentions, misses, and positive cases with zero qrels",
            },
            "cohorts": frozen["cohorts"],
            "ranking_schema": ranking["schema_version"],
        },
    )


def score_dense(args: argparse.Namespace) -> None:
    """Score all frozen cohorts with production storage precision and result limits."""
    import numpy as np

    run_root = args.run_root.resolve()
    embed_root = run_root / "embedding"
    output = embed_root / "dense-results.json"
    summary_path = embed_root / "dense-summary.json"
    if output.exists() or summary_path.exists():
        raise FileExistsError(output if output.exists() else summary_path)
    freeze = read_json(embed_root / "dense-freeze.json")
    prepared = read_json(embed_root / "prepared-v2.json")
    ranking = read_json(run_root / "ranking-export.json")
    if freeze["scorer_sha256"] != sha256(Path(__file__)):
        raise ValueError("dense scorer changed after freeze")
    for path, key in (
        (embed_root / "prepared-v2.json", "prepared_sha256"),
        (embed_root / "vectors.sqlite3", "vectors_sha256"),
        (run_root / "ranking-export.json", "ranking_export_sha256"),
    ):
        if sha256(path) != freeze[key]:
            raise ValueError(f"frozen dense input changed: {path}")
    with sqlite3.connect(embed_root / "vectors.sqlite3") as database:
        raw_vectors = {
            key: np.frombuffer(value, dtype=np.float32).copy()
            for key, value in database.execute("SELECT sha256, value FROM vectors")
        }

    def stored_unit(key: str) -> Any:
        vector = raw_vectors[key]
        vector = np.asarray(
            [float(f"{value:.6g}") for value in vector], dtype=np.float16
        ).astype(np.float32)
        length = np.linalg.norm(vector)
        if not np.isfinite(vector).all() or not np.isfinite(length) or length == 0:
            raise ValueError(f"invalid stored vector {key}")
        return vector / length

    chunk_rows = {
        arm: {chunk["id"]: chunk for chunk in rows}
        for arm, rows in ranking["chunks"].items()
    }
    prepared_rows = {
        arm: {chunk["id"]: chunk for chunk in rows}
        for arm, rows in prepared["arms"].items()
    }
    for arm, arm_chunk_rows in chunk_rows.items():
        if set(arm_chunk_rows) != set(prepared_rows[arm]):
            raise ValueError(f"prepared/ranking chunk ids differ for {arm}")
    matrices = {}
    ordered_chunks = {}
    for arm, rows in prepared_rows.items():
        ids = sorted(rows)
        ordered_chunks[arm] = ids
        matrices[arm] = np.asarray(
            [stored_unit(rows[chunk_id]["text_sha256"]) for chunk_id in ids],
            dtype=np.float32,
        )

    def contains(text: str, anchors: list[str]) -> bool:
        normalized = norm(text)
        return all(norm(anchor) in normalized for anchor in anchors)

    def qrels(query: dict, chunks: dict[str, dict]) -> tuple[set[str], set[str]]:
        expected = query["expected"]
        cohort = query["cohort"]
        if cohort == "locator-8-source":
            if expected["outcome"] != "resolve":
                return set(), set()
            relevant = {
                chunk_id
                for chunk_id, chunk in chunks.items()
                if chunk["file_id"] == expected["source_id"]
                and contains(chunk["indexed_text"], expected["anchors"])
            }
            return relevant, relevant
        if cohort == "legacy-13-source":
            evidence = {
                (item["source_id"], int(item["pdf_page"]))
                for item in expected["evidence"]
            }
            relevant = {
                chunk_id
                for chunk_id, chunk in chunks.items()
                if any(
                    chunk["file_id"] == source
                    and int(chunk["page_start"]) <= page <= int(chunk["page_end"])
                    for source, page in evidence
                )
            }
            return relevant, relevant
        if cohort == "jlpt-13-source":
            relevant = {
                chunk_id
                for chunk_id, chunk in chunks.items()
                if chunk["file_id"] == expected["source_id"]
                and contains(chunk["indexed_text"], expected["required_anchors"])
            }
            clean = {
                chunk_id
                for chunk_id in relevant
                if not any(
                    norm(anchor) in norm(chunks[chunk_id]["indexed_text"])
                    for anchor in expected["forbidden_anchors"]
                )
            }
            return relevant, clean
        raise ValueError(f"unknown cohort {cohort}")

    def soft_cap(rows: list[dict]) -> list[dict]:
        counts: Counter[str] = Counter()
        kept, overflow = [], []
        for row in rows:
            file_id = row["file_id"]
            if counts[file_id] < 4:
                counts[file_id] += 1
                kept.append(row)
            else:
                overflow.append(row)
        return kept + overflow

    records = []
    for query in prepared["queries"]:
        source_ids = set(freeze["cohorts"][query["cohort"]]["source_ids"])
        query_vector = stored_unit(query["query_sha256"])
        for arm in ("current", "adjacent_atomic_boundary"):
            all_ids = ordered_chunks[arm]
            eligible_indices = [
                index
                for index, chunk_id in enumerate(all_ids)
                if chunk_rows[arm][chunk_id]["file_id"] in source_ids
            ]
            similarities = matrices[arm][eligible_indices] @ query_vector
            ranked = sorted(
                (
                    {
                        "id": all_ids[index],
                        "file_id": chunk_rows[arm][all_ids[index]]["file_id"],
                        "cosine": float(cosine),
                    }
                    for index, cosine in zip(
                        eligible_indices, similarities.tolist(), strict=True
                    )
                ),
                key=lambda row: (-row["cosine"], row["id"]),
            )
            rank_by_id = {row["id"]: rank for rank, row in enumerate(ranked, 1)}
            relevant, clean = qrels(query, chunk_rows[arm])
            if not relevant <= set(rank_by_id) or not clean <= relevant:
                raise ValueError(f"qrels outside cohort for {query['id']} {arm}")
            candidate40 = ranked[:40]
            capped = soft_cap(candidate40)

            def audit_row(
                row: dict,
                position: int,
                chunks: dict[str, dict] = chunk_rows[arm],
                ranks: dict[str, int] = rank_by_id,
                relevant_ids: set[str] = relevant,
                clean_ids: set[str] = clean,
            ) -> dict:
                chunk = chunks[row["id"]]
                return {
                    **row,
                    "position": position,
                    "dense_rank": ranks[row["id"]],
                    "qrel": row["id"] in relevant_ids,
                    "clean_qrel": row["id"] in clean_ids,
                    "page_start": chunk["page_start"],
                    "page_end": chunk["page_end"],
                    "indexed_text": chunk["indexed_text"],
                }

            qrel_rows = [
                {
                    "id": chunk_id,
                    "rank": rank_by_id[chunk_id],
                    "cosine": next(
                        row["cosine"] for row in ranked if row["id"] == chunk_id
                    ),
                    "clean": chunk_id in clean,
                    "output_position": next(
                        (
                            position
                            for position, row in enumerate(capped[:5], 1)
                            if row["id"] == chunk_id
                        ),
                        None,
                    ),
                }
                for chunk_id in sorted(relevant, key=rank_by_id.get)
            ]
            record = {
                "cohort": query["cohort"],
                "id": query["id"],
                "arm": arm,
                "query": query["raw_query"],
                "expected": query["expected"],
                "eligible_chunks": len(ranked),
                "qrel_count": len(relevant),
                "clean_qrel_count": len(clean),
                "positive_zero_qrel": (
                    query["cohort"] == "locator-8-source"
                    and query["expected"]["outcome"] == "resolve"
                    and not relevant
                ),
                "first_qrel_rank": qrel_rows[0]["rank"] if qrel_rows else None,
                "first_clean_qrel_rank": min(
                    (rank_by_id[chunk_id] for chunk_id in clean), default=None
                ),
                "qrel_output_position": min(
                    (
                        row["output_position"]
                        for row in qrel_rows
                        if row["output_position"]
                    ),
                    default=None,
                ),
                "qrels": qrel_rows,
                "uncapped_top5": [
                    audit_row(row, position)
                    for position, row in enumerate(candidate40[:5], 1)
                ],
                "output_top5": [
                    audit_row(row, position)
                    for position, row in enumerate(capped[:5], 1)
                ],
            }
            records.append(record)

    def arm_summary(arm: str, cohort: str) -> dict:
        rows = [row for row in records if row["arm"] == arm and row["cohort"] == cohort]
        measurable = [row for row in rows if row["qrel_count"]]
        summary = {
            "queries": len(rows),
            "measurable_queries": len(measurable),
            "positive_zero_qrel": sum(row["positive_zero_qrel"] for row in rows),
            "output_hit_at_5": sum(
                row["qrel_output_position"] is not None for row in measurable
            ),
            "mean_reciprocal_output_rank": mean(
                1 / row["qrel_output_position"] if row["qrel_output_position"] else 0
                for row in measurable
            )
            if measurable
            else None,
            "mean_first_dense_qrel_rank": mean(
                row["first_qrel_rank"] for row in measurable
            )
            if measurable
            else None,
        }
        if cohort == "legacy-13-source":
            for answerability in ("answerable", "unanswerable"):
                subset = [
                    row
                    for row in measurable
                    if row["expected"]["answerability"] == answerability
                ]
                summary[answerability] = {
                    "queries": len(subset),
                    "gold_page_proxy_output_hit_at_5": sum(
                        row["qrel_output_position"] is not None for row in subset
                    ),
                }
        if cohort == "jlpt-13-source":
            summary["clean_complete_output_hit_at_5"] = sum(
                any(row["clean_qrel"] for row in result["output_top5"])
                for result in rows
            )
        return summary

    comparison = []
    by_key = {(row["cohort"], row["id"], row["arm"]): row for row in records}
    for query in prepared["queries"]:
        current = by_key[(query["cohort"], query["id"], "current")]
        candidate = by_key[(query["cohort"], query["id"], "adjacent_atomic_boundary")]
        comparison.append(
            {
                "cohort": query["cohort"],
                "id": query["id"],
                "current_first_qrel_rank": current["first_qrel_rank"],
                "candidate_first_qrel_rank": candidate["first_qrel_rank"],
                "current_output_position": current["qrel_output_position"],
                "candidate_output_position": candidate["qrel_output_position"],
                "qrel_count_change": candidate["qrel_count"] - current["qrel_count"],
            }
        )
    result = {
        "schema_version": 1,
        "dense_freeze_sha256": sha256(embed_root / "dense-freeze.json"),
        "records": records,
    }
    summary = {
        "schema_version": 1,
        "dense_freeze_sha256": result["dense_freeze_sha256"],
        "arms": {
            arm: {
                cohort: arm_summary(arm, cohort)
                for cohort in (
                    "locator-8-source",
                    "legacy-13-source",
                    "jlpt-13-source",
                )
            }
            for arm in ("current", "adjacent_atomic_boundary")
        },
        "comparison": comparison,
    }
    write_json(output, result)
    write_json(summary_path, summary)
    print(json.dumps(summary["arms"], ensure_ascii=False))


def audit_dense_locator_pages(args: argparse.Namespace) -> None:
    """Apply the omitted frozen page label to retained locator dense results."""
    run_root = args.run_root.resolve()
    embed_root = run_root / "embedding"
    output = embed_root / "dense-locator-page-audit.json"
    if output.exists():
        raise FileExistsError(output)
    amendment = read_json(embed_root / "posthoc-locator-page-amendment.json")
    dense_path = embed_root / "dense-results.json"
    ranking_path = run_root / "ranking-export.json"
    if sha256(dense_path) != amendment["dense_results_sha256"]:
        raise ValueError("original dense results changed")
    dense = read_json(dense_path)
    ranking = read_json(ranking_path)
    chunks = {
        arm: {chunk["id"]: chunk for chunk in rows}
        for arm, rows in ranking["chunks"].items()
    }
    records = []
    for original in dense["records"]:
        if original["cohort"] != "locator-8-source":
            continue
        expected = original["expected"]
        if expected["outcome"] == "resolve":
            corrected = [
                row
                for row in original["qrels"]
                if any(
                    chunks[original["arm"]][row["id"]]["page_start"]
                    <= page
                    <= chunks[original["arm"]][row["id"]]["page_end"]
                    for page in expected["physical_pages"]
                )
            ]
        else:
            corrected = []
        corrected_ids = {row["id"] for row in corrected}
        output_position = min(
            (
                row["position"]
                for row in original["output_top5"]
                if row["id"] in corrected_ids
            ),
            default=None,
        )
        records.append(
            {
                "id": original["id"],
                "arm": original["arm"],
                "expected_outcome": expected["outcome"],
                "source_id": expected.get("source_id"),
                "physical_pages": expected.get("physical_pages", []),
                "original_qrel_count": original["qrel_count"],
                "corrected_qrel_count": len(corrected),
                "qrel_changed": len(corrected) != original["qrel_count"],
                "positive_zero_qrel": expected["outcome"] == "resolve"
                and not corrected,
                "first_qrel_rank": corrected[0]["rank"] if corrected else None,
                "qrel_output_position": output_position,
                "qrels": corrected,
                "output_top5": [
                    {
                        "id": row["id"],
                        "file_id": row["file_id"],
                        "cosine": row["cosine"],
                        "corrected_qrel": row["id"] in corrected_ids,
                    }
                    for row in original["output_top5"]
                ],
            }
        )
    summaries = {}
    for arm in ("current", "adjacent_atomic_boundary"):
        arm_rows = [row for row in records if row["arm"] == arm]
        positives = [row for row in arm_rows if row["expected_outcome"] == "resolve"]
        measurable = [row for row in positives if row["corrected_qrel_count"]]
        summaries[arm] = {
            "cases": len(arm_rows),
            "resolve_cases": len(positives),
            "abstention_cases_retained": len(arm_rows) - len(positives),
            "measurable_resolve_cases": len(measurable),
            "positive_zero_qrel": sum(row["positive_zero_qrel"] for row in positives),
            "output_hit_at_5": sum(
                row["qrel_output_position"] is not None for row in measurable
            ),
            "mean_first_dense_qrel_rank": mean(
                row["first_qrel_rank"] for row in measurable
            )
            if measurable
            else None,
            "qrel_sets_changed_by_page_filter": sum(
                row["qrel_changed"] for row in arm_rows
            ),
        }
    write_json(
        output,
        {
            "schema_version": 1,
            "status": "post-hoc label-validation audit; original frozen dense results retained",
            "amendment_sha256": sha256(
                embed_root / "posthoc-locator-page-amendment.json"
            ),
            "dense_results_sha256": sha256(dense_path),
            "ranking_export_sha256": sha256(ranking_path),
            "summaries": summaries,
            "records": records,
        },
    )
    print(json.dumps(summaries))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=(
            "freeze",
            "evaluate",
            "check",
            "freeze-embeddings",
            "freeze-embeddings-v2",
            "embed",
            "check-embeddings",
            "freeze-dense-score",
            "score-dense",
            "audit-dense-locator-pages",
        ),
    )
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    parser.add_argument("--run-root", type=Path, default=RUN_ROOT)
    parser.add_argument("--ssh-host", default="root@159.195.61.195")
    parser.add_argument(
        "--ssh-key", type=Path, default=Path("~/.ssh/id_ed25519_capy_ingest")
    )
    args = parser.parse_args()
    {
        "freeze": freeze,
        "evaluate": evaluate,
        "check": check,
        "freeze-embeddings": freeze_embeddings,
        "freeze-embeddings-v2": freeze_embeddings_v2,
        "embed": embed,
        "check-embeddings": check_embeddings,
        "freeze-dense-score": freeze_dense_score,
        "score-dense": score_dense,
        "audit-dense-locator-pages": audit_dense_locator_pages,
    }[args.command](args)


if __name__ == "__main__":
    main()
