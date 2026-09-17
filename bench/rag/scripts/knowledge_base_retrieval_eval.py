"""Library retrieval experiment over the published knowledge base.

Arms, all over the same frozen 24 questions and the live library index,
scored against the questions' expected topics and roles:

- plain: the frozen query through production hybrid search (chunk unit).
- excerpt: the same hits grouped by excerpt, ranked by best chunk.
- rolequery: role-phrased rewrites of the request, the kind a curate prompt
  would make the chat model issue ("worked example of <topic>"), fused per
  role, excerpt unit.
- filtered: plain query, wide candidate budget, excerpt unit, kept only when
  the excerpt's verified tags match the expected topics and roles.
- library: the production module ``pipeline.retrieval.library.search`` with
  the expected topics and roles as its arguments (the tag predicates inside
  the SQL) and the cached query vector.
- browse: no query at all; the excerpts tagged with the expected topics,
  grouped by role, to see what the taxonomy alone can assemble.

Labels never enter prompts or search; they only score. The `filtered` and
`library` arms are the exception in a narrow sense: they take the expected
topics and roles as arguments, so their topic and role columns are true by
construction and carry no information. What those two arms measure is the
denominator — how many excerpts qualify at all, and which requests the corpus
cannot fill. Query embeddings are cached in the run directory like the pilot's.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from collections import Counter
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "pipeline"))
from knowledge_base_batch import PilotError, read_json, save_json

ROLE_PHRASES = {
    "introduction": "introduction to {topic}",
    "formal": "formal definition and formula of {topic}",
    "worked_example": "worked example of {topic}",
    "exercise": "practice questions and exercises on {topic}",
    "summary": "summary of {topic}",
    "reference": "reference table for {topic}",
}
TAG_MIN_CONFIDENCE = 0.8
TOP = 5


def configure(url: str) -> None:
    os.environ.update(
        DATABASE_URL=url,
        PARSER_URL="http://127.0.0.1:1/file_parse",
        RELEASE_SHA="library-retrieval-eval",
        CAPY_PARSE_SHARED_DIR=str(ROOT / "data/knowledge-base-pilot-v4/spool"),
        B2_BUCKET="",
        SENTRY_DSN="",
        CAPY_SEARCH_TOP_K=str(TOP),
        CAPY_SEARCH_PER_FILE_CAP="4",
    )
    from pipeline.config import cfg

    cfg.library_dsn = url
    key = dotenv_values(ROOT / ".env.local").get("DEEPINFRA_API_KEY")
    if not key:
        raise PilotError("Missing DEEPINFRA_API_KEY in .env.local")
    os.environ["DEEPINFRA_API_KEY"] = key


def load_library(url: str):
    """The live library: every book's current content, nothing retained."""
    import psycopg

    from pipeline.retrieval.library import WORKSPACE

    current = (
        "JOIN rag_file_contents fc ON fc.content_id=x.content_id AND fc.workspace_id=%s"
    )
    with psycopg.connect(url) as conn:
        topics = {
            r[0]: r[1] for r in conn.execute("SELECT id, label FROM library_topics")
        }
        excerpts = {}
        for r in conn.execute(
            "SELECT x.id, x.book_id, x.section_path, x.chunk_ids, x.roles, x.topic_ids, x.confidence, x.evidence_verified, x.tag_status "
            f"FROM library_excerpts x {current}",
            (WORKSPACE,),
        ):
            excerpts[r[0]] = {
                "id": r[0],
                "book_id": r[1],
                "section_path": r[2],
                "chunk_ids": r[3],
                "roles": r[4],
                "topic_ids": r[5],
                "confidence": r[6],
                "verified": bool(r[7])
                and r[8] == "tagged"
                and (r[6] or 0) >= TAG_MIN_CONFIDENCE,
            }
        chunk_to_excerpt = {
            r[0]: r[1]
            for r in conn.execute(
                f"SELECT x.id, x.excerpt_id FROM library_chunks x {current}",
                (WORKSPACE,),
            )
        }
    return topics, excerpts, chunk_to_excerpt


def group_by_excerpt(rows, chunk_to_excerpt, limit=TOP):
    """Best chunk per excerpt, in first-seen (score) order."""
    seen, out = set(), []
    for row in rows:
        excerpt = chunk_to_excerpt[row["id"]]
        if excerpt in seen:
            continue
        seen.add(excerpt)
        out.append(
            {"excerpt_id": excerpt, "chunk_id": row["id"], "score": row["score"]}
        )
        if len(out) == limit:
            break
    return out


def fuse(rankings: list[list[dict]], limit=TOP):
    """Reciprocal-rank fusion of several excerpt rankings."""
    scores = {}
    for ranking in rankings:
        for rank, hit in enumerate(ranking, start=1):
            scores[hit["excerpt_id"]] = scores.get(hit["excerpt_id"], 0) + 1 / (
                60 + rank
            )
    return [
        {"excerpt_id": e, "score": s}
        for e, s in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
    ]


