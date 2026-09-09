"""Run the current production agent over isolated, matched parser workspaces."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import random
import re
import time
import uuid
from contextlib import nullcontext
from dataclasses import asdict
from pathlib import Path

from odl_agentic_runtime import (
    EMBEDDING_PIN,
    guard_database,
    install_transport,
    recording_context,
)
from odl_page_evidence import MAX_PAGE_ATTEMPTS, generation_identity, page_evidence
from odl_retrieval_candidates import SUPPORTED_CANDIDATES, system_prompt_addon
from pipeline.config import cfg
from pipeline.elitellm import client
from pipeline.prompts import chat as chat_prompts
from pipeline.retrieval import (
    accounting,
    agent,
    chunking,
    compact,
    limits,
    models,
    pending,
    search,
    store,
    tools,
    usage_extract,
)
from pipeline.retrieval import (
    stream as model_stream,
)

from pipeline import obs, registry


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def scope_ids(question, workspace):
    """Gold source_ids never restrict retrieval. Null scope means all sources."""
    requested = question["scope_source_ids"]
    if requested is None:
        return []
    if (
        not isinstance(requested, list)
        or not requested
        or len(requested) != len(set(requested))
    ):
        raise ValueError("An explicit source scope must be a nonempty unique list")
    return [workspace["files"][source] for source in requested]


def result_from_events(events):
    done = next((e for e in reversed(events) if e.get("type") == "done"), {})
    answer = done.get("answer", "")
    citations = next(
        (e["citations"] for e in reversed(events) if e.get("type") == "citations"), []
    )
    used = sorted({int(n) for n in re.findall(r"\[(\d{1,3})\]", answer)})
    invalid = [n for n in used if not 1 <= n <= len(citations)]
    errors = [e for e in events if e.get("type") == "error"]
    stop = done.get("telemetry", {}).get("stopReason")
    return {
        "status": "error"
        if errors
        else "complete"
        if answer and stop == "answer"
        else "empty",
        "answer": answer,
        "telemetry": done.get("telemetry", {}),
        "usage": done.get("usage"),
        "citations": citations,
        "citation_numbers": used,
        "invalid_citation_numbers": invalid,
        "cited_chunk_ids": [
            citations[n - 1]["chunkId"] for n in used if n not in invalid
        ],
        "errors": errors,
    }


async def fingerprint(workspaces):
    result = {}
    pool = await store.pool()
    async with pool.connection() as conn:
        for name, workspace in workspaces.items():
            wid = workspace["workspace_id"]
            pin = await store.workspace_embedding_pin(wid)
            if (
                pin["embedding_provider_slug"],
                pin["embedding_model_slug"],
                pin["embedding_model_version"],
            ) != EMBEDDING_PIN or pin["embedding_dim"] != 2560:
                raise ValueError(
                    "Workspace embedding pin differs from Qwen3-Embedding-4B/2560"
                )
            table = store.vector_table_for_pin(pin)
            row = await conn.execute(
                "SELECT count(*) AS count, md5(string_agg(md5(row(c.*)::text), '' ORDER BY id)) AS fingerprint FROM rag_chunks c WHERE workspace_id=%s",
                (wid,),
            )
            chunks = dict(await row.fetchone())
            row = await conn.execute(
                f"SELECT count(*) AS count, md5(string_agg(md5(row(v.*)::text), '' ORDER BY chunk_id)) AS fingerprint FROM {table} v WHERE workspace_id=%s",
                (wid,),
            )
            vectors = dict(await row.fetchone())
            outline = await store.workspace_outline(wid)
            if set(workspace["files"].values()) != {f["id"] for f in outline["files"]}:
                raise ValueError("Workspace file inventory differs from the frozen arm")
            failed = workspace.get("failed_sources", {})
            if not set(failed) <= workspace["files"].keys():
                raise ValueError("Unknown failed source in the workspace manifest")
            failed_ids = {workspace["files"][sid] for sid in failed}
            for file in outline["files"]:
                if file["id"] in failed_ids:
                    if (
                        file["status"] != "failed"
                        or file["chunks"]
                        or file["descriptor"]
                        or file["summary"]
                    ):
                        raise ValueError(
                            "Failed source retained usable partial content"
                        )
                elif file["status"] != "ready":
                    raise ValueError("A source lacks a recorded preparation outcome")
            if chunks["count"] != vectors["count"]:
                raise ValueError("Not every chunk has a vector")
            snapshot = await pending.load(wid)
            if snapshot.files:
                raise ValueError("Pending source edits would confound the comparison")
            result[name] = {
                "workspace_id": wid,
                "files": workspace["files"],
                "pin": pin,
                "chunks": chunks,
                "vectors": vectors,
                "outline": outline,
                "failed_sources": failed,
            }
    return result


async def run_turn(question, arm, workspace, repeat, spec, candidate):
    if accounting.current() is not None:
        raise ValueError("The direct lab runner must not use a billing session")
    uid = "eval_" + uuid.uuid4().hex
    scope = scope_ids(question, workspace)
    calls, rendered, events = [], [], []
    original_run, original_render, original_prompt = (
        tools.run,
        tools.render_result,
        chat_prompts.system_prompt,
    )

    async def observe_run(name, arguments, ctx):
        record = {"sequence": len(calls), "name": name, "args": arguments}
        calls.append(record)
        started = time.perf_counter()
        try:
            result = await original_run(name, arguments, ctx)
            record.update(
                text=result.text(),
                error=result.error,
                refused=result.refused,
                passages=[asdict(p) for p in result.passages],
            )
            return result
        finally:
            record["elapsed_seconds"] = time.perf_counter() - started

    def observe_render(result, numbered):
        text = original_render(result, numbered)
        clipped = tools.limit_tool_result(text)
        rendered.append(
            {
                "numbers": [n for n, _ in numbered],
                "chunk_ids": [p.chunk_id for _, p in numbered],
                "text_sent_to_model": clipped,
                "truncated": clipped != text,
            }
        )
        return text

    addon = system_prompt_addon(candidate)
    tools.run, tools.render_result = observe_run, observe_render
    if addon:
        chat_prompts.system_prompt = lambda locale: original_prompt(locale) + addon
    ctx = tools.ToolContext(
        workspace_id=workspace["workspace_id"],
        file_ids=scope,
        assistant_message_id=uid,
        can_generate=False,
    )
    obs.set_trace(obs.new_trace_id())
    obs.start_usage()
    registry.bind_request_llm(thinking="instant")
    started = time.perf_counter()
    try:
        with recording_context(
            phase="agent",
            turn_id=uid,
            question_id=question["id"],
            arm=arm,
            repeat=repeat,
            prompt_candidate=candidate,
        ):
            async for event in agent.run_agent(
                query=question["question"],
                ctx=ctx,
                history=[],
                model=spec,
                locale=question["language"],
            ):
                events.append(event)
    except Exception as exc:  # noqa: BLE001 - preserve every failed benchmark attempt
        events.append(
            {
                "type": "error",
                "code": "harness_exception",
                "message": f"{type(exc).__name__}: {exc}",
            }
        )
    finally:
        tools.run, tools.render_result, chat_prompts.system_prompt = (
            original_run,
            original_render,
            original_prompt,
        )
    result = result_from_events(events)
    allowed = set(scope or workspace["files"].values())
    observed = [p for c in calls for p in c.get("passages", [])]
    scope_valid = not (
        any(p["file_id"] not in allowed for p in observed)
        or any(c["fileId"] not in allowed for c in result["citations"])
    )
    if not scope_valid:
        events.append(
            {
                "type": "error",
                "code": "scope_violation",
                "message": "Tool evidence escaped the requested source scope",
            }
        )
        result = result_from_events(events)
    return {
        "id": question["id"],
        "arm": arm,
        "repeat": repeat,
        "prompt_candidate": candidate,
        "split": question["split"],
        "family": question["family"],
        "language": question["language"],
        "question": question["question"],
        "scope_source_ids": question["scope_source_ids"],
        "resolved_file_ids": scope,
        "turn_id": uid,
        "workspace_id": workspace["workspace_id"],
        "elapsed_seconds": time.perf_counter() - started,
        **result,
        "scope_valid": scope_valid,
        "calls": calls,
        "rendered_tool_results": rendered,
        "search_events": ctx.search_events,
        "events": events,
    }


async def main(args):
    guard_database()
    fixture, mapping = read(args.questions), read(args.workspaces)
    if "draft" in fixture.get("schema", "").lower() or not fixture.get("schema"):
        raise ValueError("Source-audited questions must be frozen before agent calls")
    arms = args.arms.split(",")
    workspaces = {name: mapping["arms"][name] for name in arms}
    if (
        len(arms) != len(set(arms))
        or len({frozenset(w["files"]) for w in workspaces.values()}) != 1
    ):
        raise ValueError("Arms must be unique and contain identical logical sources")
    if len({w["workspace_id"] for w in workspaces.values()}) != len(workspaces):
        raise ValueError("Parser arms require separate workspaces")
    questions = [
        q
        for q in fixture["questions"]
        if args.split == "all" or q["split"] == args.split
    ]
    if args.ids:
        ids = set(args.ids.split(","))
        questions = [q for q in questions if q["id"] in ids]
        if {q["id"] for q in questions} != ids:
            raise ValueError(
                "An explicit question ID is missing from the selected split"
            )
    if (
        not questions
        or len({q["id"] for q in questions}) != len(questions)
        or args.repeats < 1
    ):
        raise ValueError("Questions must be nonempty and unique, with positive repeats")
    for q in questions:
        for w in workspaces.values():
            scope_ids(q, w)
    spec = install_transport()
    registry.set_job_pins(registry.JobPins(captioning=spec))
    registry.registry.start()
    registry.bind_request_llm(thinking="instant")
    corpus = read(args.corpus) if args.corpus else None
    if args.source_page_evidence and corpus is None:
        raise ValueError("Source-page evidence requires the frozen corpus manifest")
    expression = "v.embedding <=> %(vector)s::halfvec"
    store._SEARCH_SQL_TEMPLATE = store._SEARCH_SQL_TEMPLATE.replace(
        expression, "(" + expression + ") + 0"
    )
    state = await fingerprint(workspaces)
    freeze = {
        "questions_sha256": sha(args.questions),
        "workspaces_sha256": sha(args.workspaces),
        "selected_ids": [q["id"] for q in questions],
        "arms": arms,
        "repeats": args.repeats,
        "shuffle_seed": 20260909,
        "prompt_candidate": args.prompt_candidate,
        "source_page_evidence": args.source_page_evidence,
        "corpus_sha256": sha(args.corpus) if args.corpus else None,
        "page_evidence_generation": generation_identity(),
        "model": asdict(spec),
        "enable_thinking": False,
        "index_state": state,
        "runtime_sources": {
            m.__name__: sha(m.__file__)
            for m in (
                agent,
                tools,
                models,
                search,
                store,
                pending,
                limits,
                chat_prompts,
                registry,
                client,
                accounting,
                chunking,
                compact,
                model_stream,
                usage_extract,
            )
        },
        "harness_sources": {
            p.name: sha(p)
            for p in [
                Path(__file__),
                Path(__file__).with_name("odl_agentic_runtime.py"),
                Path(__file__).with_name("odl_retrieval_candidates.py"),
                Path(__file__).with_name("odl_page_evidence.py"),
            ]
        },
        "limits": {
            "planning": min(cfg.agent_max_steps, limits.PLANNING_RESPONSES),
            "tools_per_response": limits.TOOLS_PER_RESPONSE,
            "tools_per_turn": limits.TOOLS_PER_TURN,
            "parallel_tools": limits.MAX_CONCURRENT,
            "tool_result_tokens": tools.TOOL_RESULT_MAX_TOKENS,
            "search_candidates": cfg.search_candidates,
            "search_top_k": cfg.search_top_k,
            "search_per_file_cap": cfg.search_per_file_cap,
            "provider_idle_seconds": cfg.interactive_provider_timeout_s,
            "stream_backstop_seconds": cfg.interactive_stream_max_s,
            "retry": asdict(models.INTERACTIVE_RETRY),
            "source_page_attempts_when_enabled": MAX_PAGE_ATTEMPTS,
        },
        "search_sql_sha256": hashlib.sha256(
            store._SEARCH_SQL_TEMPLATE.encode()
        ).hexdigest(),
        "search_mode": "Current hybrid SQL and weights, exact vector ordering via +0 as in the prior benchmark; no ANN comparison",
        "billing": "Direct agent call, no gateway/accounting session or admission; provider receipts recorded separately",
        "qwen_endpoint": os.environ["ODL_QWEN_CHAT_URL"],
    }
    freeze = json.loads(json.dumps(freeze))
    freeze_path = args.output.with_suffix(args.output.suffix + ".freeze.json")
    if args.resume:
        if read(freeze_path) != freeze:
            raise ValueError(
                "Cannot resume after source, index, configuration or code changed"
            )
    elif args.output.exists() or freeze_path.exists():
        raise ValueError("Use fresh output paths or explicit --resume")
    else:
        save(freeze_path, freeze)
    done = set()
    if args.output.exists():
        for line in args.output.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            done.add((row["id"], row["arm"], row["repeat"]))
    plan = [
        (q, arm, repeat)
        for repeat in range(args.repeats)
        for q in questions
        for arm in arms
    ]
    random.Random(20260909).shuffle(plan)
    failures = 0
    try:
        for q, arm, repeat in plan:
            if (q["id"], arm, repeat) in done:
                continue
            context = (
                page_evidence(workspaces[arm], corpus, args.page_cache)
                if args.source_page_evidence
                else nullcontext(None)
            )
            with context as page_state:
                result = await run_turn(
                    q, arm, workspaces[arm], repeat, spec, args.prompt_candidate
                )
                result["source_page_evidence"] = args.source_page_evidence
                result["page_evidence"] = page_state
            with args.output.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(result, ensure_ascii=False) + "\n")
            print(
                json.dumps(
                    {
                        k: result[k]
                        for k in ("id", "arm", "repeat", "status", "elapsed_seconds")
                    }
                ),
                flush=True,
            )
            if not result["scope_valid"]:
                raise AssertionError(
                    "Source scope violation saved; stop for inspection"
                )
            failures = failures + 1 if result["status"] == "error" else 0
            if failures >= 3:
                raise RuntimeError(
                    "Three consecutive errors; first attempts preserved, inspect before resuming"
                )
        after = await fingerprint(workspaces)
        if after != state:
            raise AssertionError("The evaluated index changed during the run")
        save(
            args.output.with_suffix(args.output.suffix + ".complete.json"),
            {"attempts": len(plan), "index_unchanged": True},
        )
    finally:
        await store.close_pool()


def check():
    workspace = {"files": {"a": "fa", "b": "fb"}}
    assert scope_ids({"scope_source_ids": None, "source_ids": ["a"]}, workspace) == []
    assert scope_ids({"scope_source_ids": ["b"], "source_ids": ["a"]}, workspace) == [
        "fb"
    ]
    for scope in ([], ["missing"], ["a", "a"]):
        try:
            scope_ids({"scope_source_ids": scope}, workspace)
        except (ValueError, KeyError):
            pass
        else:
            raise AssertionError("Invalid scope accepted")
    value = result_from_events(
        [
            {"type": "citations", "citations": [{"chunkId": "c"}]},
            {
                "type": "done",
                "answer": "Answer [1] [9]",
                "telemetry": {"stopReason": "answer"},
            },
        ]
    )
    assert (
        value["status"] == "complete"
        and value["invalid_citation_numbers"] == [9]
        and value["cited_chunk_ids"] == ["c"]
    )
    assert (
        result_from_events(
            [
                {
                    "type": "done",
                    "answer": "",
                    "telemetry": {"stopReason": "planning_cap"},
                }
            ]
        )["status"]
        == "empty"
    )
    assert system_prompt_addon("baseline") == ""
    print(
        "Gold-source isolation, empty-scope rejection and current event/citation checks passed"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--questions", type=Path)
    parser.add_argument("--workspaces", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--arms", default="odl,mineru")
    parser.add_argument("--split", choices=("development", "heldout", "all"))
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--ids")
    parser.add_argument("--corpus", type=Path)
    parser.add_argument("--source-page-evidence", action="store_true")
    parser.add_argument("--page-cache", type=Path, default=Path("/lab/page-cache"))
    parser.add_argument(
        "--prompt-candidate", choices=SUPPORTED_CANDIDATES, default="baseline"
    )
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
    else:
        if not all((args.questions, args.workspaces, args.output, args.split)):
            parser.error("--questions, --workspaces, --output and --split are required")
        asyncio.run(main(args))
