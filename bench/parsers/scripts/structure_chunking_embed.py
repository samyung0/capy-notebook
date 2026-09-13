#!/usr/bin/env python3
"""Fresh Qwen3 embedding comparison for frozen structure-chunking arms."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import subprocess
import time
from collections import Counter
from pathlib import Path
from statistics import mean
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "bench/parsers/reports/local/2026-09-13-structure-chunking"
RUN_ROOT = BASE / "embedding"
MODEL = "Qwen/Qwen3-Embedding-4B"
ENDPOINT = "https://api.deepinfra.com/v1/openai/embeddings"
DIMENSIONS = 2560
MAX_PROVIDER_TOKENS = 2_000_000


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_text(value: str) -> str:
    return digest_bytes(value.encode())


def sha256(path: Path) -> str:
    return digest_bytes(path.read_bytes())


def load_questions() -> list[dict]:
    fixture = read_json(
        ROOT / "bench/parsers/fixtures/structure_chunking_fixtures.json"
    )
    result = []
    for record in fixture["question_fixtures"]:
        path = ROOT / record["path"]
        if sha256(path) != record["sha256"]:
            raise ValueError(f"question fixture changed: {path}")
        wanted = set(record["question_ids"])
        result.extend(
            question
            for question in read_json(path)["questions"]
            if question["id"] in wanted
        )
    return result


def freeze(args: argparse.Namespace) -> None:
    from pipeline.prompts.retrieval import qwen3_query
    from pipeline.retrieval.chunking import estimate_tokens

    base = args.base.resolve()
    run_root = args.run_root.resolve()
    if run_root.exists():
        raise FileExistsError(run_root)
    result_path = base / "results.json"
    result = read_json(result_path)
    arms = sorted(result["arms"])
    prepared: dict[str, Any] = {"arms": {}, "questions": [], "inputs": []}
    inputs: dict[str, dict] = {}
    chunk_hashes = {}
    for arm in arms:
        chunks = []
        for path in sorted((base / "chunks" / arm).glob("*.json")):
            chunk_hashes[str(path.relative_to(base))] = sha256(path)
            for chunk in read_json(path):
                text = chunk["indexed_text"]
                text_hash = digest_text(text)
                inputs.setdefault(
                    text_hash, {"sha256": text_hash, "kind": "passage", "text": text}
                )
                chunks.append(
                    {
                        "source_id": chunk["source_id"],
                        "page_start": chunk["page_start"],
                        "page_end": chunk["page_end"],
                        "text_sha256": text_hash,
                    }
                )
        prepared["arms"][arm] = chunks
    for question in load_questions():
        query = qwen3_query(question["question"])
        query_hash = digest_text(query)
        inputs.setdefault(
            query_hash, {"sha256": query_hash, "kind": "query", "text": query}
        )
        prepared["questions"].append(
            {
                "id": question["id"],
                "split": question["split"],
                "language": question["language"],
                "source_ids": question["source_ids"],
                "pages": [
                    {
                        "source_id": evidence["source_id"],
                        "page": evidence.get("pdf_page"),
                    }
                    for evidence in question.get("evidence", [])
                    if isinstance(evidence.get("pdf_page"), int)
                ],
                "query_sha256": query_hash,
            }
        )
    prepared["inputs"] = [inputs[key] for key in sorted(inputs)]
    estimated = sum(estimate_tokens(item["text"]) for item in prepared["inputs"])
    if estimated > 1_500_000:
        raise ValueError(f"estimated input exceeds freeze cap: {estimated}")
    run_root.mkdir(parents=True)
    write_json(run_root / "prepared.json", prepared)
    write_json(
        run_root / "freeze.json",
        {
            "schema_version": 1,
            "model": MODEL,
            "dimensions": DIMENSIONS,
            "endpoint": ENDPOINT,
            "query_wrapper": "pipeline.prompts.retrieval.qwen3_query",
            "passage_prefix": None,
            "per_file_cap": 4,
            "top_k": 5,
            "provider_token_cap": MAX_PROVIDER_TOKENS,
            "estimated_tokens": estimated,
            "unique_inputs": len(prepared["inputs"]),
            "base_results_sha256": sha256(result_path),
            "chunk_artifact_sha256": chunk_hashes,
            "prepared_sha256": sha256(run_root / "prepared.json"),
            "script_sha256": sha256(Path(__file__)),
        },
    )
    print(json.dumps({"inputs": len(inputs), "estimated_tokens": estimated}))


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


def append_receipt(path: Path, value: dict) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(value, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def embed(args: argparse.Namespace) -> None:
    import httpx
    import numpy as np

    run_root = args.run_root.resolve()
    manifest = read_json(run_root / "freeze.json")
    prepared_path = run_root / "prepared.json"
    if sha256(prepared_path) != manifest["prepared_sha256"]:
        raise ValueError("prepared inputs changed after freeze")
    inputs = read_json(prepared_path)["inputs"]
    database = sqlite3.connect(run_root / "vectors.sqlite3")
    database.execute(
        "CREATE TABLE IF NOT EXISTS vectors (sha256 TEXT PRIMARY KEY, value BLOB NOT NULL)"
    )
    existing = {row[0] for row in database.execute("SELECT sha256 FROM vectors")}
    pending = [item for item in inputs if item["sha256"] not in existing]
    if existing:
        raise ValueError("continuations require a separate receipt")
    key = provider_key(args)
    total_tokens = 0
    receipts = run_root / "requests.jsonl"
    with httpx.Client(timeout=90) as client:
        for offset in range(0, len(pending), 64):
            batch = pending[offset : offset + 64]
            started = time.perf_counter()
            response = client.post(
                manifest["endpoint"],
                headers={"Authorization": f"Bearer {key}"},
                json={
                    "model": manifest["model"],
                    "input": [item["text"] for item in batch],
                    "dimensions": manifest["dimensions"],
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
                append_receipt(receipts, receipt)
                response.raise_for_status()
            payload = response.json()
            rows = sorted(payload["data"], key=lambda row: row["index"])
            if [row["index"] for row in rows] != list(range(len(batch))):
                raise ValueError("provider returned unexpected embedding indices")
            for item, row in zip(batch, rows):
                vector = np.asarray(row["embedding"], dtype=np.float32)
                if (
                    vector.shape != (manifest["dimensions"],)
                    or not np.isfinite(vector).all()
                    or np.linalg.norm(vector) == 0
                ):
                    raise ValueError("invalid provider embedding")
                database.execute(
                    "INSERT INTO vectors VALUES (?, ?)",
                    (item["sha256"], vector.tobytes()),
                )
            database.commit()
            usage = payload.get("usage") or {}
            total_tokens += int(usage.get("prompt_tokens") or 0)
            receipt.update(usage=usage, response_model=payload.get("model"))
            append_receipt(receipts, receipt)
            if total_tokens > manifest["provider_token_cap"]:
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
        run_root / "embedding-complete.json",
        {
            "inputs": len(inputs),
            "provider_tokens": total_tokens,
            "prepared_sha256": manifest["prepared_sha256"],
            "requests_sha256": sha256(receipts),
            "vectors_sha256": sha256(run_root / "vectors.sqlite3"),
        },
    )


def unit(vector):
    import numpy as np

    return vector / np.linalg.norm(vector)


def halfvec_unit(vector):
    import numpy as np

    rounded = np.asarray(
        [np.float16(float(f"{value:.6g}")) for value in vector], dtype=np.float32
    )
    return unit(rounded)


def score(args: argparse.Namespace) -> None:
    import numpy as np

    run_root = args.run_root.resolve()
    manifest = read_json(run_root / "freeze.json")
    if sha256(run_root / "prepared.json") != manifest["prepared_sha256"]:
        raise ValueError("prepared inputs changed after freeze")
    prepared = read_json(run_root / "prepared.json")
    question_metadata = {question["id"]: question for question in load_questions()}
    complete = read_json(run_root / "embedding-complete.json")
    if complete["prepared_sha256"] != manifest["prepared_sha256"]:
        raise ValueError("embedding receipt does not match prepared inputs")
    if sha256(run_root / "requests.jsonl") != complete["requests_sha256"]:
        raise ValueError("request receipts changed after embedding")
    request_rows = [
        json.loads(line)
        for line in (run_root / "requests.jsonl").read_text().splitlines()
        if line.strip()
    ]
    requested = [key for row in request_rows for key in row["input_sha256"]]
    expected = [item["sha256"] for item in prepared["inputs"]]
    if (
        requested != expected
        or any(row["status"] != 200 for row in request_rows)
        or sum((row.get("usage") or {}).get("prompt_tokens", 0) for row in request_rows)
        != complete["provider_tokens"]
    ):
        raise ValueError("request receipts do not cover the frozen inputs exactly")
    if sha256(run_root / "vectors.sqlite3") != complete["vectors_sha256"]:
        raise ValueError("vector cache changed after embedding")
    with sqlite3.connect(run_root / "vectors.sqlite3") as database:
        vectors = {
            key: halfvec_unit(np.frombuffer(value, dtype=np.float32))
            for key, value in database.execute("SELECT sha256, value FROM vectors")
        }
    if set(vectors) != set(expected) or any(
        vector.shape != (manifest["dimensions"],) or not np.isfinite(vector).all()
        for vector in vectors.values()
    ):
        raise ValueError("vector cache does not match frozen inputs")
    records = {}
    for arm, chunks in prepared["arms"].items():
        matrix = np.stack([vectors[chunk["text_sha256"]] for chunk in chunks])
        arm_records = []
        for question in prepared["questions"]:
            query = vectors[question["query_sha256"]]
            order = np.argsort(-(matrix @ query), kind="stable")
            candidates = [int(index) for index in order[:40]]
            kept = []
            overflow = []
            per_file = Counter()
            for index in candidates:
                source_id = chunks[index]["source_id"]
                if per_file[source_id] >= manifest["per_file_cap"]:
                    overflow.append(index)
                else:
                    kept.append(index)
                    per_file[source_id] += 1
            selected = (kept + overflow)[: manifest["top_k"]]
            relevant = set()
            for index, chunk in enumerate(chunks):
                for evidence in question["pages"]:
                    if (
                        chunk["source_id"] == evidence["source_id"]
                        and chunk["page_start"] is not None
                        and chunk["page_end"] is not None
                        and chunk["page_start"] <= evidence["page"] <= chunk["page_end"]
                    ):
                        relevant.add(index)
            rank = next(
                (
                    position
                    for position, index in enumerate(selected, 1)
                    if index in relevant
                ),
                None,
            )
            arm_records.append(
                {
                    "id": question["id"],
                    "split": question["split"],
                    "language": question["language"],
                    "answerability": question_metadata[question["id"]]["answerability"],
                    "gold_page_rank": rank,
                    "gold_page_hit_at_5": rank is not None,
                    "top5": [
                        {
                            "source_id": chunks[index]["source_id"],
                            "page_start": chunks[index]["page_start"],
                            "page_end": chunks[index]["page_end"],
                            "text_sha256": chunks[index]["text_sha256"],
                        }
                        for index in selected
                    ],
                }
            )
        answerable = [
            record for record in arm_records if record["answerability"] == "answerable"
        ]
        records[arm] = {
            "questions": len(arm_records),
            "gold_page_hit_at_5": sum(
                record["gold_page_hit_at_5"] for record in arm_records
            ),
            "gold_page_mrr_at_5": mean(
                [
                    1 / record["gold_page_rank"] if record["gold_page_rank"] else 0
                    for record in arm_records
                ]
            ),
            "mean_discounted_first_gold_page_hit_at_5": mean(
                [
                    1 / math.log2(record["gold_page_rank"] + 1)
                    if record["gold_page_rank"]
                    else 0
                    for record in arm_records
                ]
            ),
            "answerable_questions": len(answerable),
            "answerable_gold_page_hit_at_5": sum(
                record["gold_page_hit_at_5"] for record in answerable
            ),
            "records": arm_records,
        }
    write_json(
        run_root / "scores.json",
        {
            "schema_version": 1,
            "model": manifest["model"],
            "dimensions": manifest["dimensions"],
            "prepared_sha256": manifest["prepared_sha256"],
            "embedding_complete_sha256": sha256(run_root / "embedding-complete.json"),
            "arms": records,
        },
    )
    print(
        json.dumps({arm: value["gold_page_hit_at_5"] for arm, value in records.items()})
    )


def check(args: argparse.Namespace) -> None:
    run_root = args.run_root.resolve()
    manifest = read_json(run_root / "freeze.json")
    assert sha256(run_root / "prepared.json") == manifest["prepared_sha256"]
    complete = read_json(run_root / "embedding-complete.json")
    assert complete["inputs"] == manifest["unique_inputs"]
    scores = read_json(run_root / "scores.json")
    assert scores["prepared_sha256"] == manifest["prepared_sha256"]
    assert all(value["questions"] == 21 for value in scores["arms"].values())
    print(
        json.dumps({"status": "ok", "scores_sha256": sha256(run_root / "scores.json")})
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("freeze", "embed", "score", "check"))
    parser.add_argument("--base", type=Path, default=BASE)
    parser.add_argument("--run-root", type=Path, default=RUN_ROOT)
    parser.add_argument("--ssh-host", default="root@159.195.61.195")
    parser.add_argument(
        "--ssh-key", type=Path, default=Path("~/.ssh/id_ed25519_capy_ingest")
    )
    args = parser.parse_args()
    {"freeze": freeze, "embed": embed, "score": score, "check": check}[args.command](
        args
    )


if __name__ == "__main__":
    main()
