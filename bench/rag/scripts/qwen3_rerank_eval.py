"""Frozen Alibaba reranking diagnostic: prepare, check, probe, run.

All stages take ROOT. Prepare reads retained sibling experiment artifacts.
Network stages read ROOT/credential.json without logging its values. They use
the documented Beijing endpoint and have no provider or model fallback.
"""

import collections
import concurrent.futures
import hashlib
import json
import math
import os
import random
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

INSTRUCTION = (
    "Given a web search query, retrieve relevant passages that answer the query."
)
POOLS = ["hybrid40", "dense40", "union"]
ROOT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(".")


def sha(value):
    return hashlib.sha256(
        value.encode() if isinstance(value, str) else value
    ).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def save(path, data):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w") as out:
            out.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def utc():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def capped(ids, chunks, limit=5):
    counts, kept, overflow = collections.Counter(), [], []
    for cid in ids:
        fid = chunks[cid]["file_id"]
        if counts[fid] < 4:
            kept.append(cid)
            counts[fid] += 1
        else:
            overflow.append(cid)
    return (kept + overflow)[:limit]


def metrics(ids, query, chunks):
    seen, found, dcg, reciprocal = set(), set(), 0.0, 0.0
    for position, cid in enumerate(ids, 1):
        key = cid if query["label_unit"] == "chunk" else chunks[cid]["file_id"]
        grade = query["qrels"].get(key, 0) if key not in seen else 0
        seen.add(key)
        if grade > 0:
            found.add(key)
            dcg += (2**grade - 1) / math.log2(position + 1)
            reciprocal = reciprocal or 1 / position
    ideal = sum(
        (2**g - 1) / math.log2(i + 2)
        for i, g in enumerate(sorted(query["qrels"].values(), reverse=True)[:5])
    )
    return {
        "hit5": int(bool(found)),
        "recall5": len(found) / sum(g > 0 for g in query["qrels"].values()),
        "ndcg5": dcg / ideal,
        "mrr5": reciprocal,
    }


def membership(query):
    candidates = query["candidates"]
    return {
        "hybrid40": [c["id"] for c in candidates[:40]],
        "dense40": [
            c["id"]
            for c in sorted(candidates, key=lambda c: (c["dense"]["rank"], c["id"]))
            if c["dense"]["rank"] <= 40
        ],
        "union": [c["id"] for c in candidates],
    }


