"""Embed the public benchmark corpus and questions into the local vector cache.

  docs      every unique chunk text: q4 (DeepInfra, raw) and q37 (native, text_type=document)
  docs-q    q37 documents with text_type=query, i.e. what the OpenAI-compatible route
            returns for any input (diagnostic arm "q37 via compat")
  queries   main + dev questions: q4 with the production instruct prefix, q37 query
            without instruct, and q37 query with instruct = production task text
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import json

from common import DATA, QWEN3_QUERY_TASK, Spec, embed_cached

PUB = DATA / "public"


def texts():
    rows = [json.loads(s) for s in gzip.open(PUB / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    return list(dict.fromkeys(r["text"] for r in rows))


def questions():
    data = json.loads((PUB / "questions.json").read_text(encoding="utf-8"))["questions"]
    return list(dict.fromkeys(q["q"] for part in ("main", "dev") for q in data[part]))


QUERY_SPECS = {
    "q4": Spec("q4", "query"),
    "q37": Spec("q37", "query"),
    "q37i": Spec("q37", "query", instruct=QWEN3_QUERY_TASK),
}


async def main(step: str):
    if step == "docs":
        docs = texts()
        print(len(docs), "unique chunk texts")
        await embed_cached(Spec("q4", "document"), docs, phase="public-docs", concurrency=4)
        await embed_cached(Spec("q37", "document"), docs, phase="public-docs", concurrency=4)
    elif step == "docs-q":
        await embed_cached(Spec("q37", "query"), texts(), phase="public-docs-querymode", concurrency=4)
    elif step == "queries":
        qs = questions()
        print(len(qs), "unique questions")
        for spec in QUERY_SPECS.values():
            await embed_cached(spec, qs, phase="public-queries", concurrency=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("step", choices=("docs", "docs-q", "queries"))
    asyncio.run(main(parser.parse_args().step))
