"""Part 2 of the pending-hints eval: GLM and DeepSeek through the real agent loop.

Each job is one chat turn through lab/playground's Turn, which runs the
production agent (pipeline.retrieval.agent) in process with the playground's
patches, against the scratch database hints_eval_db.py loaded. This script
adds four patches of its own for the turn:
- pending.load returns the fixture's pending changes (Go's note changes and
  the files' effects, as hints_eval_fixture builds them);
- inspect_document reads the fixture's current documents (the playground has
  no gateway; read_document and search are production's, on the database);
- the condition: none (no message hints and no search tail: effects on read
  only), tail (search tail only), real (production), junkN (production's
  shown hints plus N real pending changes from unrelated documents, inserted
  at seeded positions, the 400-token cap lifted so all show);
- message() records which hints were shown.

  uv run python bench/rag/scripts/hints_eval_agent.py plan --out <dir> --repeats 2
  uv run python bench/rag/scripts/hints_eval_agent.py launch --out <dir> --dsn <dsn> --workers glm=4,deepseek=4
  uv run python bench/rag/scripts/hints_eval_agent.py score --out <dir>

GLM-5.3-Flash goes to Z.AI on production's route (ZAI_API_KEY). DeepSeek
Flash goes to DeepInfra's deepseek-ai/DeepSeek-V4.1-Flash through the
playground's transport override (DEEPINFRA_API_KEY), with production's
deepseek request body. Keys are read from the repository-root .env.local into
the worker processes only. Workers stop once the results' total cost passes
--spend-cap.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import re
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
PLAYGROUND = REPO / "lab" / "playground" / "scripts"
QUESTIONS = HERE.parents[0] / "fixtures" / "hints-eval" / "questions.json"
WORKSPACE = "ws_hints_eval"
CONDITIONS = ("none", "tail", "real", "junk1", "junk3", "junk5", "strict", "strict-name", "junk3-wording", "flag")
# junk3-wording: the hint heading the report proposes, over three junk hints.
WORDING = (
    "Unindexed edits that share words with the user's message above (a word "
    "match only: most are unrelated; not in search yet). Use one only if it "
    "bears on the question, and read its document before relying on it."
)

# USD per token. GLM: Z.AI list price (human/agentic-retrieval.md 2026-10-20).
# DeepSeek: DeepInfra's list price before its 30% discount, cache reads at the
# full rate, so the spend check over-counts.
MODELS: dict[str, dict[str, Any]] = {
    "glm": {
        "provider_slug": "zai",
        "model_slug": "glm-5.3-flash",
        "thinking": "high",
        "transport": None,
        "price": {"input": 0.15e-6, "cached": 0.03e-6, "output": 0.50e-6},
    },
    "deepseek": {
        "provider_slug": "deepseek",
        "model_slug": "deepseek-flash",
        "thinking": "high",
        "transport": {
            "url": "https://api.deepinfra.com/v1/openai/chat/completions",
            "key_env": "DEEPINFRA_API_KEY",
            "wire_model": "deepseek-ai/DeepSeek-V4.1-Flash",
            "body": "deepseek",
        },
        "price": {"input": 0.20e-6, "cached": 0.20e-6, "output": 0.60e-6},
    },
}
SEARCH_COST = 0.0001  # query embedding plus rerank of one search, generous
READ_TOOLS = ("read_document", "inspect_document")


def questions() -> dict[str, Any]:
    return json.loads(QUESTIONS.read_text(encoding="utf-8"))


# ------------------------------------------------------------------ plan


def plan(args) -> None:
    """Jobs with their junk: real pending changes of documents off the
    question's subject, not among its real hints, seeded per question, the
    same for both models; junk1 within junk3 within junk5."""
    prepare(args.dsn, args.env_file, keys=())
    import hints_eval_fixture as fx

    from pipeline import use_compatible_event_loop
    from pipeline.retrieval import pending_hints, store

    use_compatible_event_loop()
    docs = fx.load()
    owner = fx.change_doc(docs)
    qs = questions()["questions"]

    async def real_hints() -> dict[str, list[str]]:
        out = {}
        try:
            for q in qs:
                sources = fx.pending_sources(docs)
                sources.read_ids = set()
                hints = await pending_hints.for_message(q["text"], sources, skip=set())
                message = pending_hints.message(hints)
                out[q["id"]] = [h.change_id for h, _ in message["_hints"]] if message else []
        finally:
            await store.close_pool()
        return out

    real = asyncio.run(real_hints())
    jobs = []
    junk_of: dict[str, dict[str, Any]] = {}
    for q in qs:
        banned = set(q["not_junk"]) | set(q["gold_docs"])
        pool = [
            c["id"]
            for d in docs
            for c in d.changes
            if d.id not in banned
            and c["id"] not in banned
            and c["id"] not in real[q["id"]]
            and len(c.get("after") or c.get("before") or "") >= 20
        ]
        rng = random.Random(f"junk-{q['id']}")
        rng.shuffle(pool)
        # One junk change per document first, so junk5 spans documents.
        picked, seen = [], set()
        for change in pool:
            if owner[change].id not in seen:
                picked.append(change)
                seen.add(owner[change].id)
        picked += [c for c in pool if c not in picked]
        junk = picked[:5]
        positions = {}
        for n in (1, 3, 5):
            prng = random.Random(f"pos-{q['id']}-{n}")
            size = len(real[q["id"]])
            slots = []
            for _ in range(n):
                slots.append(prng.randint(0, size))
                size += 1
            positions[n] = slots
        junk_of[q["id"]] = {"real": real[q["id"]], "junk": junk, "positions": positions}
        for model in args.models.split(","):
            for condition in args.conditions.split(","):
                for repeat in range(1, args.repeats + 1):
                    n = int(condition[4:5]) if condition.startswith("junk") else 0
                    jobs.append(
                        {
                            "id": f"{q['id']}-{model}-{condition}-r{repeat}",
                            "question": q["id"],
                            "model": model,
                            "condition": condition,
                            "repeat": repeat,
                            "junk": junk[:n],
                            "positions": positions.get(n, []),
                        }
                    )
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "plan.json").write_text(
        json.dumps({"hints": junk_of, "jobs": jobs}, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"{len(jobs)} jobs; real hints per question:")
    for qid, item in junk_of.items():
        print(f"  {qid}: real {item['real']} junk {item['junk']}")


# ------------------------------------------------------------------- run


def prepare(dsn: str, env_file: Path, keys: tuple[str, ...]) -> None:
    """Environment before pipeline imports: the database, and provider keys
    copied from the dotenv file into this process (never printed)."""
    os.environ["DATABASE_URL"] = dsn
    os.environ.setdefault("EMBEDDING_DIM", "2560")
    os.environ.setdefault("CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S", "60")
    if keys:
        from dotenv import dotenv_values

        values = dotenv_values(env_file)
        for name in keys:
            if not values.get(name):
                raise SystemExit(f"{name} is missing from {env_file}")
            os.environ[name] = values[name]


def spent(out: Path) -> float:
    total = 0.0
    for path in (out / "results").glob("*.json"):
        try:
            total += json.loads(path.read_text(encoding="utf-8")).get("cost_usd") or 0.0
        except (OSError, ValueError):
            continue
    return total


def inspect_body(doc, start: int, count: int) -> dict[str, Any]:
    """What Go's documents/inspect returns for a fixture document, current."""
    body: dict[str, Any] = {"title": doc.name, "supportedOperations": []}
    if doc.kind == "material":
        items = [
            {"id": b["id"], "type": b.get("type") or "p", "text": b["text"]} for b in doc.current
        ]
        body.update(format="plate", materialKind="note", supportedOperations=["insert_markdown", "replace_block", "remove_block", "replace_text"])
        key = "blocks"
    elif doc.format == "xlsx":
        items = [{"id": b["id"], "label": b["id"], "value": b["text"]} for b in doc.current]
        body.update(format="xlsx", supportedOperations=["set_cell"])
        key = "entries"
    elif doc.format == "text":
        items = [{"start": i + 1, "text": b["text"]} for i, b in enumerate(doc.current)]
        body.update(format="text", supportedOperations=["replace_text"])
        key = "lines"
    elif doc.format in ("docx", "pptx"):
        items = [{"id": b["id"], "type": "paragraph", "text": b["text"]} for b in doc.current]
        body.update(format=doc.format, supportedOperations=["replace_text"])
        key = "blocks"
    else:  # a PDF: its text, as indexed
        items = [{"id": f"p{i + 1}", "type": "page", "text": c["text"]} for i, c in enumerate(doc.chunks)]
        body.update(format="pdf")
        key = "blocks"
    end = min(start + count, len(items))
    body[key] = items[start:end]
    body["total"] = len(items)
    body["nextStart"] = end if end < len(items) else None
    return body


