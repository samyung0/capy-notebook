"""Bounded source-page capture probe; no database, ingest or application writes.

Run with uv run --project pipeline python bench/rag/scripts/capture_visual_probe.py.
The default is an offline wiring check, not a model-compliance measurement.
--live uses the existing TOKENHUB credential, at most 5 calls/case.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pymupdf
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))

from pipeline import use_compatible_event_loop
from pipeline.elitellm import client as provider
from pipeline.prompts import chat
from pipeline.registry import ModelConfig
from pipeline.retrieval import agent, capture, pending, tools
from pipeline.retrieval.search import Passage
from pipeline.retrieval.stream import AssembledResponse, StreamEvent, ToolCall

SOURCES = ROOT / "bench/parsers/fixtures/local/2026-09-20-unseen-pdfs"
OUT = ROOT / "bench/rag/reports/local/2026-09-20-capture-visual-probe"
CASES = [
    (
        "openstax-precalculus-2e.pdf",
        21,
        "In Example 3, what is the exact function notation for March and its value?",
        "f(March) = 31.",
    ),
    (
        "nist-fips203.pdf",
        14,
        "In Mathematical Symbols, what is the exact expression with a power of 2 that defines q?",
        "q = 3329 = 2^8 * 13 + 1.",
    ),
    (
        "w3c-complex-table.pdf",
        1,
        "For the Blind row, how many ballots were completed and what was the accuracy?",
        "1 ballot; accuracy 34.5%, n=1.",
    ),
]


async def run_case(case: tuple, live: bool) -> dict:
    name, page, question, expected = case
    pdf = SOURCES / name
    with pymupdf.open(pdf) as doc:
        text = doc[page - 1].get_text()
    ctx = tools.ToolContext(
        workspace_id="offline-probe", operations=frozenset({"source.read"})
    )
    assert "capture_page" in {s["function"]["name"] for s in tools.schemas_for(ctx)}
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {
                "id": "f_1",
                "name": name,
                "chapter_id": None,
                "chunks": 1,
                "status": "ready",
            }
        ],
    }
    passage = Passage(
        chunk_id="c1",
        file_id="f_1",
        file_name=name,
        chunk_idx=0,
        section_path="",
        text=text,
        hit_text=text,
        page_start=page,
        page_end=page,
        confidence=1.0,
    )
    spec = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM-5.3-Flash",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        thinking_levels=("low", "high", "max"),
        default_thinking="low",
        context_window_tokens=100_000,
        slots=("chat",),
    )
    requests, calls = [], []

    async def no_pending(*args, **kwargs):
        return pending.PendingSources()

    async def scope(*args, **kwargs):
        return SimpleNamespace(file_ids=["f_1"], file_names=[name])

    async def render(*args):
        _, file_id, p, bbox, edge = args
        assert file_id == "f_1" and p == page
        return capture.render(pdf, p, bbox, edge)

    async def dispatch(tool, args, context):
        calls.append({"tool": tool, "args": args})
        if tool == "capture_page":
            return await tools._capture_page(args, context)
        if tool in {"read_document", "search_workspace"}:
            return tools.ToolResult(passages=[passage])
        if tool in {"list_sources", "describe_documents"}:
            return tools.ToolResult(
                text_parts=[f"{name}, file_id=f_1, relevant PDF page {page}."]
            )
        return tools.ToolResult(
            text_parts=["Unavailable in this read-only probe."], refused=True
        )

    async def stream(messages, *, model, tools=None, on_event=None, **kwargs):
        assert len(requests) < 5, "five-request case budget reached"
        assert chat.CAPTURE_RULE in messages[0]["content"]
        image_count = sum(
            1
            for m in messages
            if isinstance(m.get("content"), list)
            for part in m["content"]
            if part.get("type") == "image_url"
        )
        if live:
            key = dotenv_values(ROOT / ".env.local").get("TOKENHUB")
            if not key:
                raise RuntimeError("TOKENHUB credential unavailable")
            body = provider.zai_request(
                spec,
                messages,
                temperature=0,
                tools=tools,
                response_format=kwargs.get("response_format"),
                max_tokens=3000,
                thinking="low",
                stream=False,
                tool_choice=None,
            )
            async with httpx.AsyncClient(timeout=55) as client:
                response = await client.post(
                    provider.TENCENT_CHAT_URL,
                    json=body,
                    headers={"Authorization": "Bearer " + key},
                )
                response.raise_for_status()
                raw = response.json()
            message = raw["choices"][0]["message"]
            response_calls = [
                ToolCall(
                    id=c["id"],
                    name=c["function"]["name"],
                    arguments=c["function"]["arguments"],
                )
                for c in message.get("tool_calls", [])
            ]
            answer = message.get("content") or ""
            result = AssembledResponse(
                text=answer, tool_calls=response_calls, provider_message=message
            )
        else:
            stage = len(requests)
            scripted = [
                ToolCall("read", "read_document", '{"file_id":"f_1"}'),
                ToolCall(
                    "capture",
                    "capture_page",
                    json.dumps({"file_id": "f_1", "page": page}),
                ),
            ]
            result = (
                AssembledResponse(tool_calls=[scripted[stage]])
                if stage < 2
                else AssembledResponse(
                    text=json.dumps({"answer": [{"text": expected, "passages": [1]}]})
                )
            )
        requests.append(
            {
                "images": image_count,
                "tool_calls": [c.name for c in result.tool_calls],
                "answer": result.text,
            }
        )
        if on_event and result.text:
            on_event(StreamEvent(kind="text", text=result.text))
        return result

    with (
        patch.object(pending, "load", no_pending),
        patch.object(tools, "_resolve_scope", scope),
        patch.object(capture, "render_file", render),
        patch.object(tools, "run", dispatch),
        patch.object(agent.models, "stream_agent_response", stream),
    ):
        events = [
            event
            async for event in agent.run_agent(
                query=f"Use file_id f_1 ({name}), PDF page {page}. {question}",
                ctx=ctx,
                history=None,
                model=spec,
            )
        ]
    images_seen = any(r["images"] for r in requests)
    captured = bool(ctx.captures)
    if not live:
        assert captured and images_seen, events
        assert events[-1].get("answer") == expected + " [1]", events[-1]
    return {
        "file": name,
        "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
        "page": page,
        "confidence": passage.confidence,
        "question": question,
        "expected_reference": expected,
        "captured": captured,
        "image_delivered": images_seen,
        "requests": requests,
        "calls": calls,
        "answer": events[-1].get("answer"),
        "captures": [{k: v for k, v in c.items() if k != "jpeg"} for c in ctx.captures],
    }


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    for case in CASES:
        result = await run_case(case, args.live)
        results.append(result)
        (OUT / ("live.json" if args.live else "offline.json")).write_text(
            json.dumps(
                {
                    "mode": "live-tokenhub" if args.live else "scripted-offline",
                    "capture_rule": chat.CAPTURE_RULE,
                    "results": results,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        print(
            json.dumps(
                {
                    "file": result["file"],
                    "captured": result["captured"],
                    "image_delivered": result["image_delivered"],
                    "answer": result["answer"],
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    use_compatible_event_loop()
    asyncio.run(main())
