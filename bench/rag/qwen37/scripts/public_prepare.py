"""Build the public benchmark corpus and question sets.

Inputs are the Sept 5/6 files re-fetched with bench/rag/broad/scripts/fetch_data.py
into data/qwen37-embedding/public/ (miracl.json and beir.json are byte-identical
to the Sept 5 freeze once line endings are normalised). Documents are chunked
with the current production chunker exactly like the Sept 5 index_corpus.py:
"# title\n\ntext" -> chunk_markdown -> Chunk.indexed_text().

main: the Sept 6 360 questions (40 per MIRACL language, SciFact, ArguAna),
      MIRACL pools of their judged passages, full BEIR corpora.
dev:  10 further questions per MIRACL es/ja/ko/zh (the only languages with a
      local parquet of judged passages) and per BEIR set, next in the same seeded
      order; used only to choose the qwen3.7 query handling before the main run.
      Their MIRACL pools are the main pool plus the dev questions' judged passages.

Output: data/qwen37-embedding/public/{chunks.jsonl.gz, questions.json}
"""

from __future__ import annotations

import gzip
import hashlib
import json
import sys
import zipfile
from pathlib import Path

from common import DATA, REPO, write_json

from pipeline.retrieval.chunking import CHUNKER_VERSION, chunk_markdown

sys.path.insert(0, str(REPO / "bench" / "rag" / "broad" / "scripts"))
from fetch_data import stable_key  # noqa: E402  (same seed and ordering as Sept 5)

PUB = DATA / "public"
DEV_LANGS = ("es", "ja", "ko", "zh")


def chunk_doc(doc: dict) -> list[str]:
    title = (doc.get("title") or "").strip()
    markdown = ("# " + title + "\n\n" if title else "") + doc["text"]
    chunks = chunk_markdown(markdown)
    assert chunks, doc["docid"]
    return [c.indexed_text() for c in chunks]


def main():
    import pyarrow.parquet as pq

    miracl = json.loads((PUB / "miracl.json").read_text(encoding="utf-8"))["datasets"]
    beir = json.loads((PUB / "beir.json").read_text(encoding="utf-8"))
    questions = {"main": [], "dev": []}
    pools: dict[str, dict[str, dict]] = {}  # pool name -> docid -> doc

    for label, ds in miracl.items():
        lang = ds["language"]
        pools[label] = dict(ds["documents"])
        for q in ds["questions"]:
            questions["main"].append({"id": f"{label}:{q['id']}", "cohort": label, "pool": label, "q": q["q"], "qrels": q["qrels"]})
        if lang not in DEV_LANGS:
            continue
        raw = PUB / "raw"
        topics = dict(line.split("\t", 1) for line in (raw / f"miracl-{lang}-topics.tsv").read_text(encoding="utf-8").splitlines())
        qrels = {}
        for line in (raw / f"miracl-{lang}-qrels.tsv").read_text(encoding="utf-8").splitlines():
            qid, _, docid, rel = line.split()
            qrels.setdefault(qid, {})[docid] = int(rel)
        eligible = [qid for qid in topics if any(qrels.get(qid, {}).values())]
        ordered = sorted(eligible, key=lambda qid: stable_key(lang + ":" + qid))
        assert [q["id"] for q in ds["questions"]] == ordered[:40], "selection drifted from Sept 5"
        dev_ids = ordered[40:50]
        dev_pool = dict(ds["documents"])
        for row in pq.read_table(raw / f"miracl-{lang}-0000.parquet").to_pylist():
            if row["query_id"] in dev_ids:
                for field in ("positive_passages", "negative_passages"):
                    for doc in row[field]:
                        dev_pool[doc["docid"]] = doc
        missing = {d for qid in dev_ids for d in qrels[qid]} - dev_pool.keys()
        assert not missing, (label, sorted(missing)[:5])
        pools[label + ":dev"] = dev_pool
        for qid in dev_ids:
            questions["dev"].append({"id": f"{label}:{qid}", "cohort": label, "pool": label + ":dev", "q": topics[qid], "qrels": qrels[qid]})

    for name, ds in beir.items():
        pools[name] = ds["documents"]
        for q in ds["questions"]:
            questions["main"].append({"id": f"{name}:{q['id']}", "cohort": name, "pool": name, "q": q["q"], "qrels": q["qrels"], "exclude": q["id"]})
        with zipfile.ZipFile(PUB / "raw" / f"{name}.zip") as archive:
            texts = {r["_id"]: r["text"] for r in map(json.loads, archive.read(f"{name}/queries.jsonl").splitlines())}
            qrels = {}
            for line in archive.read(f"{name}/qrels/test.tsv").decode().splitlines()[1:]:
                qid, docid, score = line.split("\t")
                qrels.setdefault(qid, {})[docid] = int(score)
        ordered = sorted(qrels, key=lambda qid: stable_key(name + ":" + qid))
        assert [q["id"] for q in ds["questions"]] == ordered[:40]
        for qid in ordered[40:50]:
            questions["dev"].append({"id": f"{name}:{qid}", "cohort": name, "pool": name, "q": texts[qid], "qrels": qrels[qid], "exclude": qid})

    # Chunk every document once; a pool lists the docids it contains.
    docs: dict[str, dict] = {}
    for pool in pools.values():
        for docid, doc in pool.items():
            docs.setdefault(docid, doc)
    with gzip.open(PUB / "chunks.jsonl.gz", "wt", encoding="utf-8") as out:
        n = 0
        for docid in sorted(docs):
            for idx, text in enumerate(chunk_doc(docs[docid])):
                out.write(json.dumps({"docid": docid, "idx": idx, "text": text}, ensure_ascii=False) + "\n")
                n += 1
    write_json(
        PUB / "questions.json",
        {
            "chunker": CHUNKER_VERSION,
            "pools": {name: sorted(pool) for name, pool in pools.items()},
            "questions": questions,
        },
    )
    print("docs", len(docs), "chunks", n, "main", len(questions["main"]), "dev", len(questions["dev"]))
    print("chunks sha256", hashlib.sha256((PUB / "chunks.jsonl.gz").read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
