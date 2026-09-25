"""Paired source-opening catalog trial on a copied runtime and read-only lab.

prepare freezes runtime and corpus inputs; run executes all fresh paired turns.
No database writes, identifier rewriting, reranking, or production changes.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "bench/rag/fixtures/workspace-opening-cases.json"
LOCAL = ROOT / "bench/rag/fixtures/local/2026-09-21-workspace-opening"
RUNTIME = LOCAL / "runtime"
OUT = ROOT / "bench/rag/reports/local/2026-09-21-workspace-opening"
CORPUS = ROOT / "bench/rag/fixtures/local/2026-09-09-odl-agentic"
OLD = ROOT / "bench/rag/reports/local/2026-09-21-workspace-agentic"
DSN = "postgresql://postgres@127.0.0.1:15435/odl_eval"
OPTIONS = "-c default_transaction_read_only=on -c statement_timeout=30000"


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def runtime_files():
    return sorted(
        p
        for folder in (
            "pipeline/pipeline",
            "lab/playground/scripts",
            "lab/playground/configs",
        )
        for p in (ROOT / folder).rglob("*")
        if p.is_file() and p.suffix in {".py", ".json", ".txt"}
    )


def prepare():
    if RUNTIME.exists():
        raise RuntimeError("Runtime already frozen; do not replace it")
    files = runtime_files()
    before = {str(p.relative_to(ROOT)): sha(p) for p in files}
    for file in files:
        dest = RUNTIME / file.relative_to(ROOT)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, dest)
    after = {str(p.relative_to(ROOT)): sha(p) for p in runtime_files()}
    assert before == after, "Source changed while copying"
    assert all(sha(RUNTIME / p) == h for p, h in before.items())
    save(LOCAL / "runtime-manifest.json", before)
    shutil.copyfile(OLD / "snapshot.json", LOCAL / "snapshot.json")
    snapshot = read(LOCAL / "snapshot.json")
    by_id = {f["id"]: f for f in snapshot["files"]}
    for source in read(CORPUS / "sources.json")["sources"]:
        assert sha(CORPUS / source["original"]) == source["original_sha256"]
        assert sha(CORPUS / source["pdf"]) == source["pdf_sha256"]
        assert (
            source["original_sha256"]
            == by_id[snapshot["workspace_id"] + "_" + source["source_id"]][
                "source_sha256"
            ]
        )
    print(
        json.dumps({"copied_runtime_files": len(files), "verified_sources": len(by_id)})
    )


def schedule(cases):
    rows = [(case, 0) for case in cases]
    rows += [(cases[0], repeat) for repeat in (1, 2)]
    return [
        (case, repeat, arm)
        for index, (case, repeat) in enumerate(rows)
        for arm in (
            ("baseline", "opening") if index % 2 == 0 else ("opening", "baseline")
        )
    ]


async def verify_lab(conn, snapshot):
    ws = snapshot["workspace_id"]
    cur = await conn.execute("SHOW transaction_read_only")
    assert (await cur.fetchone())["transaction_read_only"] == "on"
    cur = await conn.execute(
        "SELECT embedding_provider_slug,embedding_model_slug,embedding_model_version,embedding_dim FROM workspaces WHERE id=%s",
        (ws,),
    )
    assert await cur.fetchone() == snapshot["pin"]
    cur = await conn.execute(
        """SELECT f.id,f.name,f.chapter_id,f.status,f.indexed,f.source_sha256,fc.content_id,
        rc.status AS content_status,coalesce(cs.descriptor,'') AS descriptor,
        (SELECT count(*) FROM rag_chunks cc JOIN rag_file_contents rfc ON rfc.content_id=cc.content_id WHERE rfc.file_id=f.id) AS chunks
        FROM files f LEFT JOIN rag_file_contents fc ON fc.file_id=f.id
        LEFT JOIN rag_contents rc ON rc.id=fc.content_id
        LEFT JOIN rag_content_summaries cs ON cs.content_id=fc.content_id
        WHERE f.workspace_id=%s AND f.trashed_at IS NULL ORDER BY f.id""",
        (ws,),
    )
    # The detailed summary column was dropped on 2026-09-25; older snapshots still carry it.
    expected = [{k: v for k, v in f.items() if k != "summary"} for f in snapshot["files"]]
    assert await cur.fetchall() == sorted(expected, key=lambda f: f["id"])
    fields = [
        k for k in snapshot["chunks"][0] if k not in {"file_id", "file_name", "kind"}
    ]
    cur = await conn.execute(
        "SELECT "
        + ",".join("c." + k for k in fields)
        + ",fc.file_id,f.name AS file_name,'file' AS kind FROM rag_chunks c "
        "JOIN rag_file_contents fc ON fc.content_id=c.content_id JOIN files f ON f.id=fc.file_id "
        "WHERE c.workspace_id=%s AND fc.workspace_id=%s ORDER BY c.id",
        (ws, ws),
    )
    assert await cur.fetchall() == sorted(snapshot["chunks"], key=lambda c: c["id"])
    cur = await conn.execute(
        "SELECT count(*) AS n FROM materials WHERE workspace_id=%s", (ws,)
    )
    assert (await cur.fetchone())["n"] == snapshot["material_count"] == 0


async def run(preflight=False):
    manifest = read(LOCAL / "runtime-manifest.json")
    assert all(sha(RUNTIME / p) == h for p, h in manifest.items()), (
        "Copied runtime changed"
    )
    sys.path[:0] = [str(RUNTIME / "lab/playground/scripts"), str(RUNTIME / "pipeline")]
    import common

    common.LAB = CORPUS
    common.ensure_tunnel((15435,))
    remote = common.worker_env()
    if not remote.get("DEEPINFRA_API_KEY"):
        raise RuntimeError("Embedding credential unavailable")
    os.environ.update(
        DEEPINFRA_API_KEY=remote["DEEPINFRA_API_KEY"],
        DATABASE_URL=DSN,
        LIBRARY_DATABASE_URL="",
        SENTRY_DSN="",
        OLLAMA_BENCH_KEY="ollama",
        CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S="180",
        GATEWAY_URL="http://127.0.0.1:1",
        PIPELINE_SECRET="local-benchmark-only",
    )
    del remote
    import capture as playground_capture
    import playground
    import psycopg
    from psycopg.rows import dict_row

    from pipeline import registry
    from pipeline.retrieval import (
        capture,
        models,
        openui,
        pending,
        search,
        store,
        tools,
    )
    from pipeline.retrieval.chunking import search_query_terms

    assert Path(playground.__file__).is_relative_to(RUNTIME)
    assert Path(tools.__file__).is_relative_to(RUNTIME)
    playground.LOCAL = playground_capture.LOCAL = OUT
    snapshot, fixture = read(LOCAL / "snapshot.json"), read(FIXTURE)
    ws = snapshot["workspace_id"]
    by_file = {}
    for chunk in snapshot["chunks"]:
        by_file.setdefault(chunk["file_id"], []).append(chunk)
    for chunks in by_file.values():
        chunks.sort(key=lambda c: c["chunk_idx"])

    async def outline(workspace_id):
        assert workspace_id == ws
        return {"files": snapshot["files"], "chapters": snapshot["chapters"]}

    async def file_range(*, workspace_id, file_id, start, count):
        assert workspace_id == ws
        return [c for c in by_file.get(file_id, []) if c["chunk_idx"] >= start][:count]

    async def summaries(workspace_id, file_ids):
        assert workspace_id == ws
        return [f for f in snapshot["files"] if f["id"] in file_ids]

    async def empty_pending(*args, **kwargs):
        return pending.PendingSources()

    async def gateway(path, body, description):
        assert path == "/api/internal/documents/list" and body["workspaceId"] == ws
        return {
            "items": [
                {"id": f["id"], "kind": "source_file", "editable": False}
                for f in snapshot["files"]
            ]
        }

    async def forbidden_pool():
        raise RuntimeError("Unexpected DB access outside read-only lab connection")

    resolver = common.PdfResolver("lab")

    async def pdf_path(workspace_id, file_id):
        assert workspace_id == ws
        return await resolver.path(file_id)

    store.workspace_outline, store.read_file_range, store.file_summaries = (
        outline,
        file_range,
        summaries,
    )
    store.pool, capture.pdf_path = forbidden_pool, pdf_path
    pending.load, tools._gateway_read = empty_pending, gateway
    original_listing = tools._list_sources

    async def list_sources(args, ctx):
        # The ordinary playground omits actor identity. The lab inventory is
        # authorized and local; preserve the production listing after that seam.
        assert ctx.workspace_id == ws
        ctx.user_id = "workspace-opening-benchmark"
        return await original_listing(args, ctx)

    tools._register("list_sources", list_sources)
    original_line = tools._file_line
    arm = "baseline"

    def file_line(file, editable):
        line = original_line(file, editable)
        chunks = by_file.get(file["id"], [])
        if arm == "opening" and chunks and chunks[0]["section_path"]:
            line += "\n  Opening heading (source text): " + chunks[0]["section_path"]
        return line

    tools._file_line = file_line
    catalogs = {}
    for arm in ("baseline", "opening"):
        result = await list_sources({}, tools.ToolContext(workspace_id=ws))
        assert result.outcome == "succeeded"
        text = result.text()
        assert all(f["id"] in text for f in snapshot["files"])
        assert tools.limit_tool_result(text) == text
        catalogs[arm] = {"characters": len(text), "text": text, "truncated": False}
        scoped = await list_sources(
            {},
            tools.ToolContext(
                workspace_id=ws, file_ids=[ws + "_rag__es__sesgo-linguistico-digital"]
            ),
        )
        assert "variedades-espanol" not in scoped.text()
        assert "Mayor-Rocher" not in scoped.text()
        empty = await list_sources({}, tools.ToolContext(workspace_id=ws, file_ids=[]))
        assert all(f["id"] not in empty.text() for f in snapshot["files"])
    without_openings = "\n".join(
        line
        for line in catalogs["opening"]["text"].splitlines()
        if not line.startswith("  Opening heading (source text): ")
    )
    assert without_openings == catalogs["baseline"]["text"]
    assert "Mayor-Rocher1" in catalogs["opening"]["text"]
    save(OUT / "catalog-check.json", catalogs)
    spec = registry.resolve_pinned(
        snapshot["pin"]["embedding_provider_slug"],
        snapshot["pin"]["embedding_model_slug"],
        snapshot["pin"]["embedding_model_version"],
        registry.Slot.RETRIEVAL,
    )
    searches = []
    hashes = {
        "runner": sha(Path(__file__)),
        "fixture": sha(FIXTURE),
        "snapshot": sha(LOCAL / "snapshot.json"),
        "runtime_manifest": sha(LOCAL / "runtime-manifest.json"),
    }
    protocol = {
        "hashes": hashes,
        "cases": fixture,
        "schedule": [
            {"id": c["id"], "repeat": n, "arm": a}
            for c, n, a in schedule(fixture["cases"])
        ],
        "model": "glm-5.3-flash:cloud",
        "thinking": "low",
        "temperature": 0,
        "current_runtime": str(RUNTIME),
        "historical_results_are_not_controls": True,
    }
    protocol_path = OUT / ("preflight-protocol.json" if preflight else "protocol.json")
    if protocol_path.exists():
        assert read(protocol_path) == protocol, "Protocol changed"
    else:
        save(protocol_path, protocol)
    async with await psycopg.AsyncConnection.connect(
        DSN, options=OPTIONS, row_factory=dict_row, autocommit=True
    ) as conn:
        await verify_lab(conn, snapshot)

        async def search_variant(
            *, workspace_id, query, file_ids=None, top_k=None, stats=None
        ):
            assert workspace_id == ws
            started = time.perf_counter()
            vectors = await models.embed([models.format_query(query, spec)], spec=spec)
            embedded = time.perf_counter()
            terms = search_query_terms(query)
            rows = await store.hybrid_search(
                workspace_id=ws,
                vector=vectors[0],
                terms=terms,
                file_ids=file_ids,
                candidates=40,
                pin=snapshot["pin"],
                conn=conn,
            )
            top = search._cap_per_file([search.Passage.from_row(r) for r in rows], 4)[
                :5
            ]
            search._mark_tier_only(top, rows, 5)
            if stats is not None:
                stats.hits_lang = top[0].lang if top else "und"
                stats.query_terms, stats.cjk_runs = terms.terms, terms.cjk_runs
                stats.embed_ms, stats.sql_ms = (
                    round((embedded - started) * 1000),
                    round((time.perf_counter() - embedded) * 1000),
                )
            searches.append(
                {
                    "query": query,
                    "file_ids": file_ids,
                    "candidates": rows,
                    "shown": [p.chunk_id for p in top],
                }
            )
            return top

        tools.search = search_variant
        runs = schedule(fixture["cases"])
        if preflight:
            runs = [(fixture["cases"][2], 0, "baseline")]
        for case, repeat, arm in runs:
            folder = (
                OUT
                / ("preflight" if preflight else "runs")
                / f"repeat-{repeat}"
                / case["id"]
                / arm
            )
            if (folder / "result.json").exists():
                continue
            searches.clear()
            config = playground.load_config("chat")
            config.update(
                target="lab",
                workspace_id=ws,
                curate=False,
                locale=case["language"],
                scope_file_ids=[ws + "_" + s for s in case["scope_source_ids"]]
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
                "read_document",
                "capture_page",
            ]
            config["answer"]["citations"] = "as_is"
            turn = playground.Turn(config, case["question"], [], resolver)
            turn.run_dir = turn.state["run_dir"] = folder
            folder.mkdir(parents=True, exist_ok=True)
            started, final, errors = time.perf_counter(), {}, []
            with (folder / "events.jsonl").open("w") as stream:
                async with asyncio.timeout(600):
                    async for event in turn.events():
                        if event.get("type") == "block_delta":
                            continue
                        stream.write(
                            json.dumps(event, ensure_ascii=False, default=str) + "\n"
                        )
                        if event.get("type") == "done":
                            final = event
                        if event.get("type") == "error":
                            errors.append(event)
            record = read(folder / "run.json")
            result = {
                "id": case["id"],
                "arm": arm,
                "repeat": repeat,
                "elapsed_seconds": time.perf_counter() - started,
                "final": final,
                "errors": errors,
                "searches": searches,
                "answer_text": openui.text_of(record["answer"]),
                "listed": [
                    {"text": c["text_sent_to_model"], "truncated": c["truncated"]}
                    for c in record["calls"]
                    if c["name"] == "list_sources"
                ],
            }
            save(folder / "result.json", result)
            print(
                json.dumps(
                    {
                        "id": case["id"],
                        "arm": arm,
                        "repeat": repeat,
                        "seconds": round(result["elapsed_seconds"], 1),
                        "stop": record["telemetry"]["stopReason"],
                        "tools": record["telemetry"]["toolCallsByName"],
                        "tokens": record["usage"]["inputTokens"]
                        + record["usage"]["outputTokens"],
                    }
                ),
                flush=True,
            )
        await verify_lab(conn, snapshot)
    assert all(sha(RUNTIME / p) == h for p, h in manifest.items())
    assert hashes == {
        "runner": sha(Path(__file__)),
        "fixture": sha(FIXTURE),
        "snapshot": sha(LOCAL / "snapshot.json"),
        "runtime_manifest": sha(LOCAL / "runtime-manifest.json"),
    }
    save(
        OUT
        / ("preflight-verification.json" if preflight else "postrun-verification.json"),
        {
            "runtime_unchanged": True,
            "lab_matches_snapshot": True,
            "read_only": True,
            "inputs_unchanged": True,
            "unix": time.time(),
        },
    )


def check():
    cases = read(FIXTURE)["cases"]
    plan = schedule(cases)
    assert len(plan) == 20
    assert sum(c["id"] == cases[0]["id"] for c, _, _ in plan) == 6
    assert all(
        sum(arm == a for _, _, arm in plan) == 10 for a in ("baseline", "opening")
    )
    assert cases[4]["scope_source_ids"] == ["rag__es__sesgo-linguistico-digital"]
    print("Schedule and scoped-exclusion control passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "check", "preflight", "run"))
    args = parser.parse_args()
    if args.mode == "prepare":
        prepare()
    elif args.mode == "check":
        check()
    else:
        asyncio.run(run(args.mode == "preflight"))