@contextmanager
def eval_patches(job: dict[str, Any], docs: list, shown: list[str]):
    import hints_eval_fixture as fx

    from pipeline.retrieval import pending, pending_hints, tools

    saved = (
        pending.load,
        pending_hints.for_message,
        pending_hints.message,
        pending_hints.HINT_TOKENS,
        tools._unindexed_edits,
        tools._gateway_read,
        pending_hints.match,
        pending_hints.MESSAGE_HEADING,
    )
    by_id = {d.id: d for d in docs}
    condition = job["condition"]

    async def load(_workspace_id, _file_ids=None):
        return fx.pending_sources(docs)

    async def for_message(query, sources, *, skip):
        if condition in ("none", "tail"):
            return []
        real = await saved[1](query, sources, skip=skip)
        if condition in ("real", "strict", "strict-name", "flag"):
            return real
        # What production would show, then the junk at the planned places.
        _, kept = pending_hints.render(real, pending_hints.MESSAGE_HEADING)
        pool = {h.change_id: h for h in pending_hints.candidates(sources)}
        combined = list(kept)
        for change_id, slot in zip(job["junk"], job["positions"], strict=True):
            hint = pool[change_id]
            combined.insert(min(slot, len(combined)), (hint, pending_hints.snippet(hint, query)))
        return combined

    def message(hints, **kw):
        rendered = saved[2](hints, **kw)
        if rendered:
            shown.extend(h.change_id for h, _ in rendered["_hints"])
        return rendered

    async def no_tail(_query, _ctx, _ids):
        return ""

    async def gateway_read(path, payload, failure):
        if path != "/api/internal/documents/inspect":
            return tools._refused(f"Could not {failure}: not available in this eval.")
        target = payload.get("target") or {}
        doc = by_id.get(str(target.get("id") or ""))
        if doc is None:
            return tools._refused(f"Could not {failure}: no such document.", code="unavailable_target")
        return inspect_body(doc, int(payload.get("start") or 0), int(payload.get("count") or 60))

    async def strict_match(query, pool, limit=pending_hints.HINT_LIMIT):
        """The matcher with the >= 2 matched words rule (Part 1), for the
        message hints and the search tail alike; strict-name also matches the
        document's name and shows at most 3."""
        import hints_eval_matcher as matcher

        from pipeline.retrieval import store
        from pipeline.retrieval.chunking import search_query_terms, tokenize_for_search

        any_of = search_query_terms(query).any_of
        if not pool or not any_of:
            return []
        if condition == "strict-name":
            pool = [
                pending_hints._Prepared(
                    p.hint, tokenize_for_search(f"{p.hint.name} {p.hint.text}"), p.config, p.simple
                )
                for p in pool
            ]
            limit = min(limit, 3)
        matches = await matcher.matches_for(await store.pool(), pool, query, any_of)
        keep = matcher.min_words(2, limit)({"matches": matches})
        hint = {p.hint.change_id: p.hint for p in pool}
        return [hint[m["change"]] for m in keep]

    search_spec = tools.REGISTRY["search_workspace"]

    async def flagged_search(args, ctx):
        """flag: name the passages' documents that have edits not indexed
        yet (a pointer, no edit text), after the search's own tail."""
        result = await search_spec.handler(args, ctx)
        sources = ctx.pending_sources
        counts = {str(f["fileId"]): len(f["changes"]) for f in sources.files}
        counts |= {str(n["materialId"]): len(n["changes"]) for n in sources.notes}
        read = sources.read_ids or set()
        named = {}
        for passage in result.passages:
            if passage.file_id in counts and passage.file_id not in read:
                named[passage.file_id] = passage
        if named:
            lines = [
                f'- {json.dumps(p.file_name, ensure_ascii=False)}, '
                f'{"material_id" if p.kind == "material" else "file_id"}={doc}: '
                f"{counts[doc]} edits not indexed yet"
                for doc, p in named.items()
            ]
            flag = (
                "Some passages above may be out of date: their document was edited "
                "after it was indexed. Read the document to see its current text.\n"
                + "\n".join(lines)
            )
            result.tail = f"{result.tail}\n\n{flag}" if result.tail else flag
        return result

    pending.load = load
    pending_hints.for_message = for_message
    if condition == "flag":
        tools.REGISTRY["search_workspace"] = tools.ToolSpec(name="search_workspace", handler=flagged_search)
    if condition in ("strict", "strict-name"):
        pending_hints.match = strict_match
    if condition == "junk3-wording":
        pending_hints.MESSAGE_HEADING = WORDING
    pending_hints.message = message
    if condition.startswith("junk"):
        pending_hints.HINT_TOKENS = 10_000
    if condition == "none":
        tools._unindexed_edits = no_tail
    tools._gateway_read = gateway_read
    try:
        yield
    finally:
        (
            pending.load,
            pending_hints.for_message,
            pending_hints.message,
            pending_hints.HINT_TOKENS,
            tools._unindexed_edits,
            tools._gateway_read,
            pending_hints.match,
            pending_hints.MESSAGE_HEADING,
        ) = saved
        tools.REGISTRY["search_workspace"] = search_spec


