"""Replay known-file JLPT retrieval and inventory the multilingual fixture.

This runner is offline. It reads frozen artifacts, makes no provider or database
calls, and refuses changed inputs or an existing output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
JLPT = ROOT / "bench/rag/reports/local/2026-09-13-jlpt-lookup"
MULTILINGUAL = (
    ROOT / "bench/rag/reports/local/2026-09-13-multilingual-language-handling"
)
TARGET = "chk_5901ee92e1a8f428"
TARGET_FILE = "f_042da5e2fc"
EXPECTED = {
    JLPT
    / "freeze.json": "be48e1121547497266f6c7b44f6ebeeb9f63099e76673e02ec2f73214967fc51",
    JLPT
    / "snapshot.json": "0fb5faa79e0ff11128d75bb58179602d3184c11bd16589a6ad01beadf2b1dc5b",
    JLPT
    / "response.json": "f1c5894e1dc07d123de2e75c839c9912fd4d59580d5d7028e3e54aac4605bb6a",
    JLPT
    / "results.json": "dafded6a2d0f4fed71a263138c121159dd5889e9b84a1b756399f3e9a3291ec1",
    MULTILINGUAL
    / "prepared.json": "34f3b67f83601d33e4a3938efea87d59f2b919a73aa464c6b80540a45408c96a",
    MULTILINGUAL
    / "dev.jsonl": "313ff544b59b81ac988cf88bebefd5ce9728e68221f965224835b4d5590ad2af",
    MULTILINGUAL
    / "heldout.jsonl": "1a6e534a7b1e0c15826654e9a6c8031bbfba5b48bdfd1e4f236ca60ee5bb8e4b",
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path: Path) -> Any:
    return json.loads(path.read_text())


def unit(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    return [value / norm for value in vector]


def stored_precision(vector: list[float]) -> list[float]:
    return [
        struct.unpack("e", struct.pack("e", float(f"{value:.6g}")))[0]
        for value in vector
    ]


def scoped_jlpt() -> list[dict[str, Any]]:
    freeze = load(JLPT / "freeze.json")
    snapshot = load(JLPT / "snapshot.json")
    saved_results = load(JLPT / "results.json")
    response = load(JLPT / "response.json")
    assert freeze["snapshot_sha256"] == digest(JLPT / "snapshot.json")
    assert freeze["target"] == TARGET

    chunks = snapshot["chunks"]
    selected = [chunk for chunk in chunks if chunk["file_id"] == TARGET_FILE]
    assert len(chunks) == 223 and len(selected) == 56
    chunk_files = {chunk["id"]: chunk["file_id"] for chunk in chunks}
    corpus = {chunk["id"]: unit(json.loads(chunk["embedding"])) for chunk in selected}
    query_vectors = [
        unit(stored_precision(row["embedding"]))
        for row in sorted(response["data"], key=lambda row: row["index"])
    ][: len(freeze["queries"])]

    output: list[dict[str, Any]] = []
    for index, (query, query_vector) in enumerate(
        zip(freeze["queries"], query_vectors, strict=True)
    ):
        distances = {
            chunk_id: 1 - sum(a * b for a, b in zip(query_vector, vector, strict=True))
            for chunk_id, vector in corpus.items()
        }
        dense_ids = sorted(distances, key=lambda cid: (distances[cid], cid))
        dense_rank = {chunk_id: rank for rank, chunk_id in enumerate(dense_ids, 1)}

        scoped_lexical_rows = [
            row
            for row in snapshot["lexical"][index]["rows"]
            if chunk_files[row["id"]] == TARGET_FILE
        ]
        lexical = {
            row["id"]: row | {"scoped_rank": rank}
            for rank, row in enumerate(scoped_lexical_rows, 1)
        }
        candidates = set(dense_ids[:40]) | set(list(lexical)[:40])
        fused = []
        for chunk_id in candidates:
            score = 1 / (60 + dense_rank[chunk_id]) if dense_rank[chunk_id] <= 40 else 0
            lex = lexical.get(chunk_id)
            if lex and lex["scoped_rank"] <= 40:
                score += (1 if lex["exact"] else 0.5) / (60 + lex["scoped_rank"])
            fused.append(
                {
                    "id": chunk_id,
                    "score": score,
                    "dense_rank": dense_rank[chunk_id],
                    "lexical_rank": lex["scoped_rank"] if lex else None,
                }
            )
        fused.sort(key=lambda row: (-row["score"], row["id"]))
        scoped_fused_rank = next(
            rank for rank, row in enumerate(fused, 1) if row["id"] == TARGET
        )

        global_result = next(
            row
            for row in saved_results
            if row["query"] == query
            and row["variant"] == "stored_original"
            and row["mode"] == "current"
        )
        global_top40 = global_result["candidates"][:40]
        output.append(
            {
                "query": query,
                "global": {
                    "dense_rank": global_result["target_vector_rank"],
                    "lexical_rank": global_result["target_lexical"]["rank"],
                    "fused_rank": global_result["target_fused_rank"],
                    "output_position": global_result["target_output_position"],
                    "target_file_candidates_top5": sum(
                        chunk_files[row["id"]] == TARGET_FILE
                        for row in global_top40[:5]
                    ),
                    "target_file_candidates_top40": sum(
                        chunk_files[row["id"]] == TARGET_FILE for row in global_top40
                    ),
                },
                "known_file_scope": {
                    "dense_rank": dense_rank[TARGET],
                    "lexical_rank": lexical[TARGET]["scoped_rank"],
                    "fused_rank": scoped_fused_rank,
                    "output_position": scoped_fused_rank
                    if scoped_fused_rank <= 5
                    else None,
                    "top5": [row["id"] for row in fused[:5]],
                },
            }
        )
    return output


def multilingual_inventory() -> dict[str, Any]:
    prepared = load(MULTILINGUAL / "prepared.json")
    rows = []
    for split in ("dev", "heldout"):
        rows.extend(
            json.loads(line)
            for line in (MULTILINGUAL / f"{split}.jsonl").read_text().splitlines()
            if line
        )
    baseline = [row for row in rows if row["method"] == "baseline"]
    assert len(baseline) == 624

    chunks = prepared["chunks"]
    chunk_by_id = {chunk["id"]: chunk for chunk in chunks}
    chunks_per_file = Counter(chunk["file_id"] for chunk in chunks)
    natural_files = {
        document["id"]
        for document in prepared["documents"]
        if document["id"].startswith("miracl-")
    }
    candidate_locale_counts = []
    for row in baseline:
        locales = {
            chunk_by_id[candidate["id"]]["locale"] for candidate in row["candidates"]
        }
        candidate_locale_counts.append(len(locales))

    questions_by_kind = Counter(query["kind"] for query in prepared["queries"])
    questions_by_locale = Counter(query["locale"] for query in prepared["queries"])
    source_chunks_by_locale = Counter(chunk["locale"] for chunk in chunks)
    natural_chunk_counts = [chunks_per_file[file_id] for file_id in natural_files]
    return {
        "documents": len(prepared["documents"]),
        "chunks": len(chunks),
        "queries": len(prepared["queries"]),
        "questions_by_kind": dict(sorted(questions_by_kind.items())),
        "questions_by_locale": dict(sorted(questions_by_locale.items())),
        "source_chunks_by_locale": dict(sorted(source_chunks_by_locale.items())),
        "documents_with_one_chunk": sum(
            value == 1 for value in chunks_per_file.values()
        ),
        "documents_with_multiple_chunks": sum(
            value > 1 for value in chunks_per_file.values()
        ),
        "documents_with_more_than_four_chunks": sum(
            value > 4 for value in chunks_per_file.values()
        ),
        "maximum_chunks_per_document": max(chunks_per_file.values()),
        "natural_documents": len(natural_files),
        "maximum_chunks_per_natural_document": max(natural_chunk_counts),
        "baseline_candidate_lists_with_multiple_source_locales": sum(
            value > 1 for value in candidate_locale_counts
        ),
        "multi_turn_queries": 0,
        "conversation_history_fields_present": any(
            "history" in query or "turn" in query for query in prepared["queries"]
        ),
        "controlled_cross_language_queries": questions_by_kind["cross_language"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    for path, expected in EXPECTED.items():
        actual = digest(path)
        if actual != expected:
            raise SystemExit(f"changed frozen input: {path} ({actual})")
    args.output.mkdir(parents=True, exist_ok=False)

    results = scoped_jlpt()
    summary = {
        "jlpt": results,
        "multilingual_fixture": multilingual_inventory(),
    }
    (args.output / "results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n"
    )
    (args.output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    )
    manifest = {
        "inputs": {
            str(path.relative_to(ROOT)): expected for path, expected in EXPECTED.items()
        },
        "runner_sha256": digest(Path(__file__)),
        "results_sha256": digest(args.output / "results.json"),
        "summary_sha256": digest(args.output / "summary.json"),
        "provider_calls": 0,
        "database_calls": 0,
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
