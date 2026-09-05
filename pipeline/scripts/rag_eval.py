"""Retrieval diagnostics against a live workspace.

For each question, run the production ``search()`` and print the returned
passages with the evidence each leg contributed (vector rank and distance,
lexical rank, whether the exact tier put the hit there), then total hits
against the expected (file, chunk_idx) pairs. Runs inside the pipeline image
against the same DB and embedding provider the retrieval service uses:

    docker compose exec retrieval python scripts/rag_eval.py <workspace_id> \
        scripts/rag_eval/questions.json

Question files are lists of ``{"q": ..., "expect": [[file_name, chunk_idx], ...]}``.
An empty ``expect`` means the question should find nothing (irrelevant set).
The sets under ``scripts/rag_eval/`` are keyed to the lab corpus kept on the
ingest host in ``/opt/evo-rag-lab/samples``; re-chunking moves the indices,
so bump them together with CHUNKER_VERSION.
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections import defaultdict

from pipeline.config import cfg
from pipeline.retrieval import search
from pipeline.retrieval.chunking import estimate_tokens
from pipeline.retrieval.lang import detect_lang


def _short(name: str) -> str:
    stem = name.replace("biology-ib-", "")
    for ext in (".pdf", ".pptx", ".md", ".txt"):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    return stem[:16]


async def diagnose(ws: str, question: dict, totals: dict[str, dict[str, int]]) -> None:
    q = question["q"]
    expect = {(_short(f), i) for f, i in question.get("expect", [])}
    stats = search.SearchStats()
    hits = await search.search(workspace_id=ws, query=q, stats=stats)
    keys = [(_short(p.file_name), p.chunk_idx) for p in hits]
    found = [k for k in keys if k in expect]
    first = next((i + 1 for i, k in enumerate(keys) if k in expect), None)
    tokens = sum(estimate_tokens(p.as_context(i + 1)) for i, p in enumerate(hits))
    lang = detect_lang(q)

    bucket = totals[lang]
    bucket["questions"] += 1
    bucket["expect"] += len(expect)
    bucket["hits"] += len(found)
    bucket["first_hit_sum"] += first or 0
    bucket["first_hit_n"] += 1 if first else 0
    bucket["lex_alive"] += 1 if any(p.lex_rank is not None for p in hits) else 0
    bucket["tier_hits"] += sum(1 for p in hits if p.tier_only)
    bucket["tier_hits_expected"] += sum(
        1 for p, k in zip(hits, keys) if p.tier_only and k in expect
    )

    print(f"\n=== [{lang}] {q}")
    print(
        f"    terms={stats.query_terms} cjk_runs={stats.cjk_runs} "
        f"hits_lang={stats.hits_lang} "
        f"embed {stats.embed_ms}ms sql {stats.sql_ms}ms tokens={tokens}"
    )
    if expect:
        print(
            f"    expect {sorted(expect)}  hit {len(found)}/{len(expect)}  "
            f"first_hit_rank={first}"
        )
    print(
        f"    {'#':>2} {'file':<16} {'idx':>3} {'pg':>3} {'lang':<4} {'rrf':>7} "
        f"{'vr':>3} {'vdist':>6} {'lr':>3} tier  snippet"
    )
    for i, p in enumerate(hits, 1):
        mark = "*" if (_short(p.file_name), p.chunk_idx) in expect else " "
        dist = "-" if p.vec_dist is None else f"{p.vec_dist:.3f}"
        snippet = " ".join(p.text.split())[:80]
        print(
            f"   {mark}{i:>2} {_short(p.file_name):<16} {p.chunk_idx:>3} "
            f"{p.page_start or '-'!s:>3} {p.lang:<4} {p.score:.5f} "
            f"{p.vec_rank or '-'!s:>3} {dist:>6} {p.lex_rank or '-'!s:>3} "
            f"{'T' if p.tier_only else ' ':<4}  {snippet}"
        )


async def main(ws: str, questions: list[dict]) -> None:
    print(
        f"top_k={cfg.search_top_k} candidates={cfg.search_candidates} "
        f"per_file_cap={cfg.search_per_file_cap}"
    )
    totals: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for question in questions:
        await diagnose(ws, question, totals)
    print("\nTOTALS by query language")
    for lang, t in sorted(totals.items()):
        mean_first = (
            f"{t['first_hit_sum'] / t['first_hit_n']:.2f}" if t["first_hit_n"] else "-"
        )
        print(
            f"  {lang}: questions={t['questions']} hits@{cfg.search_top_k}="
            f"{t['hits']}/{t['expect']} mean_first_hit={mean_first} "
            f"lex_alive={t['lex_alive']}/{t['questions']} "
            f"tier_only_hits={t['tier_hits']} (expected: {t['tier_hits_expected']})"
        )
    # The per-language totals above are keyed by detect_lang on the question;
    # short lookups often carry no function word, so say how many landed in
    # 'und' before reading those totals.
    und = [q["q"] for q in questions if detect_lang(q["q"]) == "und"]
    if und:
        print(f"\n{len(und)} questions detected as 'und' (short or no function words).")


if __name__ == "__main__":
    ws = sys.argv[1]
    path = sys.argv[2] if len(sys.argv) > 2 else "scripts/rag_eval/questions.json"
    with open(path, encoding="utf-8") as fh:
        asyncio.run(main(ws, json.load(fh)))