def prepare():
    ROOT.mkdir(parents=True, exist_ok=True)
    assert not (ROOT / "freeze.json").exists()
    multi = ROOT.parent / "2026-09-13-multilingual-language-handling"
    jlpt = ROOT.parent / "2026-09-13-jlpt-lookup"
    prepared = read(multi / "prepared.json")
    chunks = {
        c["id"]: {"file_id": c["file_id"], "text": c["text"]}
        for c in prepared["chunks"]
    }
    baseline = {
        r["id"]: r
        for split in ["dev", "heldout"]
        for r in map(json.loads, (multi / (split + ".jsonl")).read_text().splitlines())
        if r["method"] == "baseline"
    }
    queries = []
    for q in prepared["queries"]:
        row = q | {
            "query": q["q"],
            "label_unit": "file",
            "cohort": "natural" if q["kind"] == "natural_semantic" else "controlled",
            "candidates": baseline[q["id"]]["candidates"],
        }
        row.pop("q")
        queries.append(row)
    source = read(jlpt / "snapshot.json")
    freeze = read(jlpt / "freeze.json")
    chunks.update(
        {
            c["id"]: {"file_id": c["file_id"], "text": c["indexed_text"]}
            for c in source["chunks"]
        }
    )
    rows = [
        r
        for r in read(jlpt / "results.json")
        if r["variant"] == "stored_original" and r["mode"] == "current"
    ]
    for i, row in enumerate(rows):
        queries.append(
            {
                "id": f"jlpt-{i + 1}",
                "locale": "ja",
                "family": "jlpt-section10",
                "split": "diagnostic",
                "kind": "subject" if i == 4 else "locator",
                "query": row["query"],
                "label_unit": "chunk",
                "cohort": "jlpt",
                "qrels": {freeze["target"]: 1},
                "candidates": [
                    {
                        "id": c["id"],
                        "score": c["score"],
                        "dense": {"rank": c["vector_rank"], "distance": c["distance"]},
                        "lexical": c["lexical"],
                    }
                    for c in row["candidates"]
                ],
            }
        )
    assert len(queries) == 629
    probes = []
    for locale in sorted({q["locale"] for q in queries if q["cohort"] != "jlpt"}):
        slots = [
            (
                "dev",
                "natural_semantic" if locale not in {"zh-TW", "zh-HK"} else "semantic",
            ),
            ("dev", "contextual_locator"),
            ("heldout", "paraphrase"),
            ("heldout", "cross_language"),
        ]
        for split, kind in slots:
            eligible = [
                q
                for q in queries
                if q["locale"] == locale and q["split"] == split and q["kind"] == kind
            ]
            probes.append(min(eligible, key=lambda q: sha(q["id"]))["id"])
    probes += [q["id"] for q in queries if q["cohort"] == "jlpt"]
    for q in queries:
        q["pools"] = membership(q)
        assert len(q["pools"]["dense40"]) == 40
        assert len(q["pools"]["union"]) <= 80
    save(ROOT / "prepared.json", {"chunks": chunks, "queries": queries})
    payloads = []
    for q in sorted(queries, key=lambda q: sha(q["id"])):
        arms = ["union", "hybrid40", "dense40"] if q["id"] in probes else ["union"]
        if q["id"] in probes:
            random.Random(sha(q["id"])).shuffle(arms)
        for arm in arms:
            ids = sorted(q["pools"][arm])
            body = {
                "model": "qwen3-rerank",
                "query": q["query"],
                "documents": [chunks[cid]["text"] for cid in ids],
                "top_n": len(ids),
                "instruct": INSTRUCTION,
            }
            payloads.append(
                {
                    "id": q["id"] + "/" + arm,
                    "query_id": q["id"],
                    "pool": arm,
                    "document_ids": ids,
                    "body": body,
                }
            )
    save(ROOT / "payloads.json", payloads)
    max_item = max(
        len(text.encode())
        for p in payloads
        for text in [p["body"]["query"], *p["body"]["documents"]]
    )
    max_request = max(
        len(p["body"]["query"].encode()) * len(p["document_ids"])
        + sum(len(t.encode()) for t in p["body"]["documents"])
        for p in payloads
    )
    schema_probe = {
        "id": "schema-probe",
        "query_id": None,
        "pool": "schema",
        "document_ids": ["answer", "unrelated"],
        "body": {
            "model": "qwen3-rerank",
            "query": "What colour is the fictional box?",
            "documents": ["The fictional box is blue.", "The weather is sunny."],
            "top_n": 2,
            "instruct": INSTRUCTION,
        },
    }
    save(ROOT / "probe.json", schema_probe)
    save(
        ROOT / "freeze.json",
        {
            "frozen_utc": utc(),
            "model": "qwen3-rerank",
            "region": "Beijing",
            "endpoint_path": "/compatible-api/v1/reranks",
            "instruction": INSTRUCTION,
            "queries": len(queries),
            "planned_main_calls": len(payloads),
            "planned_total_attempts": len(payloads) + 1,
            "hard_attempt_cap": 720,
            "concurrency": 2,
            "minimum_start_interval_seconds": 0.5,
            "timeout_seconds": 90,
            "automatic_retries": 0,
            "paired_query_ids": probes,
            "prepared_sha256": sha((ROOT / "prepared.json").read_bytes()),
            "payloads_sha256": sha((ROOT / "payloads.json").read_bytes()),
            "script_sha256": sha(Path(__file__).read_bytes()),
            "probe_sha256": sha((ROOT / "probe.json").read_bytes()),
            "max_item_utf8_bytes": max_item,
            "max_request_repeated_query_utf8_bytes": max_request,
            "source_sha256": {
                str(p.relative_to(ROOT.parent)): sha(p.read_bytes())
                for p in [
                    multi / "prepared.json",
                    multi / "dev.jsonl",
                    multi / "heldout.jsonl",
                    jlpt / "snapshot.json",
                    jlpt / "freeze.json",
                    jlpt / "results.json",
                ]
            },
            "selection": "No method selected; all arms fixed and original previously inspected partitions retained. Smaller-pool union-score replays are distinct from actual direct40 requests.",
        },
    )
    print(
        json.dumps(
            {
                k: v
                for k, v in read(ROOT / "freeze.json").items()
                if k not in {"source_sha256", "paired_query_ids"}
            },
            indent=2,
        )
    )


