"""Paired workspace abstention trial through the production chat loop.

The frozen lab has no note index. Read/list/summary adapters use a verified
local snapshot, preserving production scope validation and passage rendering.
Search uses production hybrid SQL through a read-only lab connection. No
database schema changes, writes, rerankers, or production configuration edits.

    .venv/bin/python bench/rag/scripts/workspace_agentic_retrieval.py audit
    .venv/bin/python bench/rag/scripts/workspace_agentic_retrieval.py run
    .venv/bin/python bench/rag/scripts/workspace_agentic_retrieval.py check
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "bench/rag/fixtures/workspace-agentic-cases.json"
OUT = ROOT / "bench/rag/reports/local/2026-09-21-workspace-agentic"
LAB = ROOT / "bench/rag/fixtures/local/2026-09-09-odl-agentic"
WORKSPACE = "odl_eval_odl_nocaption"
DSN = "postgresql://postgres@127.0.0.1:15435/odl_eval"
OPTIONS = "-c default_transaction_read_only=on -c statement_timeout=30000"
sys.path[:0] = [str(ROOT / "lab/playground/scripts"), str(ROOT / "pipeline")]


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def abstains(rows: list[dict], all_terms: int, ceiling: float) -> bool:
    distances = [float(r["vec_dist"]) for r in rows if r["vec_dist"] is not None]
    return (
        (not distances or min(distances) > ceiling)
        and not all_terms
        and not any(r["score"] != r["flat_score"] for r in rows)
    )


def audit() -> None:
    snapshot, fixture = read(OUT / "snapshot.json"), read(FIXTURE)
    sources = read(LAB / "sources.json")["sources"]
    source_by_id = {s["source_id"]: s for s in sources}
    files = {f["id"].removeprefix(WORKSPACE + "_"): f for f in snapshot["files"]}
    checks = []
    for source in sources:
        local_hash = sha(LAB / source["original"])
        file = files[source["source_id"]]
        assert local_hash == source["original_sha256"] == file["source_sha256"]
        assert sha(LAB / source["pdf"]) == source["pdf_sha256"]
        checks.append(
            {
                "source_id": source["source_id"],
                "source_sha256": local_hash,
                "content_id": file["content_id"],
                "content_status": file["content_status"],
                "file_status": file["status"],
                "indexed": file["indexed"],
                "chunks": file["chunks"],
            }
        )
    rebound = []
    for case in fixture["cases"]:
        anchors = []
        for evidence in case["evidence"]:
            source_id, page = evidence["source_id"], evidence["pdf_page"]
            anchors.append(
                {
                    "source_id": source_id,
                    "pdf_page": page,
                    "pdf_sha256": source_by_id[source_id]["pdf_sha256"],
                    "chunks_on_page": [
                        c["id"]
                        for c in snapshot["chunks"]
                        if c["file_id"] == WORKSPACE + "_" + source_id
                        and c["page_start"] is not None
                        and c["page_start"] <= page <= c["page_end"]
                    ],
                }
            )
        rebound.append(
            {
                "id": case["id"],
                "runtime_answerability": case["runtime_answerability"],
                "anchors": anchors,
            }
        )
    legacy_path = (
        ROOT / "bench/rag/reports/local/2026-09-21-topk-abstention/workspace.jsonl"
    )
    legacy = [json.loads(line) for line in legacy_path.read_text().splitlines()]
    unavailable = {
        f["name"]
        for f in snapshot["files"]
        if f["content_status"] != "ready" or not f["chunks"]
    }
    excluded = [
        {
            "set": r["set"],
            "query": r["query"],
            "files": sorted({e[0] for e in r["expect"]}),
        }
        for r in legacy
        if r["expect"] and {e[0] for e in r["expect"]} <= unavailable
    ]
    save(
        OUT / "audit.json",
        {
            "snapshot_sha256": sha(OUT / "snapshot.json"),
            "fixture_sha256": sha(FIXTURE),
            "legacy_sha256": sha(legacy_path),
            "source_checks": checks,
            "excluded_legacy_positives": excluded,
            "rebound_page_anchors": rebound,
            "warning": "Page anchors nominate passages for source review; page overlap is not an answer-quality score.",
        },
    )
    print(
        json.dumps(
            {
                "verified_sources": len(checks),
                "searchable_chunks": len(snapshot["chunks"]),
                "legacy_positives_with_unavailable_sources": len(excluded),
                "cases": len(rebound),
            }
        )
    )


async def run(only: set[str] | None, repeat: int) -> None:
    from common import PdfResolver, ensure_tunnel, worker_env

    ensure_tunnel((15435,))
    # Only the existing UAT embedding credential is retained, in memory.
    remote = worker_env()
    if not remote.get("DEEPINFRA_API_KEY"):
        raise RuntimeError("UAT worker has no DeepInfra embedding credential")
    os.environ.update(
        DEEPINFRA_API_KEY=remote["DEEPINFRA_API_KEY"],
        OLLAMA_BENCH_KEY="ollama",
        DATABASE_URL=DSN,
        LIBRARY_DATABASE_URL="",
        SENTRY_DSN="",
        CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S="180",
    )
    del remote

    import capture as playground_capture
    import playground
    import psycopg
    from psycopg.rows import dict_row

    from pipeline import registry
    from pipeline.retrieval import capture, models, pending, search, store, tools
    from pipeline.retrieval.chunking import search_query_terms
    from pipeline.retrieval.lang import TS_CONFIG

    playground.LOCAL = playground_capture.LOCAL = OUT
    fixture, snapshot = read(FIXTURE), read(OUT / "snapshot.json")
    assert snapshot["material_count"] == 0
    paths = [
        FIXTURE,
        Path(__file__),
        OUT / "snapshot.json",
        ROOT / "lab/playground/scripts/playground.py",
        ROOT / "lab/playground/scripts/capture.py",
        ROOT / "pipeline/pipeline/prompts/chat.py",
        ROOT / "pipeline/pipeline/retrieval/agent.py",
        ROOT / "pipeline/pipeline/retrieval/tools.py",
        ROOT / "pipeline/pipeline/retrieval/search.py",
        ROOT / "pipeline/pipeline/retrieval/store.py",
        ROOT / "pipeline/pipeline/generated/agent_tools.json",
    ]
    hashes = {str(p.relative_to(ROOT)): sha(p) for p in paths}
    freeze_path = OUT / "freeze.json"
    if freeze_path.exists():
        assert read(freeze_path)["hashes"] == hashes, (
            "Inputs/runtime changed since comparison freeze"
        )
    else:
        save(
            freeze_path,
            {
                "created_unix": time.time(),
                "hashes": hashes,
                "protocol": fixture["protocol"],
                "candidate": fixture["candidate"],
                "pin": snapshot["pin"],
            },
        )
    original_search_handler = tools._search_workspace
    by_file: dict[str, list[dict]] = {}
    for chunk in snapshot["chunks"]:
        by_file.setdefault(chunk["file_id"], []).append(chunk)

    async def outline(workspace_id):
        assert workspace_id == WORKSPACE
        return {"files": snapshot["files"], "chapters": snapshot["chapters"]}

    async def file_range(*, workspace_id, file_id, start, count):
        assert workspace_id == WORKSPACE
        return [c for c in by_file.get(file_id, []) if c["chunk_idx"] >= start][:count]

    async def summaries(workspace_id, file_ids):
        assert workspace_id == WORKSPACE
        return [f for f in snapshot["files"] if f["id"] in file_ids]

    async def empty_pending(*args, **kwargs):
        return pending.PendingSources()

    resolver = PdfResolver("lab")

    async def pdf_path(workspace_id, file_id):
        assert workspace_id == WORKSPACE
        return await resolver.path(file_id)

    async def forbidden_pool():
        raise RuntimeError(
            "Unexpected database access outside the read-only lab connection"
        )

    async def list_sources(args, ctx):
        allowed = None if ctx.file_ids is None else set(ctx.file_ids)
        return tools._result(
            "\n".join(
                tools._file_line(f, False)
                for f in snapshot["files"]
                if allowed is None or f["id"] in allowed
            )
        )

    store.workspace_outline, store.read_file_range, store.file_summaries = (
        outline,
        file_range,
        summaries,
    )
    store.pool, capture.pdf_path = forbidden_pool, pdf_path
    pending.load = empty_pending
    tools._register("list_sources", list_sources)
    spec = registry.resolve_pinned(
        snapshot["pin"]["embedding_provider_slug"],
        snapshot["pin"]["embedding_model_slug"],
        snapshot["pin"]["embedding_model_version"],
        registry.Slot.RETRIEVAL,
    )
    searches: list[dict] = []
    arm = "baseline"
    async with await psycopg.AsyncConnection.connect(
        DSN, row_factory=dict_row, connect_timeout=10, options=OPTIONS, autocommit=True
    ) as conn:
        cur = await conn.execute("SHOW default_transaction_read_only")
        assert (await cur.fetchone())["default_transaction_read_only"] == "on"

        async def search_variant(
            *, workspace_id, query, file_ids=None, top_k=None, stats=None
        ):
            assert workspace_id == WORKSPACE
            started = time.perf_counter()
            vectors = await models.embed([models.format_query(query, spec)], spec=spec)
            embedded = time.perf_counter()
            terms = search_query_terms(query)
            rows = await store.hybrid_search(
                workspace_id=WORKSPACE,
                vector=vectors[0],
                terms=terms,
                file_ids=file_ids,
                candidates=40,
                pin=snapshot["pin"],
                conn=conn,
            )
            cur = await conn.execute(
                """
                SELECT count(*) AS n FROM rag_chunks c
                JOIN rag_file_contents fc ON fc.content_id=c.content_id
                JOIN rag_contents rc ON rc.id=fc.content_id AND rc.status='ready'
                JOIN files f ON f.id=fc.file_id
                JOIN unnest(%(langs)s::text[],%(cfgs)s::text[]) AS q(lang,cfg) ON q.lang=c.lang
                WHERE fc.workspace_id=%(ws)s AND c.workspace_id=%(ws)s AND f.trashed_at IS NULL
                  AND (%(no_filter)s OR f.id=ANY(%(ids)s))
                  AND c.search @@ websearch_to_tsquery(q.cfg::regconfig,%(all_of)s)
                """,
                {
                    "langs": list(TS_CONFIG),
                    "cfgs": list(TS_CONFIG.values()),
                    "ws": WORKSPACE,
                    "ids": list(file_ids or []),
                    "no_filter": not file_ids,
                    "all_of": terms.all_of,
                },
            )
            all_terms = (await cur.fetchone())["n"]
            rejected = arm == "abstain" and abstains(
                rows, all_terms, fixture["candidate"]["ceiling"]
            )
            passages = [search.Passage.from_row(r) for r in rows]
            top = [] if rejected else search._cap_per_file(passages, 4)[:5]
            search._mark_tier_only(top, rows, 5)
            if stats is not None:
                langs = Counter(p.lang for p in top)
                stats.hits_lang = langs.most_common(1)[0][0] if langs else "und"
                stats.query_terms, stats.cjk_runs = terms.terms, terms.cjk_runs
                stats.embed_ms = round((embedded - started) * 1000)
                stats.sql_ms = round((time.perf_counter() - embedded) * 1000)
            searches.append(
                {
                    "query": query,
                    "file_ids": file_ids,
                    "all_term_hits": all_terms,
                    "abstained": rejected,
                    "shown": [p.chunk_id for p in top],
                    "elapsed_seconds": time.perf_counter() - started,
                    "candidates": rows,
                }
            )
            return top

        async def search_handler(args, ctx):
            count = len(searches)
            result = await original_search_handler(args, ctx)
            if len(searches) > count and searches[-1]["abstained"]:
                result.text_parts = [fixture["candidate"]["empty_text"]]
            return result

        tools.search = search_variant
        tools._register("search_workspace", search_handler)
        for index, case in enumerate(fixture["cases"]):
            if only and case["id"] not in only:
                continue
            for arm in (
                ("baseline", "abstain") if index % 2 == 0 else ("abstain", "baseline")
            ):
                folder = OUT / "runs" / f"repeat-{repeat}" / case["id"] / arm
                if (folder / "result.json").exists():
                    continue
                searches.clear()
                config = playground.load_config("chat")
                config.update(
                    target="lab",
                    workspace_id=WORKSPACE,
                    curate=False,
                    locale=case["language"],
                    scope_file_ids=[
                        WORKSPACE + "_" + s for s in case["scope_source_ids"]
                    ]
                    if case["scope_source_ids"]
                    else None,
                )
                config["model"].update(
                    provider_slug="zai",
                    model_slug="glm-5.3-flash",
                    version=1,
                    thinking="low",
                    adhoc={
                        "context_window_tokens": 200000,
                        "thinking_levels": ["low"],
                        "params": {"temperature": 0},
                    },
                    transport={
                        "url": "http://127.0.0.1:11434/v1/chat/completions",
                        "key_env": "OLLAMA_BENCH_KEY",
                        "wire_model": "glm-5.3-flash:cloud",
                        "body": "zai",
                    },
                )
                config["tools"] = [
                    "search_workspace",
                    "list_sources",
                    "describe_documents",
                    "read_document",
                    "capture_page",
                ]
                turn = playground.Turn(config, case["question"], [], resolver)
                turn.run_dir = folder
                turn.state["run_dir"] = folder
                folder.mkdir(parents=True, exist_ok=True)
                started = time.perf_counter()
                final, errors = {}, []
                with (folder / "events.jsonl").open("w", encoding="utf-8") as stream:
                    async with asyncio.timeout(600):
                        async for event in turn.events():
                            if event.get("type") == "block_delta":
                                continue
                            stream.write(
                                json.dumps(event, ensure_ascii=False, default=str)
                                + "\n"
                            )
                            if event.get("type") == "done":
                                final = event
                            if event.get("type") == "error":
                                errors.append(event)
                result = {
                    "id": case["id"],
                    "arm": arm,
                    "repeat": repeat,
                    "question": case["question"],
                    "runtime_answerability": case["runtime_answerability"],
                    "elapsed_seconds": time.perf_counter() - started,
                    "final": final,
                    "errors": errors,
                    "searches": searches,
                }
                save(folder / "result.json", result)
                print(
                    json.dumps(
                        {
                            "id": case["id"],
                            "arm": arm,
                            "repeat": repeat,
                            "seconds": round(result["elapsed_seconds"], 1),
                            "searches": len(searches),
                            "abstentions": sum(s["abstained"] for s in searches),
                            "errors": errors,
                            "tokens": final.get("telemetry", {}).get(
                                "reportedInputTokens"
                            ),
                        }
                    ),
                    flush=True,
                )


def check() -> None:
    row = {"vec_dist": 0.61, "score": 1, "flat_score": 1}
    assert abstains([row], 0, 0.6)
    assert not abstains([row], 1, 0.6)
    assert not abstains([{**row, "score": 2}], 0, 0.6)
    assert not abstains([{**row, "vec_dist": 0.6}], 0, 0.6)
    assert abstains([], 0, 0.6)
    print("abstention boundary and lexical exceptions passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("audit", "run", "check"))
    parser.add_argument("--only", help="comma-separated case IDs")
    parser.add_argument("--repeat", type=int, default=0)
    args = parser.parse_args()
    if args.mode == "audit":
        audit()
    elif args.mode == "check":
        check()
    else:
        asyncio.run(run(set(args.only.split(",")) if args.only else None, args.repeat))


if __name__ == "__main__":
    main()
