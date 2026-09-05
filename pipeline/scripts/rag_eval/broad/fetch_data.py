"""Fetch pinned public data for the frozen, isolated broad evaluation."""

from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import json
import re
import shutil
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

LANGUAGES = ("en", "de", "es", "fr", "ja", "ko", "zh")
SEED = "capy-broad-20260905-v1"


def stable_key(value):
    return hashlib.sha256((SEED + ":" + value).encode()).hexdigest()


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fetch(url, path):
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        try:
            with (
                urllib.request.urlopen(url, timeout=120) as response,
                path.with_suffix(path.suffix + ".part").open("wb") as out,
            ):
                shutil.copyfileobj(response, out, 1024 * 1024)
            path.with_suffix(path.suffix + ".part").replace(path)
            return path
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2 ** (attempt + 1))
    raise AssertionError("unreachable")


def read_json(url, path):
    return json.loads(fetch(url, path).read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def miracl(root):
    import pyarrow.parquet as pq

    raw = root / "raw"
    metadata = read_json(
        "https://huggingface.co/api/datasets/miracl/miracl", raw / "miracl-meta.json"
    )
    corpus_meta = read_json(
        "https://huggingface.co/api/datasets/miracl/miracl-corpus",
        raw / "miracl-corpus-meta.json",
    )
    converted_meta = read_json(
        "https://huggingface.co/api/datasets/miracl/miracl/revision/refs%2Fconvert%2Fparquet",
        raw / "miracl-converted-meta.json",
    )
    trees = read_json(
        "https://huggingface.co/api/datasets/miracl/miracl-corpus/tree/"
        + corpus_meta["sha"]
        + "?recursive=true&limit=1000",
        raw / "miracl-corpus-tree.json",
    )
    converted = read_json(
        "https://huggingface.co/api/datasets/miracl/miracl/tree/"
        + converted_meta["sha"]
        + "?recursive=true&limit=1000",
        raw / "miracl-converted-tree.json",
    )
    result = {
        "pins": {
            "topics": metadata["sha"],
            "corpus": corpus_meta["sha"],
            "converted": converted_meta["sha"],
        },
        "datasets": {},
    }
    requests = []
    for lang in LANGUAGES:
        base = (
            "https://huggingface.co/datasets/miracl/miracl/resolve/"
            + metadata["sha"]
            + f"/miracl-v1.0-{lang}/"
        )
        topics_path = fetch(
            base + f"topics/topics.miracl-v1.0-{lang}-dev.tsv",
            raw / f"miracl-{lang}-topics.tsv",
        )
        qrels_path = fetch(
            base + f"qrels/qrels.miracl-v1.0-{lang}-dev.tsv",
            raw / f"miracl-{lang}-qrels.tsv",
        )
        topics = dict(
            line.split("\t", 1) for line in topics_path.read_text().splitlines()
        )
        qrels = {}
        for line in qrels_path.read_text().splitlines():
            qid, _, docid, relevance = line.split()
            qrels.setdefault(qid, {})[docid] = int(relevance)
        eligible = [qid for qid in topics if any(qrels.get(qid, {}).values())]
        selected = sorted(eligible, key=lambda qid: stable_key(lang + ":" + qid))[:40]
        assert len(selected) == 40
        wanted = {docid for qid in selected for docid in qrels[qid]}
        dataset = {
            "language": lang,
            "source": "miracl",
            "source_split": "dev",
            "questions": [
                {"id": qid, "q": topics[qid], "qrels": qrels[qid]} for qid in selected
            ],
            "documents": {},
            "topics_sha256": digest(topics_path),
            "qrels_sha256": digest(qrels_path),
        }
        result["datasets"]["miracl-" + lang] = dataset
        parquet_paths = [
            p["path"]
            for p in converted
            if p["path"].startswith(lang + "/dev/") and p["path"].endswith(".parquet")
        ]
        if parquet_paths:
            for part in parquet_paths:
                path = fetch(
                    "https://huggingface.co/datasets/miracl/miracl/resolve/"
                    + converted_meta["sha"]
                    + "/"
                    + part,
                    raw / ("miracl-" + lang + "-" + Path(part).name),
                )
                for row in pq.read_table(path).to_pylist():
                    if row["query_id"] not in selected:
                        continue
                    for field, rel in (
                        ("positive_passages", 1),
                        ("negative_passages", 0),
                    ):
                        for doc in row[field]:
                            assert qrels[row["query_id"]][doc["docid"]] == rel
                            dataset["documents"][doc["docid"]] = doc
        else:
            for row in trees:
                if row["path"].startswith(f"miracl-corpus-v1.0-{lang}/") and row[
                    "path"
                ].endswith(".gz"):
                    requests.append((lang, row["path"], wanted))
        print(
            "selected",
            lang,
            len(selected),
            "queries",
            len(wanted),
            "judged docs",
            flush=True,
        )
    write_json(root / "miracl-selection.json", result)

    def scan(item):
        lang, part, wanted = item
        path = fetch(
            "https://huggingface.co/datasets/miracl/miracl-corpus/resolve/"
            + corpus_meta["sha"]
            + "/"
            + part,
            raw / part,
        )
        found = {}
        key = re.compile(rb'"docid"\s*:\s*"([^"\\]+)"')
        with gzip.open(path, "rb") as stream:
            for line in stream:
                match = key.search(line)
                if match and match[1].decode() in wanted:
                    row = json.loads(line)
                    found[row["docid"]] = row
        print("scanned", part, len(found), "wanted docs", flush=True)
        return lang, found

    # Two downloads/scans at once leave the shared ingest host mostly idle.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        for lang, found in executor.map(scan, requests):
            result["datasets"]["miracl-" + lang]["documents"].update(found)
    for label, dataset in result["datasets"].items():
        wanted = {docid for q in dataset["questions"] for docid in q["qrels"]}
        missing = wanted - dataset["documents"].keys()
        assert not missing, (label, sorted(missing))
        print("ready", label, len(dataset["documents"]), flush=True)
    write_json(root / "miracl.json", result)


def beir(root):
    result = {}
    for name in ("scifact", "arguana"):
        path = fetch(
            f"https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/{name}.zip",
            root / "raw" / (name + ".zip"),
        )
        with zipfile.ZipFile(path) as archive:
            docs = [
                json.loads(line)
                for line in archive.read(name + "/corpus.jsonl").splitlines()
            ]
            queries = {
                r["_id"]: r["text"]
                for r in (
                    json.loads(line)
                    for line in archive.read(name + "/queries.jsonl").splitlines()
                )
            }
            qrels = {}
            for line in (
                archive.read(name + "/qrels/test.tsv").decode().splitlines()[1:]
            ):
                qid, docid, score = line.split("\t")
                qrels.setdefault(qid, {})[docid] = int(score)
        chosen = sorted(qrels, key=lambda qid: stable_key(name + ":" + qid))[:40]
        result[name] = {
            "language": "en",
            "source": name,
            "source_split": "test",
            "sha256": digest(path),
            "questions": [
                {"id": qid, "q": queries[qid], "qrels": qrels[qid]} for qid in chosen
            ],
            "documents": {
                d["_id"]: {"docid": d["_id"], "title": d["title"], "text": d["text"]}
                for d in docs
            },
        }
        print(
            "ready", name, len(docs), "full corpus", len(chosen), "queries", flush=True
        )
    write_json(root / "beir.json", result)


def qa(root):
    import pyarrow.parquet as pq

    fetch(
        "https://dl.fbaipublicfiles.com/MLQA/MLQA_V1.zip", root / "raw" / "MLQA_V1.zip"
    )
    metadata = read_json(
        "https://huggingface.co/api/datasets/hotpotqa/hotpot_qa",
        root / "raw" / "hotpot-meta.json",
    )
    path = fetch(
        "https://huggingface.co/datasets/hotpotqa/hotpot_qa/resolve/"
        + metadata["sha"]
        + "/distractor/validation-00000-of-00001.parquet",
        root / "raw" / "hotpot-distractor-validation.parquet",
    )
    cases = []
    for row in pq.read_table(path).to_pylist():
        cases.append(
            {
                "_id": row["id"],
                "question": row["question"],
                "answer": row["answer"],
                "type": row["type"],
                "level": row["level"],
                "supporting_facts": list(
                    zip(
                        row["supporting_facts"]["title"],
                        row["supporting_facts"]["sent_id"],
                    )
                ),
                "context": list(
                    zip(row["context"]["title"], row["context"]["sentences"])
                ),
            }
        )
    write_json(root / "hotpot.json", cases)
    print("QA downloads ready", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("part", choices=("miracl", "beir", "qa"))
    args = parser.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    {"miracl": miracl, "beir": beir, "qa": qa}[args.part](args.root)