def cost_of(run: dict[str, Any], model: str) -> float:
    price = MODELS[model]["price"]
    total = 0.0
    for call in run.get("provider_calls") or []:
        cached = call.get("cached_read_tokens") or 0
        fresh = max(0, (call.get("input_tokens") or 0) - cached)
        total += fresh * price["input"] + cached * price["cached"]
        total += (call.get("output_tokens") or 0) * price["output"]
    searches = sum(1 for c in run.get("calls") or [] if c["name"] == "search_workspace")
    return total + searches * SEARCH_COST


async def run_one(job: dict[str, Any], playground, versions: dict[str, int], docs: list) -> dict[str, Any]:
    q = next(x for x in questions()["questions"] if x["id"] == job["question"])
    model = MODELS[job["model"]]
    config = playground.merged(
        {
            "workspace_id": WORKSPACE,
            "library": False,
            "open_resource": None,
            "study_preferences": {},
            "model": {
                "provider_slug": model["provider_slug"],
                "model_slug": model["model_slug"],
                "version": versions[job["model"]],
                "thinking": model["thinking"],
                "transport": model["transport"],
            },
            "answer": {"citations": "as_is"},
        }
    )
    config["target"] = "local"
    turn = playground.Turn(config, q["text"], [], playground.PdfResolver("local"))
    shown: list[str] = []
    errors = []
    started = time.perf_counter()
    with eval_patches(job, docs, shown):
        async for event in turn.events():
            if event.get("type") == "error":
                errors.append({k: event.get(k) for k in ("code", "message", "detail")})
    run = json.loads((turn.run_dir / "run.json").read_text(encoding="utf-8"))
    first = turn.run_dir / "requests" / "1.json"
    hint_block = ""
    if first.exists():
        request = json.loads(first.read_text(encoding="utf-8"))
        hint_block = next(
            (str(m.get("content")) for m in request["messages"] if m.get("_kind") == "pending_hints"),
            "",
        )
    calls = [
        {
            "name": c["name"],
            "args": c.get("args"),
            "outcome": c.get("outcome"),
            "text": c.get("text_sent_to_model") or "",
        }
        for c in run.get("calls") or []
    ]
    return {
        **job,
        "run_id": run["id"],
        "question_text": q["text"],
        "answer": run.get("answer") or "",
        "errors": errors,
        "elapsed_seconds": round(time.perf_counter() - started, 2),
        "provider_calls": [
            {k: c.get(k) for k in ("elapsed_seconds", "input_tokens", "output_tokens", "cached_read_tokens", "reasoning_tokens", "tool_calls")}
            for c in run.get("provider_calls") or []
        ],
        "calls": calls,
        "shown_hints": shown,
        "hint_block": hint_block,
        "stop": (run.get("telemetry") or {}).get("stopReason"),
        "cost_usd": round(cost_of(run, job["model"]), 6),
    }