def score_hits(hits, excerpts, expected_topics, expected_roles):
    topic_hits = role_hits = 0
    for hit in hits:
        tag = excerpts[hit["excerpt_id"]]
        if set(tag["topic_ids"]) & expected_topics:
            topic_hits += 1
        if set(tag["roles"]) & expected_roles:
            role_hits += 1
    top1 = hits[:1]
    return {
        "hits": len(hits),
        "topic_hits": topic_hits,
        "role_hits": role_hits,
        "top1_topic": bool(
            top1 and set(excerpts[top1[0]["excerpt_id"]]["topic_ids"]) & expected_topics
        ),
        "top1_role": bool(
            top1 and set(excerpts[top1[0]["excerpt_id"]]["roles"]) & expected_roles
        ),
        "books": len({excerpts[h["excerpt_id"]]["book_id"] for h in hits}),
    }


async def run(url: str, run_dir: Path, out: Path) -> dict:
    import knowledge_base_pilot as pilot

    from pipeline.retrieval import library, models, store
    from pipeline.retrieval.chunking import search_query_terms

    topics, excerpts, chunk_to_excerpt = load_library(url)
    questions = [
        q
        for q in read_json(
            ROOT / "bench/rag/fixtures/knowledge-base-pilot-questions.json"
        )["questions"]
        if not q["unanswerable"]
    ]
    spec = pilot.embedding_spec()
    # Every query text this experiment embeds, cached in the run directory.
    texts = {}
    for q in questions:
        texts[("plain", q["id"])] = q["query"]
        for role in q["expected_roles"] or ["introduction"]:
            for topic in q["expected_topics"]:
                texts[("rolequery", q["id"], role, topic)] = ROLE_PHRASES[role].format(
                    topic=topics[topic]
                )
    formatted = {k: models.format_query(v, spec) for k, v in texts.items()}
    vectors = await pilot.embed_cached(
        list(formatted.values()), run_dir, "library_retrieval_eval"
    )

    async def search(text: str, candidates: int):
        return await store.hybrid_search(
            workspace_id=library.WORKSPACE,
            vector=vectors[formatted_text(text)],
            terms=search_query_terms(text),
            file_ids=None,
            candidates=candidates,
        )

    def formatted_text(text):
        return models.format_query(text, spec)

    results, timings = [], Counter()
    try:
        for q in questions:
            expected_topics, expected_roles = (
                set(q["expected_topics"]),
                set(q["expected_roles"]),
            )
            arms = {}
            started = time.monotonic()
            plain_rows = await search(q["query"], 40)
            timings["plain"] += time.monotonic() - started
            arms["plain"] = [
                {"excerpt_id": chunk_to_excerpt[r["id"]], "chunk_id": r["id"]}
                for r in plain_rows[:TOP]
            ]
            arms["excerpt"] = group_by_excerpt(plain_rows, chunk_to_excerpt)

            rankings = []
            started = time.monotonic()
            for role in q["expected_roles"] or ["introduction"]:
                for topic in q["expected_topics"]:
                    rows = await search(texts[("rolequery", q["id"], role, topic)], 40)
                    rankings.append(group_by_excerpt(rows, chunk_to_excerpt, limit=20))
            timings["rolequery"] += time.monotonic() - started
            arms["rolequery"] = fuse(rankings)

            started = time.monotonic()
            wide = await search(q["query"], 200)
            timings["filtered"] += time.monotonic() - started
            grouped = group_by_excerpt(wide, chunk_to_excerpt, limit=200)
            arms["filtered"] = [
                g
                for g in grouped
                if excerpts[g["excerpt_id"]]["verified"]
                and set(excerpts[g["excerpt_id"]]["topic_ids"]) & expected_topics
                and (
                    not expected_roles
                    or set(excerpts[g["excerpt_id"]]["roles"]) & expected_roles
                )
            ][:TOP]

            started = time.monotonic()
            real = await library.search(
                q["query"],
                topics=sorted(expected_topics),
                roles=sorted(expected_roles),
                vector=vectors[formatted_text(q["query"])],
            )
            timings["library"] += time.monotonic() - started
            arms["library"] = [
                {"excerpt_id": e.id, "chunk_id": e.hit_chunk_id} for e in real.excerpts
            ]
            if not real.excerpts:
                print(
                    json.dumps(
                        {
                            "id": q["id"],
                            "library_empty_available_roles": real.available_roles,
                        }
                    )
                )

            browse = [
                e
                for e in excerpts.values()
                if e["verified"] and set(e["topic_ids"]) & expected_topics
            ]
            by_role = Counter(role for e in browse for role in e["roles"])
            arms["browse"] = [{"excerpt_id": e["id"]} for e in browse]
            record = {
                "id": q["id"],
                "split": q["split"],
                "expected_topics": sorted(expected_topics),
                "expected_roles": sorted(expected_roles),
                "arms": {
                    name: score_hits(hits, excerpts, expected_topics, expected_roles)
                    for name, hits in arms.items()
                    if name != "browse"
                },
                "browse": {
                    "excerpts": len(browse),
                    "books": len({e["book_id"] for e in browse}),
                    "roles": dict(sorted(by_role.items())),
                    "covers_expected_roles": bool(expected_roles)
                    and all(by_role.get(r, 0) > 0 for r in expected_roles),
                },
                "hit_ids": {
                    name: [h["excerpt_id"] for h in hits]
                    for name, hits in arms.items()
                    if name != "browse"
                },
            }
            results.append(record)
            print(
                json.dumps(
                    {
                        "id": q["id"],
                        **{
                            a: f"{v['topic_hits']}/{v['hits']} t {v['role_hits']}/{v['hits']} r"
                            for a, v in record["arms"].items()
                        },
                        "browse": record["browse"]["excerpts"],
                    }
                ),
                flush=True,
            )
    finally:
        await store.close_pool()
        await library.close_pool()

    def totals(name):
        rows = [r["arms"][name] for r in results]
        hits = sum(r["hits"] for r in rows)
        return {
            "hits": hits,
            "topic_hits": sum(r["topic_hits"] for r in rows),
            "role_hits": sum(r["role_hits"] for r in rows),
            "top1_topic": sum(r["top1_topic"] for r in rows),
            "top1_role": sum(r["top1_role"] for r in rows),
            "mean_books": round(statistics.mean(r["books"] for r in rows), 2),
            "search_seconds_total": round(
                timings[name if name != "excerpt" else "plain"], 2
            ),
        }

    summary = {
        "books": sorted({e["book_id"] for e in excerpts.values()}),
        "questions": len(results),
        "tag_filter": {"min_confidence": TAG_MIN_CONFIDENCE, "evidence_verified": True},
        "arms": {
            name: totals(name)
            for name in ("plain", "excerpt", "rolequery", "filtered", "library")
        },
        "browse": {
            "questions_with_all_expected_roles": sum(
                r["browse"]["covers_expected_roles"] for r in results
            ),
            "median_excerpts": statistics.median(
                r["browse"]["excerpts"] for r in results
            ),
            "min_excerpts": min(r["browse"]["excerpts"] for r in results),
        },
        "verified_excerpts": sum(e["verified"] for e in excerpts.values()),
        "excerpts": len(excerpts),
        "results": results,
    }
    save_json(out, summary)
    print(json.dumps({k: v for k, v in summary.items() if k != "results"}, indent=1))
    return summary


