"""Replay three saved workspace boundaries through Tencent GLM-5.3-Flash.

The saved message histories come from the frozen 2026-09-21 runtime. This is a
tools-off boundary replay, not a fresh retrieval comparison. It changes only
the provider, reasoning effort, and the candidate's final system instruction.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "bench/rag/reports/local/2026-09-22-workspace-terminal/runs"
OUT = ROOT / "bench/rag/reports/local/2026-09-23-workspace-terminal-tencent"
FINAL_INSTRUCTION = (
    "This is the final response for this turn. No tools are available and no "
    "further calls will be executed. Answer the user's request now using only "
    "evidence already shown, in the required OpenUI Lang format. Cite the shown "
    "passages that support each factual claim. If the available evidence is "
    "insufficient, state the precise remaining evidence gap. Do not claim the "
    "entire workspace lacks an answer merely because searches did not find it. "
    "Do not call or propose tools."
)
CASES = {
    "supported-author": {
        "request": SOURCE
        / "repeat-0/workspace-opening-mayor/terminal/provider/8/request.json",
        "construction": "natural tools-off request; remove recorded candidate instruction",
    },
    "scope-excluded-author": {
        "request": SOURCE
        / "repeat-0/workspace-opening-author-excluded/baseline/provider/8/request.json",
        "construction": "natural tools-off request",
    },
    "unsupported-gpt20": {
        "request": SOURCE
        / "repeat-0/workspace-opening-gpt20/terminal/provider/4/request.json",
        "construction": "early-final request replayed with tools removed",
    },
}


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def save(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n")


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha(path: Path) -> str:
    return sha_bytes(path.read_bytes())


def base_messages(case: dict) -> list[dict]:
    request = read(case["request"])
    messages = copy.deepcopy(request["messages"])
    if messages[-1] == {"role": "system", "content": FINAL_INSTRUCTION}:
        messages.pop()
    assert not any(
        m == {"role": "system", "content": FINAL_INSTRUCTION} for m in messages
    )
    return messages


def passage_count(messages: list[dict]) -> int:
    shown: set[int] = set()
    for message in messages:
        content = message.get("content")
        texts = (
            [content]
            if isinstance(content, str)
            else [
                part.get("text", "")
                for part in content or []
                if isinstance(part, dict) and part.get("type") == "text"
            ]
        )
        for text in texts:
            shown.update(int(n) for n in re.findall(r"(?m)^\[(\d+)\]", text))
    return max(shown, default=0)


def current_prompt_hash() -> str:
    sys.path.insert(0, str(ROOT / "pipeline"))
    from pipeline.prompts.chat import system_prompt

    return sha_bytes(system_prompt("en").encode())


def freeze() -> dict:
    return {
        "schema": "workspace-terminal-tencent-v1",
        "candidate": FINAL_INSTRUCTION,
        "provider": "Tencent TokenHub",
        "model": "glm-5.3-flash",
        "thinking": "high",
        "temperature": 0,
        "tools": None,
        "current_production_prompt_sha256": current_prompt_hash(),
        "cases": {
            case_id: {
                "source_request": str(case["request"].relative_to(ROOT)),
                "source_request_sha256": sha(case["request"]),
                "frozen_prompt_sha256": sha_bytes(
                    base_messages(case)[0]["content"].encode()
                ),
                "construction": case["construction"],
                "passages_available": passage_count(base_messages(case)),
            }
            for case_id, case in CASES.items()
        },
    }


def check() -> None:
    protocol = freeze()
    assert len(protocol["cases"]) == 3
    assert protocol["cases"]["supported-author"]["construction"].startswith("natural")
    assert protocol["cases"]["scope-excluded-author"]["construction"].startswith(
        "natural"
    )
    assert protocol["cases"]["unsupported-gpt20"]["construction"].startswith(
        "early-final"
    )
    for case in CASES.values():
        request = read(case["request"])
        assert request["model"] == "glm-5.3-flash:cloud"
        assert request["messages"][0]["role"] == "system"
        assert base_messages(case)[-1]["role"] in {"tool", "user"}
    print(json.dumps({"cases": 3, "provider_calls": 6, "protocol": protocol}))


async def one(case_id: str, arm: str, messages: list[dict], key: str) -> dict:
    from pipeline.elitellm import client
    from pipeline.registry import ModelConfig
    from pipeline.retrieval import openui
    from pipeline.retrieval.stream import ChatCompletionsAssembler

    submitted = copy.deepcopy(messages)
    if arm == "candidate":
        submitted.append({"role": "system", "content": FINAL_INSTRUCTION})
    spec = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM-5.3-Flash",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        params={"temperature": 0},
        thinking_levels=("low", "high", "max"),
        default_thinking="high",
        context_window_tokens=200_000,
    )
    wire = client.zai_request(
        spec,
        submitted,
        temperature=0,
        tools=None,
        response_format=None,
        max_tokens=None,
        thinking="high",
        stream=True,
        tool_choice=None,
    )
    folder = OUT / "runs" / case_id / arm
    save(folder / "request.json", wire)
    assembler = ChatCompletionsAssembler("zai")
    started = time.perf_counter()
    with (folder / "response.jsonl").open("w") as stream:
        async for event in client._stream_sse(
            client.TENCENT_CHAT_URL,
            {"authorization": f"Bearer {key}", "content-type": "application/json"},
            wire,
        ):
            stream.write(json.dumps(event, ensure_ascii=False) + "\n")
            assembler.push(event)
    elapsed = time.perf_counter() - started
    assembled = assembler.finish()
    known = passage_count(submitted)
    renderer = openui.LangRenderer(lambda: known)
    renderer.push(assembled.text)
    renderer.finish()
    result = {
        "case": case_id,
        "arm": arm,
        "boundary": "natural"
        if not CASES[case_id]["construction"].startswith("early-final")
        else "constructed by removing tools from an early-final request",
        "elapsed_seconds": round(elapsed, 3),
        "usage": {
            "input_tokens": assembled.usage.input_tokens,
            "output_tokens": assembled.usage.output_tokens,
            "cached_read_tokens": assembled.usage.cached_read_tokens,
            "reasoning_tokens": assembled.usage.reasoning_tokens,
        },
        "status": assembled.status,
        "tool_calls": [
            {"name": call.name, "arguments": call.arguments}
            for call in assembled.tool_calls
        ],
        "raw_text": assembled.text,
        "parsed_answer": renderer.text,
        "plain_text": openui.text_of(renderer.text),
        "openui": {
            "answer_shaped": renderer.answer_shaped,
            "complete": renderer.complete,
            "invalid": renderer.invalid,
            "cited_passages": renderer.reading_order(),
            "known_passages": known,
        },
    }
    save(folder / "result.json", result)
    return result


async def run() -> None:
    check()
    protocol = freeze()
    if (OUT / "protocol.json").exists():
        assert read(OUT / "protocol.json") == protocol, "protocol changed"
    else:
        save(OUT / "protocol.json", protocol)
    env = dotenv_values(ROOT / "deploy/.env.uat")
    key = (
        os.environ.get("TENCENT_API_KEY") or env.get("TENCENT_API_KEY") or ""
    ).strip()
    if not key:
        raise RuntimeError("TENCENT_API_KEY is unavailable")
    results = []
    for case_id, case in CASES.items():
        messages = base_messages(case)
        for arm in ("baseline", "candidate"):
            path = OUT / "runs" / case_id / arm / "result.json"
            result = (
                read(path) if path.exists() else await one(case_id, arm, messages, key)
            )
            results.append(result)
            print(
                json.dumps(
                    {
                        "case": case_id,
                        "arm": arm,
                        "seconds": result["elapsed_seconds"],
                        "input": result["usage"]["input_tokens"],
                        "output": result["usage"]["output_tokens"],
                        "cached": result["usage"]["cached_read_tokens"],
                        "tools": len(result["tool_calls"]),
                        "valid_openui": result["openui"]["complete"]
                        and not result["openui"]["invalid"],
                    }
                ),
                flush=True,
            )
    save(OUT / "summary.json", {"protocol": protocol, "results": results})


async def fresh() -> None:
    """Run two complete loops through the current playground/runtime."""
    sys.path[:0] = [
        str(ROOT / "lab/playground/scripts"),
        str(ROOT / "pipeline"),
        str(ROOT / "bench/rag/scripts"),
    ]
    import common
    import playground
    import psycopg
    import workspace_opening_agentic as opening
    from psycopg.rows import dict_row

    env = dotenv_values(ROOT / "deploy/.env.uat")
    for name in ("DEEPINFRA_API_KEY", "TENCENT_API_KEY"):
        value = (os.environ.get(name) or env.get(name) or "").strip()
        if not value:
            raise RuntimeError(f"{name} is unavailable")
        os.environ[name] = value
    os.environ.update(
        DATABASE_URL=opening.DSN,
        LIBRARY_DATABASE_URL="",
        SENTRY_DSN="",
        CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S="180",
        GATEWAY_URL="http://127.0.0.1:1",
        PIPELINE_SECRET="local-benchmark-only",
    )
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

    common.LAB = opening.CORPUS
    common.ensure_tunnel((15435,))
    snapshot = opening.read(opening.LOCAL / "snapshot.json")
    fixture = opening.read(opening.FIXTURE)
    chosen = {
        case["id"]: case
        for case in fixture["cases"]
        if case["id"] in {"workspace-opening-mayor", "workspace-opening-gpt20"}
    }
    ws = snapshot["workspace_id"]
    by_file: dict[str, list[dict]] = {}
    for chunk in snapshot["chunks"]:
        by_file.setdefault(chunk["file_id"], []).append(chunk)
    for chunks in by_file.values():
        chunks.sort(key=lambda chunk: chunk["chunk_idx"])

    async def outline(workspace_id):
        assert workspace_id == ws
        return {"files": snapshot["files"], "chapters": snapshot["chapters"]}

    async def file_range(*, workspace_id, file_id, start, count):
        assert workspace_id == ws
        return [
            chunk for chunk in by_file.get(file_id, []) if chunk["chunk_idx"] >= start
        ][:count]

    async def summaries(workspace_id, file_ids):
        assert workspace_id == ws
        return [file for file in snapshot["files"] if file["id"] in file_ids]

    async def empty_pending(*_args, **_kwargs):
        return pending.PendingSources()

    async def gateway(path, body, description):
        del description
        assert path == "/api/internal/documents/list"
        assert body["workspaceId"] == ws
        return {
            "items": [
                {"id": file["id"], "kind": "source_file", "editable": False}
                for file in snapshot["files"]
            ]
        }

    async def forbidden_pool():
        raise RuntimeError("unexpected DB access outside the read-only lab connection")

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
        assert ctx.workspace_id == ws
        ctx.user_id = "workspace-terminal-tencent"
        return await original_listing(args, ctx)

    tools._register("list_sources", list_sources)
    config_source = read(ROOT / "lab/playground/configs/chat.json")
    config_prompt = config_source.get("system_prompt")
    config_protocol = {
        "current_runtime": True,
        "terminal_instruction": False,
        "provider": "Tencent TokenHub",
        "model": "glm-5.3-flash",
        "thinking": "high",
        "config_sha256": sha(ROOT / "lab/playground/configs/chat.json"),
        "effective_prompt_sha256": sha_bytes((config_prompt or "").encode()),
        "tool_description_overrides": config_source.get("tool_descriptions") or {},
        "cases": [chosen[case_id] for case_id in chosen],
    }
    save(OUT / "fresh-protocol.json", config_protocol)
    spec = registry.resolve_pinned(
        snapshot["pin"]["embedding_provider_slug"],
        snapshot["pin"]["embedding_model_slug"],
        snapshot["pin"]["embedding_model_version"],
        registry.Slot.RETRIEVAL,
    )
    async with await psycopg.AsyncConnection.connect(
        opening.DSN,
        options=opening.OPTIONS,
        row_factory=dict_row,
        autocommit=True,
    ) as conn:
        await opening.verify_lab(conn, snapshot)

        async def search_variant(
            *, workspace_id, query, file_ids=None, top_k=None, stats=None
        ):
            assert workspace_id == ws
            vectors = await models.embed([models.format_query(query, spec)], spec=spec)
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
            limit = top_k or 5
            top = search._cap_per_file(
                [search.Passage.from_row(row) for row in rows], 4
            )[:limit]
            search._mark_tier_only(top, rows, limit, False)
            if stats is not None:
                stats.hits_lang = top[0].lang if top else "und"
                stats.query_terms, stats.cjk_runs = terms.terms, terms.cjk_runs
            return top

        tools.search = search_variant
        for case_id in ("workspace-opening-mayor", "workspace-opening-gpt20"):
            case = chosen[case_id]
            folder = OUT / "fresh" / case_id
            if (folder / "result.json").exists():
                continue
            config = playground.load_config("chat")
            config.update(
                target="lab",
                workspace_id=ws,
                curate=False,
                locale=case["language"],
                scope_file_ids=[
                    ws + "_" + source_id for source_id in case["scope_source_ids"]
                ]
                if case["scope_source_ids"]
                else None,
            )
            config["model"].update(
                provider_slug="zai",
                model_slug="glm-5.3-flash",
                version=1,
                thinking="high",
                adhoc={
                    "context_window_tokens": 200_000,
                    "thinking_levels": ["low", "high", "max"],
                    "default_thinking": "high",
                    "params": {"temperature": 0},
                },
                transport={
                    "url": "https://tokenhub.tencentcloudmaas.com/v1/chat/completions",
                    "key_env": "TENCENT_API_KEY",
                    "wire_model": "glm-5.3-flash",
                    "body": "zai",
                },
            )
            turn = playground.Turn(config, case["question"], [], resolver)
            turn.run_dir = turn.state["run_dir"] = folder
            folder.mkdir(parents=True, exist_ok=True)
            started, done, errors = time.perf_counter(), {}, []
            with (folder / "events.jsonl").open("w") as stream:
                async with asyncio.timeout(600):
                    async for event in turn.events():
                        if event.get("type") != "block_delta":
                            stream.write(json.dumps(event, ensure_ascii=False) + "\n")
                        if event.get("type") == "done":
                            done = event
                        elif event.get("type") == "error":
                            errors.append(event)
            record = read(folder / "run.json")
            result = {
                "id": case_id,
                "question": case["question"],
                "scope_source_ids": case["scope_source_ids"],
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "done": done,
                "errors": errors,
                "answer_text": openui.text_of(record["answer"]),
                "answer": record["answer"],
                "telemetry": record["telemetry"],
                "usage": record["usage"],
                "provider_calls": record["provider_calls"],
            }
            save(folder / "result.json", result)
            print(
                json.dumps(
                    {
                        "id": case_id,
                        "seconds": result["elapsed_seconds"],
                        "stop": result["telemetry"]["stopReason"],
                        "tools": result["telemetry"]["toolCallsByName"],
                        "answer_chars": len(result["answer"]),
                    }
                ),
                flush=True,
            )
        await opening.verify_lab(conn, snapshot)
    save(
        OUT / "fresh-verification.json",
        {
            "database_read_only": True,
            "lab_matches_snapshot": True,
            "container_was_left_running": True,
            "terminal_instruction_injected": False,
        },
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "run", "fresh"))
    args = parser.parse_args()
    if args.mode == "check":
        check()
    elif args.mode == "run":
        asyncio.run(run())
    else:
        asyncio.run(fresh())