def run(args) -> None:
    # DeepInfra embeds and reranks every search; Z.AI serves GLM.
    keys = ("DEEPINFRA_API_KEY", "ZAI_API_KEY") if args.model == "glm" else ("DEEPINFRA_API_KEY",)
    prepare(args.dsn, args.env_file, keys)
    sys.path.insert(0, str(PLAYGROUND))
    import playground  # noqa: E402  (after the environment)

    import hints_eval_fixture as fx
    from pipeline import registry, use_compatible_event_loop
    from pipeline.config import cfg

    # As the playground's server: tool admission decides as in production.
    cfg.gateway_url = cfg.gateway_url or "http://playground.invalid"
    cfg.pipeline_secret = cfg.pipeline_secret or "playground"
    use_compatible_event_loop()
    plan_ = json.loads((args.out / "plan.json").read_text(encoding="utf-8"))
    jobs = [j for j in plan_["jobs"] if j["model"] == args.model]
    jobs = jobs[args.shard :: args.shards]
    results = args.out / "results"
    results.mkdir(parents=True, exist_ok=True)
    docs = fx.load()

    async def go():
        from pipeline.retrieval import store

        registry.registry.refresh()
        pool = await store.pool()
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT provider_slug, model_slug, max(version) AS v FROM model_configs "
                "WHERE enabled GROUP BY provider_slug, model_slug"
            )
            latest = {(r["provider_slug"], r["model_slug"]): r["v"] for r in await cur.fetchall()}
        versions = {
            name: latest[(m["provider_slug"], m["model_slug"])] for name, m in MODELS.items()
        }
        done = 0
        for job in jobs:
            path = results / f"{job['id']}.json"
            if path.exists():
                continue
            if spent(args.out) > args.spend_cap:
                print(f"spend cap {args.spend_cap} reached; stopping", flush=True)
                break
            try:
                result = await run_one(job, playground, versions, docs)
            except Exception as exc:  # noqa: BLE001 - record and go on
                result = {**job, "harness_error": f"{type(exc).__name__}: {exc}"[:500], "cost_usd": 0}
            if result.get("harness_error") or result.get("errors"):
                # Failed turns are kept apart and rerun on the next pass.
                (results / f"{job['id']}.failed.json").write_text(
                    json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
                )
            else:
                path.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
            done += 1
            print(
                f"{job['id']}: {result.get('elapsed_seconds')}s ${result.get('cost_usd')} "
                f"reads={[c['args'] for c in result.get('calls', []) if c['name'] in READ_TOOLS]} "
                f"err={result.get('harness_error') or result.get('errors')}",
                flush=True,
            )
        await store.close_pool()
        print(f"worker done: {done} jobs", flush=True)

    asyncio.run(go())


