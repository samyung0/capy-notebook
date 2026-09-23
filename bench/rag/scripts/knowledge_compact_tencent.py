"""Compare five hit passages with twenty compact previews through Tencent curate.

Both arms keep the saved system/tool prompts and current agent mechanisms.
Shared library/source access is read-only; generated materials stay local.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import dataclasses
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "lab/playground/scripts"), str(ROOT / "pipeline")]
CASES = [
    {
        "id": "enzyme-inhibition",
        "query": "For an introductory college biology student, create a broad study note and six challenging single-answer multiple-choice questions comparing competitive and noncompetitive enzyme inhibition, including what increasing substrate concentration changes. Explain each answer. Use the library's supported level of detail.",
    },
    {
        "id": "population-growth",
        "query": "For introductory college ecology, create one concise study note and four application-level single-answer multiple-choice questions on exponential versus logistic population growth, carrying capacity and density dependence. Explain each answer and keep the quiz within the evidence you read.",
    },
    {
        "id": "binomial-worked-example",
        "query": "For a first-year college statistics student working by hand, create one note explaining when a binomial probability model applies and work through one numerical example actually present in a library source. Preserve that example's original givens and show the probability calculation. Do not substitute software instructions.",
    },
    {
        "id": "scipy-odr-jacobians",
        "query": "For a graduate engineering student, create one practical guide to scipy.odr for nonlinear fitting with measurement errors in both x and y, including how to supply analytic Jacobians through fjacb and fjacd. Use library sources that actually cover those APIs. If the library lacks that coverage, explain the gap and do not substitute a generic regression guide.",
    },
]


def save(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def schedule() -> list[dict]:
    return [
        {"case": case["id"], "arm": arm}
        for i, case in enumerate(CASES)
        for arm in (("current", "compact") if i % 2 == 0 else ("compact", "current"))
    ]


def pack(blocks: list[str]) -> list[str]:
    from pipeline.retrieval.chunking import estimate_tokens

    result = []
    for block in blocks:
        if estimate_tokens("\n\n".join([*result, block])) > 7000:
            break
        result.append(block)
    return result


def configure() -> None:
    from common import env_file, worker_env
    from knowledge_agentic_breadth import configure as reader_environment

    reader_environment(b2_account=True)
    local = env_file(ROOT / ".env.local")
    key = os.environ.get("TENCENT_API_KEY") or local.get("TENCENT_API_KEY")
    if not key:
        key = worker_env().get("TENCENT_API_KEY")
    if not key:
        raise RuntimeError("Configured Tencent credential is unavailable")
    os.environ["TENCENT_API_KEY"] = key


async def run(output: Path) -> None:
    import playground
    from common import PdfResolver
    from knowledge_agentic_breadth import snapshot
    from knowledge_base_pilot import embedding_spec
    from knowledge_compact_agent import preview
    from psycopg import AsyncConnection, sql
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    from pipeline import registry
    from pipeline.config import cfg
    from pipeline.elitellm import client
    from pipeline.prompts import curate
    from pipeline.retrieval import library, pending, tools
    from pipeline.retrieval.chunking import estimate_tokens

    protocol = json.loads((output / "protocol.json").read_text())
    for relative, expected in protocol["runtime_hashes"].items():
        assert hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() == expected
    base = playground.load_config("curate")
    assert base["curate"] and base["model"]["thinking"] == "high"
    assert playground.effective_prompt(base) == curate.system_prompt("en")
    assert base["tool_descriptions"] == {} and base["prompt_addon"] == ""
    assert "tokenhub" in base["model"]["transport"]["url"]
    base.update(target="local", workspace_id="knowledge-compact-tencent", ledger=None)
    base["model"]["adhoc"] = {
        "context_window_tokens": 200000,
        "thinking_levels": ["high"],
        "params": {"temperature": 0},
    }
    save(output / "config.json", base)
    embed = embedding_spec()
    registry.registry._by_pin[embed.pin] = embed
    playground.LOCAL = output
    cfg.capture_cache_dir = str(output / "pdf-cache")

    async def empty_workspace(*_args, **_kwargs):
        return pending.PendingSources()

    pending.load = empty_workspace
    original_write = playground.create_material_locally

    async def nonempty_note(args, ctx, state, message_id):
        if args.get("kind") == "note" and not str(args.get("content") or "").strip():
            prepared = await tools.curate_write(ctx, "create_material", args)
            if isinstance(prepared, tools.ToolResult):
                return prepared
            return tools._refused("The material has no content.")
        return await original_write(args, ctx, state, message_id)

    playground.create_material_locally = nonempty_note
    db = AsyncConnectionPool(
        cfg.library_dsn,
        min_size=1,
        max_size=4,
        open=False,
        kwargs={
            "row_factory": dict_row,
            "connect_timeout": 5,
            "options": "-c default_transaction_read_only=on -c statement_timeout=30000",
        },
    )
    await db.open()
    keeper = await AsyncConnection.connect(
        cfg.library_dsn,
        row_factory=dict_row,
        options="-c default_transaction_read_only=on -c statement_timeout=30000",
    )
    await keeper.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
    snapshot_row = await (
        await keeper.execute("SELECT pg_export_snapshot() AS id")
    ).fetchone()
    snapshot_id = snapshot_row["id"]
    save(output / "snapshot.json", {"id": snapshot_id, "read_only": True})
    original_connection = db.connection

    @asynccontextmanager
    async def frozen_connection():
        async with original_connection() as conn:
            await conn.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
            )
            await conn.execute(
                sql.SQL("SET TRANSACTION SNAPSHOT {}").format(sql.Literal(snapshot_id))
            )
            yield conn

    db.connection = frozen_connection
    library._pool = db
    original_search = library.search
    original_handler = tools._search_knowledge
    original_sse = client._stream_sse
    results = []
    try:
        for item in protocol["runs"]:
            case = next(c for c in CASES if c["id"] == item["case"])
            folder = output / "runs" / item["case"] / item["arm"]
            if folder.exists():
                raise RuntimeError("Refusing to overwrite a previous turn")
            folder.mkdir(parents=True)
            before = await snapshot(db)
            save(folder / "library-before.json", before)
            compact = item["arm"] == "compact"
            config = copy.deepcopy(base)
            config["search"]["top_k"] = 20 if compact else 5
            cfg.search_candidates = 160 if compact else 40
            searches, previews = [], []
            provider_count = 0

            async def tracked_search(
                query, *, _searches=searches, _folder=folder, **kwargs
            ):
                found = await original_search(query, **kwargs)
                _searches.append(
                    {
                        "query": query,
                        "filters": kwargs,
                        "excerpts": [dataclasses.asdict(e) for e in found.excerpts],
                    }
                )
                save(_folder / "searches.json", _searches)
                return found

            async def compact_search(args, ctx, *, _previews=previews, _folder=folder):
                query = str(args.get("query") or "").strip()
                if not query:
                    return tools._refused("search_knowledge needs a query.")
                topics, roles = tools._facets(args)
                unknown = await tools._unknown_topics(ctx, topics)
                if unknown:
                    return tools._refused(
                        f"Unknown topic ids {unknown}. Browse a subject first."
                    )
                if ctx.budget is not None:
                    ctx.budget.embedding_calls += 1
                try:
                    found = await library.search(query, topics=topics, roles=roles)
                except ValueError as exc:
                    return tools._refused(f"search_knowledge: {exc}")
                if not found.excerpts:
                    return tools._result(
                        tools._no_excerpts(topics, roles, found.available_roles)
                    )
                blocks = pack([preview(e) for e in found.excerpts])
                text = (
                    f"{len(blocks)} of {len(found.excerpts)} ranked excerpt previews shown. "
                    "Read selected excerpts before writing; previews are selection aids.\n\n"
                    + "\n\n".join(blocks)
                )
                _previews.append(
                    {
                        "query": query,
                        "ids": [e.id for e in found.excerpts[: len(blocks)]],
                        "ranked": len(found.excerpts),
                        "estimated_tokens": estimate_tokens(text),
                    }
                )
                save(_folder / "previews.json", _previews)
                return tools._result(text)

            async def recorded_sse(url, headers, body, *, _folder=folder):
                nonlocal provider_count
                provider_count += 1
                path = _folder / "provider" / f"{provider_count:03d}"
                save(path / "request.json", body)
                # Headers contain credentials and are deliberately never persisted.
                with (path / "response.jsonl").open("w") as stream:
                    async for event in original_sse(url, headers, body):
                        stream.write(json.dumps(event, ensure_ascii=False) + "\n")
                        stream.flush()
                        yield event

            library.search = tracked_search
            tools._register(
                "search_knowledge", compact_search if compact else original_handler
            )
            client._stream_sse = recorded_sse
            turn = playground.Turn(config, case["query"], [], PdfResolver("local"))
            turn.run_dir = folder
            turn.state["run_dir"] = folder
            print(json.dumps({"starting": item}), flush=True)
            with (folder / "events.jsonl").open("w") as stream:
                async with asyncio.timeout(900):
                    async for event in turn.events():
                        if event.get("type") != "block_delta":
                            stream.write(json.dumps(event, ensure_ascii=False) + "\n")
                            stream.flush()
                        if event.get("type") in {"error", "run_saved"}:
                            print(json.dumps({**item, **event}), flush=True)
            after = await snapshot(db)
            save(folder / "library-after.json", after)
            run_record = json.loads((folder / "run.json").read_text())
            assert run_record["system_prompt"] == playground.effective_prompt(base)
            calls = run_record["provider_calls"]
            record = {
                **item,
                "stable_library": before == after,
                "prompt_hash": digest(run_record["system_prompt"]),
                "schemas_hash": digest(run_record["tool_schemas"]),
                "tools": dict(Counter(c["name"] for c in run_record["calls"])),
                "refusals": sum(
                    c["outcome"] != "succeeded" for c in run_record["calls"]
                ),
                "materials": len(run_record["materials"]),
                "elapsed_seconds": run_record["elapsed_seconds"],
                **{
                    key: sum(c[key] for c in calls)
                    for key in ("input_tokens", "output_tokens", "cached_read_tokens")
                },
                "errors": [e for e in run_record["events"] if e["type"] == "error"],
            }
            results.append(record)
            save(output / "summary.json", results)
            print(json.dumps(record), flush=True)
            if record["errors"] or not record["stable_library"]:
                raise RuntimeError(
                    "Turn failed or library changed; retained receipts for inspection"
                )
            if len(results) % 2 == 0:
                left, right = results[-2:]
                assert left["prompt_hash"] == right["prompt_hash"]
                assert left["schemas_hash"] == right["schemas_hash"]
                prior_after = json.loads(
                    (
                        output
                        / "runs"
                        / left["case"]
                        / left["arm"]
                        / "library-after.json"
                    ).read_text()
                )
                if prior_after != before:
                    raise RuntimeError(
                        "Library changed between arms; pair is not comparable"
                    )
    finally:
        library.search = original_search
        tools._register("search_knowledge", original_handler)
        client._stream_sse = original_sse
        await library.close_pool()
        await keeper.rollback()
        await keeper.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run-frozen", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        from pipeline.retrieval.chunking import estimate_tokens

        assert len(schedule()) == 8
        assert pack(["short"] * 20) == ["short"] * 20
        packed = pack(["example " * 500] * 20)
        assert 0 < len(packed) < 20
        assert estimate_tokens("\n\n".join(packed)) <= 7000
        print("Schedule and whole-preview packing checks passed")
        return
    if args.output is None:
        parser.error("Supply --output with a fresh local directory")
    output = args.output.resolve()
    if args.run_frozen:
        configure()
        asyncio.run(run(output))
        return
    if output.exists():
        raise RuntimeError("Use a new output directory")
    from knowledge_compact_agent import freeze

    hashes = freeze(output)
    save(
        output / "protocol.json",
        {
            "runs": schedule(),
            "cases": CASES,
            "runtime_hashes": hashes,
            "provider": "Tencent TokenHub",
            "model": "glm-5.3-flash",
            "thinking": "high",
            "temperature": 0,
            "current": {
                "top_k": 5,
                "candidates": 40,
                "format": "hit text and reviewed scope",
            },
            "compact": {
                "top_k": 20,
                "candidates": 160,
                "format": "compact scope/synopsis preview",
                "preview_budget": 7000,
            },
            "held_constant": "Saved system and tool prompts, ledger, retention, caps, capture availability, full reads, local writer",
            "primary": "Supported requested materials or an honest request-level gap; inspect quiz keys and numerical examples against actual reads",
            "limits": "Four new diagnostic requests, no repeated or population-level reliability claim; wider pool and compact rendering are one candidate; all reads share one read-only MVCC snapshot while the builder continues",
        },
    )
    script = output / "runtime/bench/rag/scripts/knowledge_compact_tencent.py"
    configure()
    subprocess.run(
        [sys.executable, str(script), "--run-frozen", "--output", str(output)],
        check=True,
    )


if __name__ == "__main__":
    main()
