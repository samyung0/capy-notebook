"""Test compact discovery, text-only curate and prompt-steered finishing together.

Uses an immutable local copy of the current runtime, the library reader role,
Ollama GLM and the existing playground writer. No application defaults change.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "lab/playground/scripts"), str(ROOT / "pipeline")]
CASES = (
    "distinct-regression-examples",
    "regression-by-hand",
    "paired-t-test",
    "regression-r",
    "mean-median",
    "quantum-surface-codes",
    "leadership-general",
    "athenian-democracy",
)
REPEATS = ("distinct-regression-examples", "paired-t-test")


def save(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def schedule() -> list[dict]:
    runs = []
    for repeat, cases in ((1, CASES), (2, REPEATS)):
        for index, case in enumerate(cases):
            arms = ("current", "compact")
            if (index + repeat) % 2 == 0:
                arms = tuple(reversed(arms))
            runs.extend({"case": case, "arm": arm, "repeat": repeat} for arm in arms)
    return runs


def freeze(output: Path) -> dict[str, str]:
    """Copy only executable inputs/data; never copy environment files or secrets."""
    paths = set()
    for directory in ("pipeline/pipeline", "lab/playground/scripts"):
        paths.update(
            p.relative_to(ROOT)
            for p in (ROOT / directory).rglob("*")
            if p.is_file()
            and "__pycache__" not in p.parts
            and p.suffix in {".py", ".json", ".txt"}
        )
    paths.update(p.relative_to(ROOT) for p in (ROOT / "bench/rag/scripts").glob("*.py"))
    paths.update(
        Path(p)
        for p in (
            "bench/rag/fixtures/knowledge-scope-cases.json",
            "lab/playground/configs/curate.json",
            "server/internal/models/elitellm_providers.json",
        )
        if (ROOT / p).exists()
    )
    hashes = {
        str(p): hashlib.sha256((ROOT / p).read_bytes()).hexdigest()
        for p in sorted(paths)
    }
    for relative in paths:
        target = output / "runtime" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, target)
    for relative, digest in hashes.items():
        assert hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() == digest
        assert (
            hashlib.sha256((output / "runtime" / relative).read_bytes()).hexdigest()
            == digest
        )
    return hashes


def candidate_prompt(original: str) -> str:
    lines = original.splitlines()
    capture = [
        line for line in lines if line.startswith("- Before using source-specific")
    ]
    assert len(capture) == 1, "Review the changed curate capture instruction"
    result = []
    for line in lines:
        if line == capture[0]:
            line = (
                "- Use the library's reviewed source text as evidence. Page-capture tools "
                "are not available in this configuration. If an essential diagram, formula "
                "or value is missing or unresolved in the text, state that limitation; "
                "do not reconstruct it from general knowledge. Check your example's labels, "
                "units, variables and numbers against the passages you read before writing."
            )
        elif line.startswith("3. Read with read_knowledge"):
            line = (
                "3. Select the few excerpts needed for one material from the compact search "
                "previews, then read them and their necessary context with read_knowledge. "
                "Previews help choose sources; they are not sufficient evidence for writing."
            )
        elif line.startswith("Budget:"):
            line = (
                "Budget: at most 6 tool calls in one response. A fourth consecutive response "
                "that completes no todo ends the turn. Plan a short search-read-write cycle: "
                "search once, batch the selected reads, then write as soon as one material "
                "has enough evidence. Finish the reads before writing. Create todos only "
                "for deliverable materials or sections, never for research activities. "
                "Search again only for a specific missing requirement; do not keep exploring "
                "when the available excerpts already cover the request. Before the budget "
                "runs out, save a supported material with its scope or limitations stated. "
                "If the requested material cannot be supported, explain the actual evidence "
                "gap and stop. Never fill a gap just to complete a todo."
            )
        result.append(line)
    return "\n".join(result)


def preview(excerpt) -> str:
    from pipeline.retrieval import tools
    from pipeline.retrieval.chunking import clip_to_tokens

    parts = [tools._excerpt_head(excerpt), tools._excerpt_facets(excerpt)]
    if excerpt.retrieval is not None:
        parts.append(tools._excerpt_scope(excerpt))
    else:
        parts.append("Scope not reviewed. Read the source to check applicability.")
        if excerpt.synopsis:
            parts.append("Synopsis preview: " + clip_to_tokens(excerpt.synopsis, 120))
    return "\n".join(parts)


def check() -> None:
    from types import SimpleNamespace

    from pipeline.prompts import curate

    runs = schedule()
    assert len(runs) == 20 and len({tuple(r.values()) for r in runs}) == 20
    prompt = candidate_prompt(curate.SYSTEM_PROMPT)
    assert "capture_knowledge_page" not in prompt and "capture_page" not in prompt
    assert "fourth consecutive response" in prompt and "deliverable materials" in prompt
    excerpt = SimpleNamespace(
        id="x",
        book_title="Book",
        section_path="Section",
        pages=[1],
        roles=["formal"],
        topic_ids=["topic"],
        figure_ids=[],
        retrieval={
            "summary": "Teaches a method",
            "scope": "Specific dataset",
            "context_excerpt_ids": [],
        },
        synopsis="Long notes " * 100,
        hit_text="SOURCE BODY MUST NOT APPEAR",
    )
    assert "Specific dataset" in preview(excerpt)
    assert "SOURCE BODY" not in preview(excerpt) and "Long notes" not in preview(
        excerpt
    )
    excerpt.retrieval = None
    assert "Scope not reviewed" in preview(excerpt) and "Synopsis preview" in preview(
        excerpt
    )
    assert len(preview(excerpt)) < 800
    print(
        "20 balanced turns; compact previews, missing-scope preview and prompt checks passed."
    )


async def run(args) -> None:
    import knowledge_agentic_breadth as receipts
    import knowledge_scope_agent_eval as existing
    import playground
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool

    from pipeline.config import cfg
    from pipeline.prompts import curate
    from pipeline.retrieval import library, store, tools
    from pipeline.retrieval.chunking import estimate_tokens

    record = args.output / args.arm / f"repeat-{args.repeat}" / args.case / "baseline"
    if (record / "run.json").exists():
        raise RuntimeError("Refusing to overwrite a completed turn")
    protocol = json.loads((args.output / "protocol.json").read_text())
    for relative, digest in protocol["runtime_hashes"].items():
        assert hashlib.sha256((ROOT / relative).read_bytes()).hexdigest() == digest
    db = AsyncConnectionPool(
        cfg.library_dsn,
        min_size=1,
        max_size=4,
        open=False,
        timeout=10,
        kwargs={
            "row_factory": dict_row,
            "connect_timeout": 5,
            "options": "-c default_transaction_read_only=on -c statement_timeout=30000",
        },
    )
    await db.open()
    library._pool = db
    before = await receipts.snapshot(db)
    save(record / "freeze-before.json", before)
    original_search = store.hybrid_search
    candidates = []

    async def tracked_candidates(**kwargs):
        rows = await original_search(**kwargs)
        candidates.append({"candidate_budget": kwargs["candidates"], "rows": rows})
        save(record / "candidates.json", candidates)
        return rows

    store.hybrid_search = tracked_candidates
    compact = args.arm == "compact"
    existing.PAGE_SIZE = 20 if compact else 5
    cfg.search_candidates = 160 if compact else 40
    rendered = []
    if compact:
        original_turn = playground.Turn

        def variant_turn(config, *positional, **kwargs):
            config["tools"] = [
                name
                for name in config["tools"]
                if name not in {"capture_page", "capture_knowledge_page"}
            ]
            config["system_prompt"] = candidate_prompt(
                curate.system_prompt(config["locale"])
            )
            return original_turn(config, *positional, **kwargs)

        playground.Turn = variant_turn
        curate.TOOL_DESCRIPTIONS["search_knowledge"] = (
            "Search textbook content and metadata, returning up to 20 compact excerpt previews. "
            "Each preview includes its source, teaching role, topics and reviewed summary/scope "
            "when available. A legacy synopsis preview is marked when scope is unreviewed. "
            "Choose only the excerpts needed for the request and read them with read_knowledge "
            "before writing. topics optionally uses known IDs from browse_knowledge; omit it "
            "for a direct search. roles selects introduction, formal, worked_example, exercise, "
            "summary or reference. Search again only for a concrete remaining evidence gap."
        )

        async def compact_search(args, ctx):
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
            result = await library.search(query, topics=topics, roles=roles)
            if not result.excerpts:
                return tools._result(
                    tools._no_excerpts(topics, roles, result.available_roles)
                )
            blocks, ids = [], []
            for excerpt in result.excerpts:
                block = preview(excerpt)
                if estimate_tokens("\n\n".join([*blocks, block])) > 7000:
                    break
                blocks.append(block)
                ids.append(excerpt.id)
            text = (
                f"{len(ids)} of {len(result.excerpts)} ranked excerpt previews shown. "
                "Read selected excerpts before writing; previews are selection aids.\n\n"
                + "\n\n".join(blocks)
            )
            rendered.append(
                {
                    "query": query,
                    "ids": ids,
                    "ranked": len(result.excerpts),
                    "estimated_tokens": estimate_tokens(text),
                }
            )
            save(record / "previews.json", rendered)
            return tools._result(text)

        tools._register("search_knowledge", compact_search)
    cases = json.loads(existing.CASES.read_text())["cases"]
    case = next(case for case in cases if case["id"] == args.case)
    await existing.experiment(
        case, "baseline", args.output / args.arm / f"repeat-{args.repeat}", "low"
    )
    db = AsyncConnectionPool(
        cfg.library_dsn,
        min_size=1,
        max_size=1,
        open=False,
        kwargs={
            "row_factory": dict_row,
            "connect_timeout": 5,
            "options": "-c default_transaction_read_only=on -c statement_timeout=30000",
        },
    )
    async with db:
        after = await receipts.snapshot(db)
    save(record / "freeze-after.json", after)
    save(
        record / "comparison.json",
        {"arm": args.arm, "repeat": args.repeat, "stable_library": before == after},
    )
    if before != after:
        raise RuntimeError(
            "Library changed during the turn; preserve it separately and rerun a fresh pair"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--suite", action="store_true")
    parser.add_argument("--case", choices=CASES)
    parser.add_argument("--arm", choices=("current", "compact"))
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.output or (not args.suite and not (args.case and args.arm)):
        parser.error("Supply --output and --suite, or --case plus --arm")
    args.output = args.output.resolve()
    import knowledge_agentic_breadth as receipts

    if args.suite:
        if args.output.exists():
            raise RuntimeError("Use a new output directory")
        hashes = freeze(args.output)
        save(
            args.output / "protocol.json",
            {
                "runs": schedule(),
                "runtime_hashes": hashes,
                "model": "glm-5.3-flash:cloud",
                "thinking": "low",
                "temperature": 0,
                "current": {
                    "top_k": 5,
                    "candidates": 40,
                    "capture": True,
                    "prompt": "current",
                },
                "compact": {
                    "top_k": 20,
                    "candidates": 160,
                    "capture": False,
                    "prompt": "bounded finish",
                    "preview_token_budget": 7000,
                    "legacy_synopsis_tokens": 120,
                },
                "held_constant": "Existing ledger, stall guard, 8192 tool cap, full source reads and local material writer",
                "primary": "Completed source-supported material or an honest request-level coverage gap; no mandatory capture-compliance metric",
                "limits": "Diagnostic combined-package test; not a separate attribution of each change; no reranker or dedup",
            },
        )
        receipts.configure(b2_account=True)
        script = args.output / "runtime/bench/rag/scripts/knowledge_compact_agent.py"
        for item in schedule():
            print(json.dumps({"starting": item}), flush=True)
            command = [
                sys.executable,
                str(script),
                "--output",
                str(args.output),
                "--case",
                item["case"],
                "--arm",
                item["arm"],
                "--repeat",
                str(item["repeat"]),
            ]
            subprocess.run(command, check=True)
    else:
        receipts.configure()
        asyncio.run(run(args))


if __name__ == "__main__":
    main()