def launch(args) -> None:
    """Start the workers (one turn at a time each: the playground's patches
    are process-global) and wait for them."""
    procs = []
    logs = args.out / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    for spec in args.workers.split(","):
        model, count = spec.split("=")
        for shard in range(int(count)):
            log = open(logs / f"{model}-{shard}.log", "a", encoding="utf-8")
            cmd = [
                sys.executable, __file__, "run", "--out", str(args.out), "--dsn", args.dsn,
                "--env-file", str(args.env_file), "--model", model, "--shard", str(shard),
                "--shards", count, "--spend-cap", str(args.spend_cap),
            ]
            procs.append(subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env={**os.environ, "PYTHONIOENCODING": "utf-8"}))
    (args.out / "workers.pid").write_text("\n".join(str(p.pid) for p in procs), encoding="utf-8")
    for p in procs:
        p.wait()
    print(f"workers finished; spent ${spent(args.out):.3f}")


# ----------------------------------------------------------------- score


def normalize(answer: str) -> str:
    """Answer text with LaTeX flattened, so a key like 6x cos matches
    $6x\\,\\cos(3x^2)$ (the answers are OpenUI strings, so backslashes may
    be doubled)."""
    t = re.sub(r"\\{1,2}(text|mathrm|operatorname|mathbf)\{([^}]*)\}", r"\2", answer)
    t = re.sub(r"\\{1,2}(cdot|times)", "·", t)
    t = re.sub(r"\\{1,2}[,;:! ]", " ", t)
    t = re.sub(r"\\{1,2}([A-Za-z]+)", r"\1", t)
    return t.replace("$", "").replace("{", "").replace("}", "")


