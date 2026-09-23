"""Top-k and abstention diagnostic over the lab workspace and the live library.

For every question, run the production hybrid statement with its full
candidate pool and keep the per-leg evidence each row already carries (vector
rank and cosine distance, lexical rank, exact-tier flag, fused score). Then
evaluate cut rules offline, without another provider call: fixed k, an absolute
vector-distance ceiling, a gap to the best hit, a per-book cap and cross-book
exact-text grouping for the library, and whether a search should return
nothing at all. Read-only against both databases; the only provider calls are
query embeddings.

    uv run --project pipeline python bench/rag/scripts/topk_abstention_eval.py run
    uv run --project pipeline python bench/rag/scripts/topk_abstention_eval.py analyze

`run` needs the lab database container (`capy-odl-agentic-db` on the ingest
host) running and opens the playground's ssh tunnel. Raw rows land under
`bench/rag/reports/local/2026-09-21-topk-abstention/` (ignored).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "lab/playground/scripts"), str(ROOT / "pipeline")]
FIXTURES = ROOT / "bench/rag/fixtures"
OUT = ROOT / "bench/rag/reports/local/2026-09-21-topk-abstention"
WORKSPACE = "odl_eval_odl_nocaption"
CANDIDATES = 40
LIBRARY_POOLS = (40, 80)
TOP_K = 5
PER_FILE_CAP = 4


# ----------------------------------------------------------------- questions


def workspace_questions() -> list[dict]:
    items = []
    for path in sorted(FIXTURES.glob("questions*.json")):
        for q in json.loads(path.read_text(encoding="utf-8")):
            items.append({"set": path.stem, "query": q["q"], "expect": q.get("expect") or []})
    return items


def library_questions() -> list[dict]:
    items = []
    pilot = json.loads((FIXTURES / "knowledge-base-pilot-questions.json").read_text(encoding="utf-8"))
    for q in pilot["questions"]:
        items.append(
            {
                "set": "pilot",
                "id": q["id"],
                "query": q["query"],
                "topics": q["expected_topics"],
                "roles": q["expected_roles"],
                "unanswerable": bool(q["unanswerable"]),
            }
        )
    probe = json.loads(
        (ROOT / "bench/rag/reports/2026-09-20-knowledge-search-fit/search-probe.json").read_text(
            encoding="utf-8"
        )
    )
    for case in probe["cases"]:
        items.append(
            {
                "set": "probe",
                "id": case["id"],
                "query": case["query"],
                "topics": case["topics"],
                "roles": case["roles"],
                "unanswerable": case["id"] == "uncovered-topic",
            }
        )
    for path in sorted(FIXTURES.glob("questions*irrelevant.json")):
        for i, q in enumerate(json.loads(path.read_text(encoding="utf-8"))):
            items.append(
                {
                    "set": path.stem,
                    "id": f"{path.stem}-{i}",
                    "query": q["q"],
                    "topics": [],
                    "roles": [],
                    "unanswerable": True,
                }
            )
    return items


# ----------------------------------------------------------------------- run


def _slim(row: dict) -> dict:
    text = row["text"]
    return {
        "id": row["id"],
        "file_id": row["file_id"],
        "file_name": row.get("file_name"),
        "chunk_idx": row.get("chunk_idx"),
        "lang": row.get("lang"),
        "score": float(row["score"]),
        "flat_score": float(row["flat_score"]),
        "vec_rank": row.get("vec_rank"),
        "vec_dist": None if row.get("vec_dist") is None else float(row["vec_dist"]),
        "lex_rank": row.get("lex_rank"),
        "chars": len(text),
        "text_hash": hashlib.md5(re.sub(r"\s+", " ", text.lower()).strip().encode()).hexdigest(),
        "head": re.sub(r"\s+", " ", text)[:160],
    }


async def _embedder():
    from pipeline import registry
    from pipeline.retrieval import models

    cache: dict[tuple, list[float]] = {}
    sem = asyncio.Semaphore(4)

    async def embed(query: str, pin: dict) -> list[float]:
        key = (query, pin["embedding_provider_slug"], pin["embedding_model_slug"], pin["embedding_model_version"])
        if key in cache:
            return cache[key]
        spec = registry.resolve_pinned(key[1], key[2], key[3], registry.Slot.RETRIEVAL)
        async with sem:
            vectors = await models.embed([models.format_query(query, spec)], spec=spec)
        cache[key] = vectors[0]
        return vectors[0]

    return embed


async def run_workspace(out: Path, embed) -> None:
    from pipeline.retrieval import store
    from pipeline.retrieval.chunking import search_query_terms

    # Open the pool once before fanning out: store.pool() has no lock, and
    # concurrent first calls each opened a pool through the tunnel.
    db = await store.pool()
    pin = await store.workspace_embedding_pin(WORKSPACE)
    items = workspace_questions()
    sem = asyncio.Semaphore(4)
    done = 0

    async def one(item: dict) -> dict:
        nonlocal done
        async with sem:
            vector = await embed(item["query"], pin)
            # An explicit connection drops the notes leg of the statement; the
            # frozen lab schema predates rag_material_contents and holds no notes.
            async with db.connection() as conn:
                rows = await store.hybrid_search(
                    workspace_id=WORKSPACE,
                    vector=vector,
                    terms=search_query_terms(item["query"]),
                    file_ids=None,
                    candidates=CANDIDATES,
                    pin=pin,
                    conn=conn,
                )
        done += 1
        if done % 25 == 0:
            print(f"workspace: {done}/{len(items)}", flush=True)
        return {**item, "candidates": [_slim(r) for r in rows]}

    results = await asyncio.gather(*(one(item) for item in items))
    with (out / "workspace.jsonl").open("w", encoding="utf-8") as f:
        for rec in results:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"workspace: {len(results)} questions")


async def run_library(out: Path, embed) -> None:
    from pipeline.config import cfg
    from pipeline.retrieval import library, store
    from pipeline.retrieval.chunking import search_query_terms

    items = library_questions()
    records = []
    # A direct connection rather than library.pool(): the pool's first attempt
    # through the tunnel fails and its ten-second wait then raises, and the
    # runner hangs cancelling the pool's tasks before the error is printed.
    async with await _library_connection(cfg) as conn:
        cur = await conn.execute(
            "SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim "
            "FROM workspaces WHERE id = %s",
            (library.WORKSPACE,),
        )
        pin = dict(await cur.fetchone())
        for item in items:
            vector = await embed(item["query"], pin)
            modes = [("plain", [], [])]
            if item["topics"] or item["roles"]:
                modes.append(("filtered", item["topics"], item["roles"]))
            for mode, topics, roles in modes:
                # The wider pool only matters where a cap or grouping refills.
                for pool in LIBRARY_POOLS if mode == "filtered" else LIBRARY_POOLS[:1]:
                    rows = await store.hybrid_search(
                        workspace_id=library.WORKSPACE,
                        vector=vector,
                        terms=search_query_terms(item["query"]),
                        file_ids=None,
                        candidates=pool,
                        pin=pin,
                        conn=conn,
                        chunk_filter=library._VERIFIED_TAG_FILTER,
                        chunk_filter_params={
                            "min_confidence": cfg.library_tag_min_confidence,
                            "no_topics": not topics,
                            "topics": topics,
                            "no_roles": not roles,
                            "roles": roles,
                        },
                    )
                    chunk_to_excerpt = await library._chunk_excerpts(conn, [r["id"] for r in rows])
                    excerpts = await library._excerpts(conn, sorted(set(chunk_to_excerpt.values())))
                    cands = []
                    for r in rows:
                        e = excerpts[chunk_to_excerpt[r["id"]]]
                        cands.append(
                            {
                                **_slim(r),
                                "excerpt_id": e.id,
                                "book_id": e.book_id,
                                "roles": e.roles,
                                "topic_ids": e.topic_ids,
                                "section_path": e.section_path,
                            }
                        )
                    records.append({**item, "mode": mode, "pool": pool, "candidates": cands})
            print(f"library: {item['set']}/{item['id']}", flush=True)
    with (out / "library.jsonl").open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"library: {len(records)} runs")


async def _library_connection(cfg):
    import psycopg
    from psycopg.rows import dict_row

    return await psycopg.AsyncConnection.connect(
        cfg.library_dsn,
        row_factory=dict_row,
        connect_timeout=20,
        options="-c statement_timeout=120000 -c default_transaction_read_only=on",
    )


def _environment() -> None:
    """Tunnel, provider keys and both database URLs, before any pipeline import."""
    import os

    from common import LIBRARY_PORT, prepare_environment, ssh  # lab/playground/scripts

    prepare_environment("lab")
    if not os.environ.get("LIBRARY_DATABASE_URL"):
        # The ingest worker carries no library URL; the read-only role's password
        # lives in the library container's env file on the same host.
        # One argument: ssh hands it to the remote shell as a whole, so the pipe survives.
        password = ssh("grep ^LIBRARY_DB_READER_PASSWORD= /opt/capy-library-db/.env | cut -d= -f2").strip()
        if len(password) < 16:
            raise RuntimeError("could not read the library reader password from the ingest host")
        os.environ["LIBRARY_DATABASE_URL"] = (
            f"postgresql://capy_library_reader:{password}@127.0.0.1:{LIBRARY_PORT}/library"
        )


async def run(out: Path) -> None:
    _environment()
    out.mkdir(parents=True, exist_ok=True)
    embed = await _embedder()
    if not (out / "workspace.jsonl").exists():
        await run_workspace(out, embed)
    await run_library(out, embed)


# ------------------------------------------------------------------ lexcheck

_ALL_TERM_SQL = """
WITH scoped AS (
    SELECT fc.content_id FROM rag_file_contents fc
    JOIN rag_contents rc ON rc.id = fc.content_id AND rc.status = 'ready'
    JOIN files f ON f.id = fc.file_id
    WHERE fc.workspace_id = %(ws)s AND f.trashed_at IS NULL),
