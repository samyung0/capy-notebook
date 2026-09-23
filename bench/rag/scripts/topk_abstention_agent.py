"""Chat agent with an abstaining search_workspace over the lab workspace.

Runs the production chat loop in-process through the playground's Turn, with
local Ollama GLM-5.3-Flash as the model, and swaps search_workspace for a
variant that applies one cut rule to the fused candidates before the model
sees them: `baseline` shows the usual capped top five; `abstain` returns no
passage when the best vector distance is above a ceiling and no candidate is
an exact-tier lexical match. Answers and every search are saved for reading;
grading is manual.

    uv run --project pipeline python bench/rag/scripts/topk_abstention_agent.py --arm baseline
    uv run --project pipeline python bench/rag/scripts/topk_abstention_agent.py --arm abstain --ceiling 0.55

Needs the lab database container running and Ollama serving glm-5.3-flash:cloud.
Output: bench/rag/reports/local/2026-09-21-topk-abstention/agent/<arm>/ (ignored).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "bench/rag/fixtures"
OUT = ROOT / "bench/rag/reports/local/2026-09-21-topk-abstention/agent"
WORKSPACE = "odl_eval_odl_nocaption"
OLLAMA = "http://127.0.0.1:11434/v1/chat/completions"
MODEL = "glm-5.3-flash:cloud"
ABSTAIN_TEXT = (
    "No passage in the workspace is close to this query. The sources do not "
    "appear to cover it; say so rather than searching again with other wording."
)


def questions() -> list[dict]:
    items = []
    for i, q in enumerate(json.loads((FIXTURES / "questions-irrelevant.json").read_text(encoding="utf-8"))):
        items.append({"id": f"irr-{i:02d}", "set": "no-answer", "query": q["q"], "expect": []})
    for i, q in enumerate(json.loads((FIXTURES / "questions.json").read_text(encoding="utf-8"))[:6]):
        items.append({"id": f"pos-{i:02d}", "set": "answerable", "query": q["q"], "expect": q["expect"]})
    return items


def setup() -> None:
    sys.path[:0] = [str(ROOT / "lab/playground/scripts"), str(ROOT / "pipeline")]
    from common import prepare_environment

    prepare_environment("lab")
    os.environ.update(
        GATEWAY_URL="http://127.0.0.1:1",
        PIPELINE_SECRET="local-benchmark-only",
        OLLAMA_BENCH_KEY="ollama",
        SENTRY_DSN="",
        CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S="180",
    )


async def run_arm(arm: str, ceiling: float, only: set[str] | None) -> None:
    import playground
    from common import PdfResolver
    from pipeline import registry
    from pipeline.retrieval import models, pending, store, tools
    from pipeline.retrieval.chunking import search_query_terms
    from pipeline.retrieval.search import Passage, _cap_per_file
    from pipeline.config import cfg
    from topk_abstention_eval import all_term_hits

    async def empty_workspace(*args, **kwargs):
        return pending.PendingSources()

    pending.load = empty_workspace
    folder = OUT / arm
    folder.mkdir(parents=True, exist_ok=True)
    playground.LOCAL = folder
    db = await store.pool()
    pin = await store.workspace_embedding_pin(WORKSPACE)
    spec = registry.resolve_pinned(
        pin["embedding_provider_slug"], pin["embedding_model_slug"], pin["embedding_model_version"], registry.Slot.RETRIEVAL
    )
    searches: list[dict] = []

    async def search_variant(args, ctx):
        query = str(args.get("query") or "").strip()
        if not query:
            return tools._refused("search_workspace needs a query.")
        vectors = await models.embed([models.format_query(query, spec)], spec=spec)
        async with db.connection() as conn:
            rows = await store.hybrid_search(
                workspace_id=WORKSPACE,
                vector=vectors[0],
                terms=search_query_terms(query),
                file_ids=None,
                candidates=cfg.search_candidates,
                pin=pin,
                conn=conn,
            )
            lexical = await all_term_hits(conn, WORKSPACE, query) if arm == "abstain" else None
        passages = [Passage.from_row(r) for r in rows]
        best = min((p.vec_dist for p in passages if p.vec_dist is not None), default=None)
        exact = any(r["score"] != r["flat_score"] for r in rows)
        # Abstain only when the vector leg is far and no chunk holds every
        # query term: an identifier the corpus contains stays answerable even
        # when its embedding sits far from any passage.
        abstained = arm == "abstain" and (best is None or best > ceiling) and not exact and not lexical
        shown = [] if abstained else _cap_per_file(passages, cfg.search_per_file_cap)[: cfg.search_top_k]
        searches.append(
            {
                "query": query,
                "best_dist": best,
                "exact": exact,
                "abstained": abstained,
                "shown": [{"file": p.file_name, "chunk": p.chunk_idx, "dist": p.vec_dist} for p in shown],
            }
        )
        if not shown:
            return tools._result(ABSTAIN_TEXT if abstained else "No passages matched. Try different wording.")
        return tools.ToolResult(passages=shown)

    tools._register("search_workspace", search_variant)
    answers = folder / "answers.jsonl"
    done_ids = set()
    if answers.exists():
        done_ids = {json.loads(line)["id"] for line in answers.open(encoding="utf-8")}
    for item in questions():
        if item["id"] in done_ids or (only and item["id"] not in only):
            continue
        searches.clear()
        config = playground.load_config("chat")
        config.update(target="lab", workspace_id=WORKSPACE, curate=False, question=item["query"])
        config["model"].update(
            thinking="low",
            adhoc={"context_window_tokens": 200000, "thinking_levels": ["low"], "params": {"temperature": 0}},
            transport={"url": OLLAMA, "key_env": "OLLAMA_BENCH_KEY", "wire_model": MODEL, "body": "zai"},
        )
        config["tools"] = ["search_workspace", "read_document"]
        turn = playground.Turn(config, item["query"], [], PdfResolver("local"))
        case_dir = folder / item["id"]
        case_dir.mkdir(exist_ok=True)
        turn.run_dir = case_dir
        turn.state["run_dir"] = case_dir
        started = time.perf_counter()
        final: dict = {}
        with (case_dir / "events.jsonl").open("w", encoding="utf-8") as stream:
            try:
                async with asyncio.timeout(600):
                    async for event in turn.events():
                        if event.get("type") == "block_delta":
                            continue
                        stream.write(json.dumps(event, ensure_ascii=False) + "\n")
                        if event.get("type") == "done":
                            final = event
            except Exception as exc:  # noqa: BLE001 - record and continue with the next question
                final = {"error": f"{type(exc).__name__}: {exc}"}
        record = {
            **item,
            "arm": arm,
            "ceiling": ceiling if arm == "abstain" else None,
            "elapsed_s": round(time.perf_counter() - started, 1),
            "answer": final.get("answer", ""),
            "error": final.get("error"),
            "telemetry": final.get("telemetry"),
            "searches": list(searches),
        }
        with answers.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(
            f"{arm} {item['id']} {record['elapsed_s']}s searches={len(searches)} "
            f"abstained={sum(s['abstained'] for s in searches)} answer={record['answer'][:90]!r}",
            flush=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--arm", choices=("baseline", "abstain"), required=True)
    parser.add_argument("--ceiling", type=float, default=0.55)
    parser.add_argument("--only", help="comma-separated question ids")
    args = parser.parse_args()
    setup()
    only = set(args.only.split(",")) if args.only else None
    asyncio.run(run_arm(args.arm, args.ceiling, only))


if __name__ == "__main__":
    main()