def _matches(patterns: list[str], text: str) -> bool:
    return all(re.search(p, text, re.IGNORECASE | re.DOTALL) for p in patterns)


def _any(patterns: list[str], text: str) -> bool:
    return any(re.search(p, text, re.IGNORECASE | re.DOTALL) for p in patterns)


def read_targets(result: dict[str, Any]) -> list[str]:
    out = []
    for call in result["calls"]:
        args = call.get("args") or {}
        if call["name"] == "read_document":
            out.append(str(args.get("file_id") or ""))
        elif call["name"] == "inspect_document":
            out.append(str((args.get("target") or {}).get("id") or ""))
    return out


def judge(result: dict[str, Any], q: dict[str, Any], markers: dict[str, str], owner: dict[str, str]) -> dict[str, Any]:
    answer = normalize(result["answer"])
    reads = read_targets(result)
    gold = set(q["gold_docs"])
    junk_docs = {owner[c] for c in result["junk"]} - gold
    shown = result["shown_hints"]
    real_shown = [c for c in shown if c not in result["junk"]]
    key_ok = bool(q["key"]) and _matches(q["key"], answer)
    stale = bool(q["stale"]) and _any(q["stale"], answer) and not key_ok
    tails = [c["text"] for c in result["calls"] if c["name"] == "search_workspace" and "Unindexed edits matching this search" in c["text"]]
    gold_hinted = any(c in q["gold_changes"] for c in real_shown)
    gold_in_tail = any(
        any(f"={d}" in t.split("Unindexed edits matching this search", 1)[1] for d in gold) for t in tails
    )
    junk_quoted = [c for c in result["junk"] if re.search(markers[c], answer)]
    # Hints shown that are noise for this question (real ones off its key).
    noise_real = [c for c in real_shown if c not in q["gold_changes"] and owner[c] not in gold]
    noise_quoted = [c for c in noise_real if re.search(markers[c], answer)]
    return {
        "correct": key_ok if q["key"] else None,
        "stale": stale,
        "read_gold": bool(gold & set(reads)),
        "reads": len(reads),
        "wasted_reads": sum(1 for r in reads if r not in gold),
        "junk_reads": sum(1 for r in reads if r in junk_docs),
        "noise_reads": sum(1 for r in reads if r in {owner[c] for c in noise_real} - gold),
        "tool_calls": len(result["calls"]),
        "searches": sum(1 for c in result["calls"] if c["name"] == "search_workspace"),
        "gold_hinted": gold_hinted,
        "gold_in_tail": gold_in_tail,
        "unread_key": bool(key_ok and q["kind"] == "edit" and not (gold & set(reads))),
        "junk_quoted": junk_quoted,
        "noise_quoted": noise_quoted,
        "input_tokens": sum(c.get("input_tokens") or 0 for c in result["provider_calls"]),
        "output_tokens": sum(c.get("output_tokens") or 0 for c in result["provider_calls"]),
        "provider_calls": len(result["provider_calls"]),
        "elapsed": result["elapsed_seconds"],
        "cost": result["cost_usd"],
    }