def check() -> None:
    excerpts = {
        "e1": {"id": "e1", "book_id": "a", "topic_ids": ["t"], "roles": ["formal"]},
        "e2": {
            "id": "e2",
            "book_id": "b",
            "topic_ids": ["u"],
            "roles": ["worked_example"],
        },
    }
    mapping = {"c1": "e1", "c2": "e1", "c3": "e2"}
    rows = [
        {"id": "c1", "score": 3},
        {"id": "c2", "score": 2},
        {"id": "c3", "score": 1},
    ]
    grouped = group_by_excerpt(rows, mapping)
    assert [g["excerpt_id"] for g in grouped] == ["e1", "e2"], (
        "second chunk of e1 must collapse"
    )
    fused = fuse([[{"excerpt_id": "e1"}, {"excerpt_id": "e2"}], [{"excerpt_id": "e2"}]])
    assert fused[0]["excerpt_id"] == "e2", "e2 ranks in both lists and must win"
    s = score_hits(grouped, excerpts, {"t"}, {"worked_example"})
    assert s == {
        "hits": 2,
        "topic_hits": 1,
        "role_hits": 1,
        "top1_topic": True,
        "top1_role": False,
        "books": 2,
    }
    print("Library retrieval grouping, fusion and scoring checks passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["run", "check"])
    parser.add_argument(
        "--run-dir", type=Path, default=ROOT / "data/knowledge-base-pilot-v4/run"
    )
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.stage == "check":
        check()
        return
    url = os.environ.get("LIBRARY_DATABASE_URL") or dotenv_values(
        ROOT / ".env.local"
    ).get("LIBRARY_DATABASE_URL")
    if not url:
        raise PilotError("Set LIBRARY_DATABASE_URL")
    configure(url)
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    out = args.out or args.run_dir / "library-retrieval-eval.json"
    asyncio.run(run(url, args.run_dir, out))


if __name__ == "__main__":
    try:
        main()
    except PilotError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None