q AS (
    SELECT m.lang, websearch_to_tsquery(m.cfg::regconfig, %(all_of)s) AS all_of
    FROM unnest(%(langs)s::text[], %(cfgs)s::text[]) AS m(lang, cfg))
SELECT count(*) AS n FROM rag_chunks c
JOIN scoped s ON s.content_id = c.content_id
JOIN q ON q.lang = c.lang
WHERE c.workspace_id = %(ws)s AND c.search @@ q.all_of
"""


async def all_term_hits(conn, workspace_id: str, query: str) -> int:
    """How many chunks in scope contain every term of the query, in the chunk's
    own language configuration. The fused rows do not say whether a lexical
    candidate matched all terms or one, and that is the difference between an
    identifier the corpus holds and a stray word it shares with the question."""
    from pipeline.retrieval.chunking import search_query_terms
    from pipeline.retrieval.lang import TS_CONFIG

    terms = search_query_terms(query)
    cur = await conn.execute(
        _ALL_TERM_SQL,
        {"ws": workspace_id, "all_of": terms.all_of, "langs": list(TS_CONFIG), "cfgs": list(TS_CONFIG.values())},
    )
    row = await cur.fetchone()
    return int((row["n"] if isinstance(row, dict) else row[0]) or 0)


async def lexcheck(out: Path) -> None:
    """Annotate the collected records with all-term lexical hit counts."""
    _environment()
    from pipeline.retrieval import library, store

    path = out / "workspace.jsonl"
    recs = [json.loads(line) for line in path.open(encoding="utf-8")]
    db = await store.pool()
    async with db.connection() as conn:
        for rec in recs:
            rec["all_term_hits"] = await all_term_hits(conn, WORKSPACE, rec["query"])
    with path.open("w", encoding="utf-8") as f:
        for rec in recs:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"workspace: {sum(1 for r in recs if r['all_term_hits'])}/{len(recs)} questions have an all-term match")
    path = out / "library.jsonl"
    if path.exists() and library.enabled():
        from pipeline.config import cfg

        recs = [json.loads(line) for line in path.open(encoding="utf-8")]
        async with await _library_connection(cfg) as conn:
            cache: dict[str, int] = {}
            for rec in recs:
                if rec["query"] not in cache:
                    cache[rec["query"]] = await all_term_hits(conn, library.WORKSPACE, rec["query"])
                rec["all_term_hits"] = cache[rec["query"]]
        with path.open("w", encoding="utf-8") as f:
            for rec in recs:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"library: {sum(1 for q in cache.values() if q)}/{len(cache)} queries have an all-term match")


# ------------------------------------------------------------------- analyze


def _cap(cands: list[dict], key: str, cap: int) -> list[dict]:
    seen: Counter = Counter()
    kept, overflow = [], []
    for c in cands:
        if seen[c[key]] < cap:
            seen[c[key]] += 1
            kept.append(c)
        else:
            overflow.append(c)
    return kept + overflow


def _exact(c: dict) -> bool:
    return c["score"] != c["flat_score"]


def _best_dist(cands: list[dict]) -> float | None:
    dists = [c["vec_dist"] for c in cands if c["vec_dist"] is not None]
    return min(dists) if dists else None


def _apply(
    cands: list[dict], rule: dict, group_key: str, cap: int, top_k: int, all_term: int | None = None
) -> list[dict]:
    """Return the shown list under one rule; an empty list is an abstention."""
    kind = rule["kind"]
    if kind in ("abstain", "abstain_lex"):
        best = _best_dist(cands)
        far = best is None or best > rule["t"]
        no_lex = not all_term if kind == "abstain_lex" else True
        if far and no_lex and not any(_exact(c) for c in cands):
            return []
        kept = cands
    elif kind == "dist":
        kept = [c for c in cands if _exact(c) or (c["vec_dist"] is not None and c["vec_dist"] <= rule["t"])]
    elif kind == "gap":
        best = _best_dist(cands)
        kept = [
            c
            for c in cands
            if _exact(c) or (best is not None and c["vec_dist"] is not None and c["vec_dist"] <= best + rule["g"])
        ]
    else:
        kept = cands
    if rule.get("dedupe"):
        seen: set = set()
        deduped = []
        for c in kept:
            if c["text_hash"] in seen:
                continue
            seen.add(c["text_hash"])
            deduped.append(c)
        kept = deduped
    return _cap(kept, group_key, rule.get("cap", cap))[: rule.get("k", top_k)]


def _fmt(x: float) -> str:
    return f"{x:.2f}"


def analyze_workspace(out: Path) -> None:
    recs = [json.loads(line) for line in (out / "workspace.jsonl").open(encoding="utf-8")]
    positives = [r for r in recs if r["expect"]]
    negatives = [r for r in recs if not r["expect"]]
    print(f"\n## Workspace {WORKSPACE}: {len(positives)} answerable, {len(negatives)} no-answer questions\n")

    # Where does the relevant hit sit, and how far is it?
    rel_dists, best_pos, best_neg, rel_ranks = [], [], [], []
    for r in positives:
        files = {e[0] for e in r["expect"]}
        best_pos.append(_best_dist(r["candidates"]))
        for i, c in enumerate(r["candidates"], 1):
            if c["file_name"] in files:
                rel_ranks.append(i)
                if c["vec_dist"] is not None:
                    rel_dists.append(c["vec_dist"])
                break
        else:
            rel_ranks.append(None)
    for r in negatives:
        best_neg.append(_best_dist(r["candidates"]))
    q = lambda xs: [round(v, 3) for v in statistics.quantiles([x for x in xs if x is not None], n=10)] if xs else []
    print("no-answer questions, best vec_dist and top file under the baseline:")
    for r in sorted(negatives, key=lambda r: _best_dist(r["candidates"]) or 9):
        top = r["candidates"][0] if r["candidates"] else {}
        print(f"  {_best_dist(r['candidates']) or 0:.3f}  {r['query'][:48]:<48} {top.get('file_name', '-')[:28]} lex_rank={top.get('lex_rank')}")
    print("answerable questions whose best vec_dist is above 0.5:")
    for r in sorted(positives, key=lambda r: -( _best_dist(r["candidates"]) or 0)):
        best = _best_dist(r["candidates"]) or 0
        if best <= 0.5:
            break
        print(f"  {best:.3f}  {r['query'][:48]:<48} set={r['set']}")
    print("first relevant file at rank:", Counter("miss" if x is None else ("1-5" if x <= 5 else "6-10" if x <= 10 else "11-40") for x in rel_ranks))
    print("vec_dist of first relevant hit, deciles:", q(rel_dists))
    print("best vec_dist, answerable, deciles:      ", q(best_pos))
    print("best vec_dist, no-answer, deciles:       ", q(best_neg))
    print("chunk-level label match (file, chunk_idx) inside top 5 under the baseline:",
          sum(1 for r in positives if any((c["file_name"], c["chunk_idx"]) in {tuple(e) for e in r["expect"]}
                                          for c in _apply(r["candidates"], {"kind": "k"}, "file_id", PER_FILE_CAP, TOP_K))),
          "of", len(positives))

    rules = [
        {"name": "baseline k5", "kind": "k"},
        {"name": "k8", "kind": "k", "k": 8},
        {"name": "k10", "kind": "k", "k": 10},
    ]
    rules += [{"name": f"abstain if best dist > {t}", "kind": "abstain", "t": t} for t in (0.5, 0.55, 0.6, 0.65)]
    if all("all_term_hits" in r for r in recs):
        rules += [
            {"name": f"abstain if best dist > {t} and no all-term lexical match", "kind": "abstain_lex", "t": t}
            for t in (0.5, 0.55, 0.6, 0.65)
        ]
    rules += [{"name": f"drop hits with dist > {t}", "kind": "dist", "t": t} for t in (0.55, 0.6, 0.65)]
    rules += [{"name": f"drop hits beyond best + {g}", "kind": "gap", "g": g} for g in (0.05, 0.1, 0.15)]
    # The locale "irrelevant" sets are irrelevant to their own locale's files,
    # not to this mixed workspace; only the English set plus the three
    # locale questions no file answers are true no-answer questions here.
    true_negatives = [r for r in negatives if r["set"] == "questions-irrelevant" or any(
        r["query"].startswith(s) for s in ("Hardy-Weinberg", "粤语")
    )]
    print(f"\ntrue no-answer questions in this workspace: {len(true_negatives)} of {len(negatives)} labeled")
    print("\n| Rule | Answerable file hit | Mean shown | True no-answer mean shown | True no-answer returning 0 |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for rule in rules:
        hits = shown_p = 0
        for r in positives:
            files = {e[0] for e in r["expect"]}
            shown = _apply(r["candidates"], rule, "file_id", PER_FILE_CAP, TOP_K, r.get("all_term_hits"))
            shown_p += len(shown)
            hits += any(c["file_name"] in files for c in shown)
        shown_n = zero_n = 0
        for r in true_negatives:
            shown = _apply(r["candidates"], rule, "file_id", PER_FILE_CAP, TOP_K, r.get("all_term_hits"))
            shown_n += len(shown)
            zero_n += not shown
        print(
            f"| {rule['name']} | {hits}/{len(positives)} | {_fmt(shown_p / len(positives))} "
            f"| {_fmt(shown_n / len(true_negatives))} | {zero_n}/{len(true_negatives)} |"
        )


def analyze_library(out: Path) -> None:
    recs = [json.loads(line) for line in (out / "library.jsonl").open(encoding="utf-8")]

    def fold(cands: list[dict]) -> list[dict]:
        """One entry per excerpt, best chunk first, identical text within a book collapsed
        (what library.search does before the cut)."""
        seen_e, seen_t, out_ = set(), set(), []
        for c in cands:
            if c["excerpt_id"] in seen_e:
                continue
            key = (c["book_id"], c["text_hash"])
            if key in seen_t:
                continue
            seen_e.add(c["excerpt_id"])
            seen_t.add(key)
            out_.append(c)
        return out_

    for mode in ("filtered", "plain"):
        for pool in LIBRARY_POOLS:
            rows = [r for r in recs if r["mode"] == mode and r["pool"] == pool]
            if not rows:
                continue
            answerable = [r for r in rows if not r["unanswerable"]]
            negatives = [r for r in rows if r["unanswerable"]]
            print(f"\n## Library, {mode} search, {pool} candidates: {len(answerable)} answerable, {len(negatives)} no-answer\n")
            best_pos = [_best_dist(r["candidates"]) for r in answerable]
            best_neg = [_best_dist(r["candidates"]) for r in negatives]
            q = lambda xs: [round(v, 3) for v in statistics.quantiles([x for x in xs if x is not None], n=4)] if len([x for x in xs if x is not None]) > 1 else [x for x in xs if x is not None]
            print("best vec_dist quartiles, answerable:", q(best_pos), " no-answer:", q(best_neg))
            rules = [
                {"name": "baseline top 5", "kind": "k"},
                {"name": "per-book cap 3", "kind": "k", "cap": 3},
                {"name": "per-book cap 2", "kind": "k", "cap": 2},
                {"name": "cap 3 + cross-book exact grouping", "kind": "k", "cap": 3, "dedupe": True},
            ]
            rules += [{"name": f"abstain if best dist > {t}", "kind": "abstain", "t": t} for t in (0.5, 0.55, 0.6, 0.65)]
            if all("all_term_hits" in r for r in rows):
                rules += [
                    {"name": f"abstain if best dist > {t} and no all-term lexical match", "kind": "abstain_lex", "t": t}
                    for t in (0.5, 0.55, 0.6, 0.65)
                ]
            rules += [{"name": f"drop hits with dist > {t}", "kind": "dist", "t": t} for t in (0.55, 0.6, 0.65)]
            rules += [{"name": f"drop hits beyond best + {g}", "kind": "gap", "g": g} for g in (0.05, 0.1)]
            print("\n| Rule | Topic hits | Role hits | First hit topic+role | Books/result | Mean shown | No-answer mean shown | No-answer returning 0 |")
            print("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
            for rule in rules:
                topic = role = first = shown_p = books = 0
                for r in answerable:
                    shown = _apply(fold(r["candidates"]), rule, "book_id", 99, TOP_K, r.get("all_term_hits"))
                    shown_p += len(shown)
                    books += len({c["book_id"] for c in shown})
                    et, er = set(r["topics"]), set(r["roles"])
                    topic += sum(1 for c in shown if not et or set(c["topic_ids"]) & et)
                    role += sum(1 for c in shown if not er or set(c["roles"]) & er)
                    if shown and (not et or set(shown[0]["topic_ids"]) & et) and (not er or set(shown[0]["roles"]) & er):
                        first += 1
                shown_n = zero_n = 0
                for r in negatives:
                    shown = _apply(fold(r["candidates"]), rule, "book_id", 99, TOP_K, r.get("all_term_hits"))
                    shown_n += len(shown)
                    zero_n += not shown
                n = len(answerable)
                print(
                    f"| {rule['name']} | {topic}/{shown_p} | {role}/{shown_p} | {first}/{n} | {_fmt(books / n)} "
                    f"| {_fmt(shown_p / n)} | {_fmt(shown_n / max(1, len(negatives)))} | {zero_n}/{len(negatives)} |"
                )
            crowded = sum(1 for r in answerable if len({c["book_id"] for c in _apply(fold(r["candidates"]), {"kind": "k"}, "book_id", 99, TOP_K)}) == 1)
            print(f"\nanswerable results drawn from a single book under the baseline: {crowded}/{len(answerable)}")


def analyze(out: Path) -> None:
    analyze_workspace(out)
    analyze_library(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stage", choices=["run", "lexcheck", "analyze"])
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    if args.stage == "analyze":
        analyze(args.out)
        return
    import os
    import traceback

    try:
        asyncio.run(run(args.out) if args.stage == "run" else lexcheck(args.out))
    except BaseException:  # noqa: BLE001 - report, then leave without the pool teardown that hangs
        traceback.print_exc()
        os._exit(1)
    os._exit(0)


if __name__ == "__main__":
    main()