def score(args) -> None:
    import hints_eval_fixture as fx

    data = questions()
    qs = {q["id"]: q for q in data["questions"]}
    owner = {c: d.id for c, d in fx.change_doc(fx.load()).items()}
    rows = []
    paths = [p for d in [args.out, *args.also] for p in sorted((d / "results").glob("*.json"))]
    for path in paths:
        if path.name.endswith(".failed.json"):
            continue
        result = json.loads(path.read_text(encoding="utf-8"))
        q = qs[result["question"]]
        rows.append({**{k: result[k] for k in ("id", "question", "model", "condition", "repeat")}, "kind": q["kind"], **judge(result, q, data["markers"], owner)})
    (args.out / "scored.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")

    def mean(values):
        values = [v for v in values if v is not None]
        return round(sum(values) / len(values), 3) if values else None

    groups = defaultdict(list)
    for r in rows:
        groups[(r["model"], r["condition"])].append(r)
    table = []
    for (model, condition), items in sorted(groups.items(), key=lambda kv: (kv[0][0], CONDITIONS.index(kv[0][1]))):
        edit = [r for r in items if r["kind"] == "edit"]
        indexed = [r for r in items if r["kind"] == "indexed"]
        table.append(
            {
                "model": model,
                "condition": condition,
                "turns": len(items),
                "correct_edit": mean([float(r["correct"]) for r in edit]),
                "stale_edit": mean([float(r["stale"]) for r in edit]),
                "correct_indexed": mean([float(r["correct"]) for r in indexed]),
                "read_gold_edit": mean([float(r["read_gold"]) for r in edit]),
                "unread_key_edit": mean([float(r["unread_key"]) for r in edit]),
                "wasted_reads": mean([r["wasted_reads"] for r in items]),
                "junk_reads": mean([r["junk_reads"] for r in items]),
                "junk_quoted": mean([float(bool(r["junk_quoted"])) for r in items]),
                "noise_quoted": mean([float(bool(r["noise_quoted"])) for r in items]),
                "tool_calls": mean([r["tool_calls"] for r in items]),
                "input_tokens": mean([r["input_tokens"] for r in items]),
                "output_tokens": mean([r["output_tokens"] for r in items]),
                "seconds_median": round(statistics.median(r["elapsed"] for r in items), 1),
                "cost_per_turn": mean([r["cost"] for r in items]),
            }
        )
    (args.out / "table.json").write_text(json.dumps(table, ensure_ascii=False, indent=1), encoding="utf-8")
    cols = list(table[0].keys()) if table else []
    print("| " + " | ".join(cols) + " |")
    print("|" + "---|" * len(cols))
    for row in table:
        print("| " + " | ".join(str(row[c]) for c in cols) + " |")
    print(f"total spend ${sum(r['cost'] for r in rows):.3f} over {len(rows)} turns")
    # Per question: correct turns of all turns per condition, each model.
    detail: dict[str, dict[str, dict[str, str]]] = defaultdict(lambda: defaultdict(dict))
    cells = defaultdict(list)
    for r in rows:
        cells[(r["model"], r["question"], r["condition"])].append(r)
    for (model, question, condition), items in sorted(cells.items()):
        if qs[question]["key"]:
            ok = sum(1 for r in items if r["correct"])
            detail[model][question][condition] = f"{ok}/{len(items)}"
    (args.out / "detail.json").write_text(json.dumps(detail, indent=1), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "run", "launch", "score"):
        p = sub.add_parser(name)
        p.add_argument("--out", type=Path, required=True)
        p.add_argument("--dsn", default="postgres://capy:capy@127.0.0.1:55991/capy")
        p.add_argument("--env-file", type=Path, default=Path("C:/WEB/capy-notebook/.env.local"))
        p.add_argument("--spend-cap", type=float, default=9.0)
        if name == "plan":
            p.add_argument("--repeats", type=int, default=2)
            p.add_argument("--models", default="glm,deepseek")
            p.add_argument("--conditions", default=",".join(CONDITIONS))
        if name == "run":
            p.add_argument("--model", required=True, choices=sorted(MODELS))
            p.add_argument("--shard", type=int, default=0)
            p.add_argument("--shards", type=int, default=1)
        if name == "launch":
            p.add_argument("--workers", default="glm=4,deepseek=4")
        if name == "score":
            p.add_argument("--also", type=Path, nargs="*", default=[], help="more run folders to score with --out")
    args = parser.parse_args()
    {"plan": plan, "run": run, "launch": launch, "score": score}[args.command](args)


if __name__ == "__main__":
    main()
