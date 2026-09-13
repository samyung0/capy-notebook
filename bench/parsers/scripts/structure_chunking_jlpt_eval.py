#!/usr/bin/env python3
"""Replay the five frozen JLPT queries against structure-chunking arms."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "bench/parsers/reports/local/2026-09-13-structure-chunking"
RUN_ROOT = BASE / "embedding/jlpt-diagnostic"
EMBED_ROOT = BASE / "embedding"
PRIOR_ROOT = ROOT / "bench/rag/reports/local/2026-09-13-jlpt-lookup"
MODEL = "Qwen/Qwen3-Embedding-4B"
DIMENSIONS = 2560
QUERIES = [
    "question 10 reading comprehension passage N1",
    "問題10 次の文章を読んで 読解",
    "問題 10 次の文章を読んで",
    "問題 10",
    "シアノバクテリアと藻類による大気環境の変化と現代人による環境変化はどのように違うか",
]
REQUIRED_ANCHORS = [
    "問題 10 次の文章を読んで",
    "シアノバクテリアと藻類が誕生し",
    "そのため、人間は",
]
FORBIDDEN_ANCHORS = ["自分の存在価値は自分で明らかにしなければならないから"]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def freeze(args: argparse.Namespace) -> None:
    from pipeline.prompts.retrieval import qwen3_query

    run_root = args.run_root.resolve()
    if run_root.exists():
        raise FileExistsError(run_root)
    prior_freeze = read_json(PRIOR_ROOT / "freeze.json")
    prior_response = read_json(PRIOR_ROOT / "response.json")
    query_inputs = [qwen3_query(query) for query in QUERIES]
    if prior_freeze["queries"] != QUERIES:
        raise ValueError("prior query list does not match the diagnostic")
    if prior_freeze["embedding_payload"]["input"][: len(QUERIES)] != query_inputs:
        raise ValueError("prior query inputs do not use the current query wrapper")
    if (
        prior_freeze["pin"]["embedding_model_slug"] != MODEL
        or prior_freeze["pin"]["embedding_dim"] != DIMENSIONS
        or prior_response["model"] != MODEL
    ):
        raise ValueError("prior query vectors use a different embedding pin")
    manifest = read_json(EMBED_ROOT / "freeze.json")
    complete = read_json(EMBED_ROOT / "embedding-complete.json")
    if manifest["model"] != MODEL or manifest["dimensions"] != DIMENSIONS:
        raise ValueError("passage vectors use a different embedding pin")
    value = {
        "schema_version": 1,
        "status": "frozen before JLPT diagnostic scores were computed",
        "queries": QUERIES,
        "query_inputs_sha256": [
            hashlib.sha256(value.encode()).hexdigest() for value in query_inputs
        ],
        "query_wrapper": "pipeline.prompts.retrieval.qwen3_query",
        "query_vector_source": "exact prior provider response; no new provider call",
        "prior_freeze_sha256": sha256(PRIOR_ROOT / "freeze.json"),
        "prior_response_sha256": sha256(PRIOR_ROOT / "response.json"),
        "passage_prepared_sha256": manifest["prepared_sha256"],
        "passage_vectors_sha256": complete["vectors_sha256"],
        "model": MODEL,
        "dimensions": DIMENSIONS,
        "candidate_pool": 40,
        "top_k": 5,
        "per_file_cap": 4,
        "target_source_id": "jlpt-n1-2019",
        "required_anchors": REQUIRED_ANCHORS,
        "forbidden_anchors": FORBIDDEN_ANCHORS,
        "relevance": "a chunk must contain every required anchor; cleanliness is reported separately",
        "corpus_scope": "the same 11-source structure corpus, not the original three-file UAT workspace",
        "script_sha256": sha256(Path(__file__)),
    }
    run_root.mkdir(parents=True)
    write_json(run_root / "freeze.json", value)
    write_json(
        run_root / "freeze-receipt.json",
        {"freeze_sha256": sha256(run_root / "freeze.json")},
    )
    print(json.dumps({"queries": len(QUERIES), "provider_calls": 0}))


def halfvec_unit(vector):
    import numpy as np

    rounded = np.asarray(
        [np.float16(float(f"{value:.6g}")) for value in vector], dtype=np.float32
    )
    return rounded / np.linalg.norm(rounded)


def score(args: argparse.Namespace) -> None:
    import numpy as np

    run_root = args.run_root.resolve()
    frozen = read_json(run_root / "freeze.json")
    receipt = read_json(run_root / "freeze-receipt.json")
    if sha256(run_root / "freeze.json") != receipt["freeze_sha256"]:
        raise ValueError("diagnostic freeze changed")
    if sha256(PRIOR_ROOT / "freeze.json") != frozen["prior_freeze_sha256"]:
        raise ValueError("prior query freeze changed")
    if sha256(PRIOR_ROOT / "response.json") != frozen["prior_response_sha256"]:
        raise ValueError("prior query vectors changed")
    if sha256(EMBED_ROOT / "prepared.json") != frozen["passage_prepared_sha256"]:
        raise ValueError("passage inputs changed")
    prepared = read_json(EMBED_ROOT / "prepared.json")
    complete = read_json(EMBED_ROOT / "embedding-complete.json")
    if complete["prepared_sha256"] != frozen["passage_prepared_sha256"]:
        raise ValueError("passage input receipt changed")
    if sha256(EMBED_ROOT / "vectors.sqlite3") != frozen["passage_vectors_sha256"]:
        raise ValueError("passage vectors changed")
    texts = {item["sha256"]: item["text"] for item in prepared["inputs"]}
    with sqlite3.connect(EMBED_ROOT / "vectors.sqlite3") as database:
        passage_vectors = {
            key: halfvec_unit(np.frombuffer(value, dtype=np.float32))
            for key, value in database.execute("SELECT sha256, value FROM vectors")
        }
    response = read_json(PRIOR_ROOT / "response.json")
    query_vectors = [
        halfvec_unit(np.asarray(row["embedding"], dtype=np.float32))
        for row in sorted(response["data"], key=lambda row: row["index"])[
            : len(QUERIES)
        ]
    ]
    if any(vector.shape != (DIMENSIONS,) for vector in query_vectors):
        raise ValueError("invalid query vector dimensions")
    results: dict[str, Any] = {}
    for arm, chunks in prepared["arms"].items():
        matrix = np.stack([passage_vectors[chunk["text_sha256"]] for chunk in chunks])
        targets = [
            index
            for index, chunk in enumerate(chunks)
            if chunk["source_id"] == frozen["target_source_id"]
            and all(
                anchor in texts[chunk["text_sha256"]]
                for anchor in frozen["required_anchors"]
            )
        ]
        if len(targets) != 1:
            raise ValueError(f"{arm} has {len(targets)} fixed-anchor targets")
        target = targets[0]
        arm_rows = []
        for query, vector in zip(QUERIES, query_vectors):
            scores = matrix @ vector
            order = [int(index) for index in np.argsort(-scores, kind="stable")]
            candidates = order[: frozen["candidate_pool"]]
            kept: list[int] = []
            overflow: list[int] = []
            per_file = Counter()
            for index in candidates:
                source_id = chunks[index]["source_id"]
                if per_file[source_id] >= frozen["per_file_cap"]:
                    overflow.append(index)
                else:
                    kept.append(index)
                    per_file[source_id] += 1
            selected = (kept + overflow)[: frozen["top_k"]]
            source_order = [
                index
                for index in order
                if chunks[index]["source_id"] == frozen["target_source_id"]
            ]
            arm_rows.append(
                {
                    "query": query,
                    "target_dense_rank": order.index(target) + 1,
                    "target_source_rank": source_order.index(target) + 1,
                    "target_candidate": target in candidates,
                    "target_returned_rank": (
                        selected.index(target) + 1 if target in selected else None
                    ),
                    "target_cosine_distance": round(1 - float(scores[target]), 6),
                    "target_clean": not any(
                        anchor in texts[chunks[target]["text_sha256"]]
                        for anchor in frozen["forbidden_anchors"]
                    ),
                    "top5": [
                        {
                            "source_id": chunks[index]["source_id"],
                            "page_start": chunks[index]["page_start"],
                            "page_end": chunks[index]["page_end"],
                            "text_sha256": chunks[index]["text_sha256"],
                            "cosine_distance": round(1 - float(scores[index]), 6),
                            "is_fixed_anchor_target": index == target,
                        }
                        for index in selected
                    ],
                }
            )
        results[arm] = {
            "target": {
                **chunks[target],
                "clean": arm_rows[0]["target_clean"],
                "lexical_tokens": len(texts[chunks[target]["text_sha256"]].split()),
            },
            "queries": arm_rows,
        }
    write_json(
        run_root / "scores.json",
        {
            "schema_version": 1,
            "freeze_sha256": receipt["freeze_sha256"],
            "provider_calls": 0,
            "arms": results,
        },
    )
    print(
        json.dumps(
            {
                arm: [row["target_dense_rank"] for row in value["queries"]]
                for arm, value in results.items()
            }
        )
    )


def check(args: argparse.Namespace) -> None:
    run_root = args.run_root.resolve()
    receipt = read_json(run_root / "freeze-receipt.json")
    scores = read_json(run_root / "scores.json")
    assert scores["freeze_sha256"] == receipt["freeze_sha256"]
    assert scores["provider_calls"] == 0
    assert all(
        len(value["queries"]) == len(QUERIES) for value in scores["arms"].values()
    )
    assert all(
        math.isfinite(row["target_cosine_distance"])
        for value in scores["arms"].values()
        for row in value["queries"]
    )
    print(
        json.dumps({"status": "ok", "scores_sha256": sha256(run_root / "scores.json")})
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("freeze", "score", "check"))
    parser.add_argument("--run-root", type=Path, default=RUN_ROOT)
    args = parser.parse_args()
    {"freeze": freeze, "score": score, "check": check}[args.command](args)


if __name__ == "__main__":
    main()
