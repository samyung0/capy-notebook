"""API behaviour probes run before any evaluation.

1. DeepInfra 4B parity: re-embed sampled live-library chunks exactly as
   production does and compare against the stored halfvec vectors.
2. qwen3.7 wire shapes: native text_type=document vs the OpenAI-compatible
   route, query vs query+instruct, native 1024 vs truncated 2560.
3. Billed tokens per text: qwen3.7 (per shape) vs DeepInfra 4B on identical text.
4. Batch limit: 21 texts on each Alibaba route.

Writes data/qwen37-embedding/probe.json. Costs well under one cent.
"""

from __future__ import annotations

import asyncio
import json

import numpy as np
from common import (
    DATA,
    ELIGIBLE_SQL,
    QWEN3_QUERY_TASK,
    ProviderError,
    Spec,
    billed_tokens,
    call,
    client,
    library_conn,
    parse_halfvec,
    write_json,
)


def cos(a, b):
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    return float(a @ b / np.linalg.norm(a) / np.linalg.norm(b))


def sample_chunks():
    with library_conn() as conn:
        # One chunk from each of 20 books spread by id hash, plus scripted picks.
        rows = conn.execute(
            f"""
            SELECT DISTINCT ON (c.book_id) c.id, c.book_id, c.lang, c.indexed_text, v.embedding::text
            {ELIGIBLE_SQL.replace("WHERE", "JOIN rag_chunk_vectors_2560 v ON v.chunk_id = c.id WHERE", 1)}
              AND c.book_id = ANY(%s)
            ORDER BY c.book_id, md5(c.id)
            """,
            (
                [
                    "a-grammar-of-palula",
                    "a-grammar-of-moloko",
                    "a-grammar-of-yakkha",
                    "chinese-contract-law",
                    "the-unicode-cookbook-for-linguists-managing-writing-systems-",
                    "concepts-of-biology",
                    "os4",
                    "physics",
                    "java-java-java-object-oriented-problem-solving-3-e",
                    "open-logic-project",
                    "basic-income-tax-second-edition",
                    "understanding-basic-music-theory",
                    "the-science-of-sleep",
                    "compact-anthology-of-world-literature-part-1",
                    "computer-networking-principles-protocols-and-practice",
                    "business-ethics",
                    "marine-ecology-notes-2nd-edition",
                    "brief-calculus",
                    "keys-to-understanding-the-middle-east",
                    "methodologies-tools-and-new-developments-for-e-learning",
                ],
            ),
        ).fetchall()
        cjk = conn.execute(
            rf"""SELECT c.id, c.book_id, c.lang, c.indexed_text, v.embedding::text
            {ELIGIBLE_SQL.replace("WHERE", "JOIN rag_chunk_vectors_2560 v ON v.chunk_id = c.id WHERE", 1)}
              AND c.indexed_text ~ '[一-鿿]' ORDER BY md5(c.id) LIMIT 2"""
        ).fetchall()
    return rows + cjk


async def main():
    rows = sample_chunks()
    texts = [r[3] for r in rows]
    stored = [parse_halfvec(r[4]) for r in rows]
    result = {"chunks": [{"id": r[0], "book": r[1], "lang": r[2], "chars": len(r[3])} for r in rows]}
    per_text = {}
    async with client() as http:

        async def single(spec, text, phase="probe"):
            for attempt in range(4):
                try:
                    vectors, usage = await call(http, spec, [text], phase=phase)
                    return vectors[0], billed_tokens(usage)
                except ProviderError:
                    if attempt == 3:
                        raise
                    await asyncio.sleep(2 * (attempt + 1))

        shapes = {
            "q4_doc": Spec("q4", "document"),
            "q37_doc": Spec("q37", "document"),
            "q37_compat": Spec("q37", "document", endpoint="compat"),
            "q37_query": Spec("q37", "query"),
            "q37_query_instruct": Spec("q37", "query", instruct=QWEN3_QUERY_TASK),
            "q37_doc_1024": Spec("q37", "document", dim=1024),
        }
        for name, spec in shapes.items():
            per_text[name] = [await single(spec, t) for t in texts]

        # Batch limit on both Alibaba routes (21 > documented 20).
        limits = {}
        for name, spec in (("native", Spec("q37", "document")), ("compat", Spec("q37", "document", endpoint="compat"))):
            try:
                _, usage = await call(http, spec, ["batch limit probe"] * 21, phase="probe-batch")
                limits[name] = {"accepted_21": True, "tokens": billed_tokens(usage)}
            except ProviderError as exc:
                limits[name] = {"accepted_21": False, "status": exc.status, "error": str(exc)[:300]}
        # Empty-instruction baseline for the fixed per-request/per-text overhead.
        short = {}
        for name in ("q4_doc", "q37_doc", "q37_compat", "q37_query", "q37_query_instruct"):
            short[name] = [ (await single(shapes[name], w))[1] for w in ("a", "hello world", "光合作用")]

    vec = {k: [v for v, _ in vals] for k, vals in per_text.items()}
    tok = {k: [t for _, t in vals] for k, vals in per_text.items()}
    result["q4_fresh_vs_stored_cos"] = [cos(a, b) for a, b in zip(vec["q4_doc"], stored)]
    result["q37_native_doc_vs_compat_cos"] = [cos(a, b) for a, b in zip(vec["q37_doc"], vec["q37_compat"])]
    result["q37_doc_vs_query_cos"] = [cos(a, b) for a, b in zip(vec["q37_doc"], vec["q37_query"])]
    result["q37_query_vs_instruct_cos"] = [cos(a, b) for a, b in zip(vec["q37_query"], vec["q37_query_instruct"])]
    result["q37_1024_vs_truncated_2560_cos"] = [
        cos(a, np.asarray(b)[:1024]) for a, b in zip(vec["q37_doc_1024"], vec["q37_doc"])
    ]
    result["q37_vector_norms"] = [float(np.linalg.norm(v)) for v in vec["q37_doc"]]
    result["q4_vector_norms"] = [float(np.linalg.norm(v)) for v in vec["q4_doc"]]
    result["tokens_per_text"] = tok
    result["tokens_minus_q4"] = {
        k: [a - b for a, b in zip(v, tok["q4_doc"])] for k, v in tok.items() if k != "q4_doc"
    }
    result["short_text_tokens"] = short
    result["batch_limits"] = limits
    write_json(DATA / "probe.json", result)
    summary = {
        k: (round(min(v), 5), round(max(v), 5))
        for k, v in result.items()
        if k.endswith("_cos") or k.endswith("norms")
    }
    print(json.dumps(summary, indent=1))
    print("tokens q4 vs others:", json.dumps({k: sum(v) for k, v in tok.items()}))
    print("per-text overhead vs q4:", json.dumps(result["tokens_minus_q4"]))
    print("short:", json.dumps(short))
    print("limits:", json.dumps(limits))


if __name__ == "__main__":
    asyncio.run(main())