def validate_response(data, count):
    assert isinstance(data, dict) and data.get("model") == "qwen3-rerank", (
        "Unexpected response model/schema"
    )
    rows = data.get("results")
    assert isinstance(rows, list) and len(rows) == count, "Incomplete result coverage"
    assert sorted(r["index"] for r in rows) == list(range(count)), (
        "Missing/duplicate document indices"
    )
    for r in rows:
        assert isinstance(r["index"], int) and not isinstance(r["index"], bool)
        assert isinstance(r["relevance_score"], (int, float)) and not isinstance(
            r["relevance_score"], bool
        )
        assert math.isfinite(r["relevance_score"]) and 0 <= r["relevance_score"] <= 1
    return rows


class Caller:
    def __init__(self):
        secret = ROOT / "credential.json"
        assert secret.stat().st_mode & 0o077 == 0, "Credential must be private"
        self.secret = read(secret)
        assert self.secret["model"] == "qwen3-rerank"
        host = self.secret["host"]
        assert host.endswith(".cn-beijing.maas.aliyuncs.com") and "/" not in host
        self.url = "https://" + host + "/compatible-api/v1/reranks"
        self.lock = threading.Lock()
        self.last_start = 0.0
        self.failures = 0
        self.stop = False
        self.attempts = ROOT / "attempts"
        self.attempts.mkdir(exist_ok=True)

    def call(self, payload):
        with self.lock:
            assert not self.stop, "Stopped after provider failure"
            sequence = len(list(self.attempts.glob("*.json"))) + 1
            assert sequence <= 720, "Attempt budget exhausted"
            path = self.attempts / f"{sequence:04}.json"
            delay = 0.5 - (time.perf_counter() - self.last_start)
            if delay > 0:
                time.sleep(delay)
            self.last_start = time.perf_counter()
            record = {
                "sequence": sequence,
                "id": payload["id"],
                "query_id": payload["query_id"],
                "pool": payload["pool"],
                "started_utc": utc(),
                "payload_sha256": sha(
                    json.dumps(
                        payload["body"], ensure_ascii=False, separators=(",", ":")
                    )
                ),
                "state": "started",
            }
            save(path, record)
        body = json.dumps(
            payload["body"], ensure_ascii=False, separators=(",", ":")
        ).encode()
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.secret["api_key"],
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                raw = response.read()
                record["status"] = response.status
            data = json.loads(
                raw.decode().replace(self.secret["api_key"], "[REDACTED]")
            )
            record["response"] = data
            validate_response(data, len(payload["document_ids"]))
            record["state"] = "success"
        except urllib.error.HTTPError as error:
            record.update(
                state="failed",
                status=error.code,
                response_text=error.read()
                .decode(errors="replace")
                .replace(self.secret["api_key"], "[REDACTED]")[:10000],
            )
        except (OSError, AssertionError, ValueError, TypeError, KeyError) as error:
            # Never serialize request headers, credentials, or exception objects.
            record.update(state="failed", error_type=type(error).__name__)
        record["elapsed_ms"] = 1000 * (time.perf_counter() - started)
        record["finished_utc"] = utc()
        save(path, record)
        with self.lock:
            self.failures += record["state"] != "success"
            if record.get("status") in {401, 403} or self.failures >= 5:
                self.stop = True
        return {
            k: record.get(k)
            for k in ["sequence", "id", "state", "status", "elapsed_ms", "error_type"]
        }


