"""Embed the frozen library snapshot and its queries into the local vector cache.

  parity    re-embed 64 seeded snapshot chunks with q4 exactly as production does
            (indexed_text, raw) and compare with the stored halfvec vectors
  docs      q37 (native, text_type=document) for every snapshot chunk's indexed_text;
            q4 document vectors are the stored ones and are never re-embedded
  queries   frozen known-item queries + the 24 pilot questions, for q4 (production
            prefix), q37 plain and q37 with the production task as instruct
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json

import numpy as np
from common import DATA, FIXTURES, QWEN3_QUERY_TASK, REPO, Spec, embed_cached, write_json

LIB = DATA / "library"


def chunks():
    return [json.loads(s) for s in gzip.open(LIB / "chunks.jsonl.gz", "rt", encoding="utf-8")]


def query_texts():
    fixture = json.loads((FIXTURES / "library-queries.json").read_text(encoding="utf-8"))
    pilot = json.loads((REPO / "bench/rag/fixtures/knowledge-base-pilot-questions.json").read_text(encoding="utf-8"))
    return [q["query"] for q in fixture["queries"]] + [q["query"] for q in pilot["questions"]]


async def main(step: str):
    rows = chunks()
    if step == "parity":
        picks = sorted(range(len(rows)), key=lambda i: hashlib.sha256(f"parity:{rows[i]['id']}".encode()).hexdigest())[:64]
        stored = np.load(LIB / "q4_stored.npy")[picks].astype(np.float32)
        fresh = await embed_cached(Spec("q4", "document"), [rows[i]["indexed_text"] for i in picks], phase="library-parity")
        fresh16 = fresh.astype(np.float16).astype(np.float32)
        cos = (stored * fresh16).sum(1) / np.linalg.norm(stored, axis=1) / np.linalg.norm(fresh16, axis=1)
        write_json(LIB / "parity.json", {"n": len(picks), "min": float(cos.min()), "mean": float(cos.mean()), "chunks": [rows[i]["id"] for i in picks], "cos": cos.tolist()})
        print(f"q4 fresh vs stored cosine over {len(picks)} chunks: min {cos.min():.5f} mean {cos.mean():.5f}")
    elif step == "docs":
        texts = list(dict.fromkeys(r["indexed_text"] for r in rows))
        print(len(texts), "unique indexed_text values")
        await embed_cached(Spec("q37", "document"), texts, phase="library-docs", concurrency=4)
    elif step == "queries":
        qs = list(dict.fromkeys(query_texts()))
        for spec in (Spec("q4", "query"), Spec("q37", "query"), Spec("q37", "query", instruct=QWEN3_QUERY_TASK)):
            await embed_cached(spec, qs, phase="library-queries", concurrency=2)
        print(len(qs), "queries embedded for three query shapes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("step", choices=("parity", "docs", "queries"))
    asyncio.run(main(parser.parse_args().step))
