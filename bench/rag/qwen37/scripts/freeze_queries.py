"""Add text-based relevance sets to the library query fixture and freeze it.

Run once, after the queries are written and before either arm retrieves
anything from the library. A target's relevant set is the target itself,
every snapshot chunk whose normalised text is a near-copy of it (the library
holds the same passage in several books, e.g. business ethics and
business-government-society, os4 and ahss4), and any translation equivalents
the author listed, minus look-alikes the author excluded by hand. Nothing here
looks at embeddings.

Writes `relevant` / `relevant_excerpts` into the fixture and
data/qwen37-embedding/library/queries-freeze.json with hashes.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import re
import time
from collections import Counter, defaultdict

from common import DATA, FIXTURES, write_json

LIB = DATA / "library"
JACCARD, CONTAINMENT = 0.6, 0.8


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text.lower())).strip()


def chars(text: str, n: int = 5) -> set[str]:
    return {text[i : i + n] for i in range(max(1, len(text) - n + 1))}


def words(text: str, n: int = 4) -> set[int]:
    w = text.split()
    return {hash(" ".join(w[i : i + n])) for i in range(max(1, len(w) - n + 1))}


def main():
    path = FIXTURES / "library-queries.json"
    fixture = json.loads(path.read_text(encoding="utf-8"))
    chunks = [json.loads(s) for s in gzip.open(LIB / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    by_id = {c["id"]: c for c in chunks}
    normed = {c["id"]: norm(c["text"]) for c in chunks}
    index = defaultdict(set)
    for cid, text in normed.items():
        for h in words(text):
            index[h].add(cid)
    dup_cache = {}
    for q in fixture["queries"]:
        t = q["target"]
        assert t in by_id, t
        if t not in dup_cache:
            counts = Counter(c for h in words(normed[t]) for c in index[h] if c != t)
            a = chars(normed[t])
            dups = []
            for cid, shared in counts.items():
                if shared < 3:
                    continue
                b = chars(normed[cid])
                inter = len(a & b)
                if inter / len(a | b) >= JACCARD or inter / len(a) >= CONTAINMENT:
                    dups.append(cid)
            dup_cache[t] = sorted(dups)
        for e in q.get("equivalents", []):
            assert e in by_id, e
        relevant = sorted({t, *dup_cache[t], *q.get("equivalents", [])} - set(q.get("exclude", [])))
        q["relevant"] = relevant
        q["relevant_excerpts"] = sorted({f"{by_id[c]['content_id']}/{by_id[c]['excerpt_id']}" for c in relevant})
    path.write_text(json.dumps(fixture, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    snapshot = json.loads((LIB / "snapshot.json").read_text(encoding="utf-8"))
    extra = [q["id"] for q in fixture["queries"] if len(q["relevant"]) > 1]
    write_json(
        LIB / "queries-freeze.json",
        {
            "frozen_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "fixture_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "snapshot_sha256": snapshot["sha256"],
            "queries": len(fixture["queries"]),
            "queries_with_extra_relevant": len(extra),
            "rule": {"char5_jaccard": JACCARD, "containment": CONTAINMENT},
        },
    )
    print(len(fixture["queries"]), "queries;", len(extra), "with more than one relevant chunk")
    for q in fixture["queries"]:
        if len(q["relevant"]) > 1:
            print(" ", q["id"], q["target"], "->", [r for r in q["relevant"] if r != q["target"]])


if __name__ == "__main__":
    main()