def network(stage):
    freeze = read(ROOT / "freeze.json")
    assert sha((ROOT / "payloads.json").read_bytes()) == freeze["payloads_sha256"]
    assert sha((ROOT / "probe.json").read_bytes()) == freeze["probe_sha256"]
    assert sha(Path(__file__).read_bytes()) == freeze["script_sha256"]
    existing = sorted((ROOT / "attempts").glob("*.json"))
    if stage == "probe":
        assert not existing
        print(json.dumps(Caller().call(read(ROOT / "probe.json"))), flush=True)
        return
    assert len(existing) == 1 and read(existing[0])["state"] == "success", (
        "Run needs exactly one successful schema probe; continuation must be explicit"
    )
    probe, receipt = read(ROOT / "probe.json"), read(existing[0])
    assert receipt["id"] == probe["id"] == "schema-probe" and receipt["sequence"] == 1
    assert (
        receipt["query_id"] is None
        and receipt["pool"] == "schema"
        and receipt["status"] == 200
    )
    assert receipt["payload_sha256"] == sha(
        json.dumps(probe["body"], ensure_ascii=False, separators=(",", ":"))
    )
    validate_response(receipt["response"], len(probe["document_ids"]))
    caller = Caller()
    payloads = read(ROOT / "payloads.json")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pending = {}
        iterator = iter(payloads)
        for _ in range(2):
            p = next(iterator, None)
            if p:
                pending[pool.submit(caller.call, p)] = p["id"]
        completed = 0
        while pending:
            done, _ = concurrent.futures.wait(
                pending, return_when=concurrent.futures.FIRST_COMPLETED
            )
            for future in done:
                pending.pop(future)
                result = future.result()
                completed += 1
                if completed % 20 == 0 or result["state"] != "success":
                    print(
                        json.dumps(
                            result | {"completed": completed, "planned": len(payloads)}
                        ),
                        flush=True,
                    )
                if not caller.stop:
                    p = next(iterator, None)
                    if p:
                        pending[pool.submit(caller.call, p)] = p["id"]
    save(
        ROOT / "run-complete.json",
        {
            "completed_utc": utc(),
            "completed": completed,
            "planned": len(payloads),
            "failures": caller.failures,
            "stopped": caller.stop,
        },
    )


def check():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "attempt.json"
        save(path, {"state": "started"})
        save(path, {"state": "success"})
        assert read(path) == {"state": "success"} and list(
            Path(directory).iterdir()
        ) == [path]
    chunks = {str(i): {"file_id": "a" if i < 5 else "b"} for i in range(6)}
    assert capped(list(chunks), chunks) == ["0", "1", "2", "3", "5"]
    q = {"label_unit": "chunk", "qrels": {"4": 1}}
    assert metrics(["4"], q, chunks)["ndcg5"] == 1
    assert metrics(["0"], q, chunks)["hit5"] == 0
    q = {"label_unit": "file", "qrels": {"a": 1, "b": 1}}
    assert (
        abs(metrics(["0", "1", "5"], q, chunks)["ndcg5"] - 1.5 / (1 + 1 / math.log2(3)))
        < 1e-12
    )
    valid = {
        "model": "qwen3-rerank",
        "results": [
            {"index": 0, "relevance_score": 0.8},
            {"index": 1, "relevance_score": 0.1},
        ],
    }
    validate_response(valid, 2)
    for invalid in [
        valid | {"model": "other"},
        valid | {"results": valid["results"][:1]},
        valid | {"results": [valid["results"][0]] * 2},
    ]:
        try:
            validate_response(invalid, 2)
        except AssertionError:
            pass
        else:
            raise AssertionError("Accepted invalid response")
    print(
        "cap, chunk/file labels, duplicate-source metrics and response-schema checks passed"
    )


if __name__ == "__main__":
    {
        "prepare": prepare,
        "check": check,
        "probe": lambda: network("probe"),
        "run": lambda: network("run"),
    }[sys.argv[1]]()
