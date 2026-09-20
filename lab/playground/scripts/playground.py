"""Local agentic-loop playground.

Runs the production chat agent (pipeline.retrieval.agent) in this process against
the lab or UAT index. The system prompt, offered tools, tool caps, model, search
knobs, capture_page mode and extraction-confidence notes come from a JSON config
edited in the browser and saved under configs/. Read tools only; the search
telemetry write is disabled. Every turn is recorded under local/runs/.

  uv run --with pymupdf==1.28.2 python lab/playground/scripts/playground.py --target lab

`--ledger local/runs/<id>/run.json` starts curate turns from that run's stored
ledger, which is how a follow-up turn on the same conversation is tested.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    CONFIGS,
    LOCAL,
    REPO,
    ROOT,
    TARGETS,
    PdfResolver,
    ensure_tunnel,
    prepare_environment,
)
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    Response,
    StreamingResponse,
)

RUNS = LOCAL / "runs"
# Curate turns read the shared library and write materials. Production derives
# document.edit from the actor's role; the playground grants it so the prompt's
# "grow the note with edit_document" rhythm is actually available.
CURATE_OPERATIONS = frozenset(
    {"source.read", "material.read", "material.create", "document.edit", "library.read"}
)
KNOWLEDGE_TOOLS = (
    "search_knowledge",
    "browse_knowledge",
    "read_knowledge",
    "capture_knowledge_page",
    "create_ledger",
)
ALLOWED_TOOLS = {
    "search_workspace",
    "list_sources",
    "describe_documents",
    "read_document",
    "capture_page",
    *KNOWLEDGE_TOOLS,
    "create_material",
    "inspect_document",
    "edit_document",
}
DEFAULT_CONFIG: dict[str, Any] = {
    "target": "lab",
    "workspace_id": "odl_eval_odl",
    "scope_file_ids": None,
    "locale": "en",
    # curate: run the real curate loop (library tools, curate prompt, progress
    # ledger, stall guard) and write materials as files under the run directory.
    "curate": False,
    # ledger: path to a stored ledger (a previous run.json, or its `ledger`) the
    # turn continues, the way the gateway hands one back on a follow-up turn.
    # --ledger sets it for every config that does not carry its own.
    "ledger": None,
    # transport: send this pin to another OpenAI-compatible endpoint instead of the
    # production route, e.g. {"url": ".../v1/chat/completions", "key_env": "TENCENT_API_KEY",
    # "wire_model": "glm-5.3-flash", "body": "zai"}. body picks the request builder.
    "model": {
        "provider_slug": "deepseek",
        "model_slug": "deepseek-v4-flash-vision-exp",
        "version": 1,
        "thinking": "instant",
        "transport": None,
    },
    # null keeps the production system prompt; a string replaces it wholesale.
    "system_prompt": None,
    "prompt_addon": "",
    "tools": [
        "search_workspace",
        "list_sources",
        "describe_documents",
        "read_document",
    ],
    # knowledge_tools_per_response and stall_responses are the curate caps
    # (KNOWLEDGE_TOOLS_PER_RESPONSE, CURATE_STALL_RESPONSES); the other three
    # bound ordinary chat, which curate ignores.
    "limits": {
        "planning_responses": 12,
        "tools_per_response": 4,
        "tools_per_turn": 12,
        "captures_per_turn": 3,
        "knowledge_tools_per_response": 6,
        "stall_responses": 4,
    },
    "search": {"top_k": 5, "per_file_cap": 4},
    "capture": {
        "mode": "pixels",
        "max_edge": 1568,
        "require_seen_page": True,
        "ocr_route": "docparse",
        "question_aware": True,
        "caption_prompt": (
            "This is a region of a study document. A student asked: {question}\n"
            "Transcribe every fact in the image that bears on that question exactly as printed "
            "(numbers, labels, units, table rows, formulas). Then state anything else the region "
            "shows in one short paragraph. Do not add information that is not visible."
        ),
        "addon": True,
        # OpenAI-only density switch (low | high | auto); other providers ignore it.
        "detail": None,
        # page: a capture of a page that retrieved passages already cite reuses their
        # numbers and adds no citation; new: every capture is its own citation.
        "citation": "page",
    },
    # input_limit_tokens forces compaction/checkpoints at a small budget for testing;
    # null keeps the model's real usable input limit.
    "context": {"input_limit_tokens": None},
    "quality": {
        "show": False,
        "only_below": 1.01,
        "template": " [extraction confidence {score:.2f}: {reasons}]",
    },
    # citations: as_is | renumber | structured (see citations.py)
    "answer": {"citations": "as_is"},
}


def merged(raw: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(DEFAULT_CONFIG)
    for key, value in raw.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key].update(value)
        else:
            out[key] = value
    return out


def load_config(name: str) -> dict[str, Any]:
    return merged(json.loads((CONFIGS / f"{name}.json").read_text(encoding="utf-8")))


def model_spec(model: dict[str, Any]):
    """A model_configs row by pin, or an ad-hoc pin for a model the catalog lacks
    (`adhoc` carries the row fields; the provider still needs its platform key)."""
    from pipeline import registry

    adhoc = model.get("adhoc")
    if not adhoc:
        return registry.registry.get(
            model["provider_slug"], model["model_slug"], int(model["version"])
        )
    return registry.ModelConfig(
        version=int(model.get("version") or 1),
        provider_name=adhoc.get("provider_name") or model["provider_slug"],
        model_name=adhoc.get("model_name") or model["model_slug"],
        provider_slug=model["provider_slug"],
        model_slug=model["model_slug"],
        platform_enabled=True,
        params=adhoc.get("params") or {"temperature": 0.3},
        slots=(registry.Slot.CHAT, registry.Slot.CAPTIONING),
        thinking_levels=tuple(
            adhoc.get("thinking_levels") or ("instant", "low", "mid", "high", "max")
        ),
        default_thinking=model.get("thinking") or "instant",
        context_window_tokens=int(adhoc.get("context_window_tokens") or 200000),
    )


def effective_prompt(c: dict[str, Any], base: str | None = None) -> str:
    """The exact system prompt a turn sends: production text (curate mode has its
    own), or the config's replacement, then the addon, then the capture_page rule."""
    import capture
    import citations

    from pipeline.prompts import chat as chat_prompts
    from pipeline.prompts import curate as curate_prompts

    if base is None:
        base = (curate_prompts if c["curate"] else chat_prompts).system_prompt(
            c["locale"]
        )
    text = c["system_prompt"] or base
    use_capture = capture.NAME in c["tools"] and c["capture"]["addon"]
    # A curate answer is plain prose listing the materials; it has no citations.
    structured = c["answer"]["citations"] == "structured" and not c["curate"]
    return (
        text
        + (c["prompt_addon"] or "")
        + (capture.ADDON if use_capture else "")
        + (citations.STRUCTURED_ADDON if structured else "")
    )


def material_id(assistant_message_id: str, call_id: str) -> str:
    """The deterministic id Go mints for a chat-created material."""
    digest = hashlib.sha256(f"{assistant_message_id}\n{call_id}".encode()).hexdigest()
    return "mat_" + digest[:16]


def merge_books(
    existing: list[dict[str, Any]], incoming: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """What Go does with an edit's provenance: merge by book id, union the excerpts."""
    merged = {book["id"]: dict(book) for book in existing}
    for book in incoming:
        current = merged.setdefault(book["id"], {**book, "excerptIds": []})
        current["excerptIds"] = sorted(
            {*current.get("excerptIds", []), *book.get("excerptIds", [])}
        )
    return list(merged.values())


async def create_material_locally(
    args: dict[str, Any], ctx, state: dict[str, Any], message_id: str
):
    """create_material without a gateway: the material lands as JSON under the run
    directory and the model gets the receipt the gateway would have returned.

    The ledger rules (ledger first, an open todo id, only excerpts this turn
    read) are the production helpers, not a copy of them."""
    from pipeline.retrieval import tools

    kind, call_id = str(args.get("kind") or ""), str(args.get("_tool_call_id") or "")
    prepared = await tools.curate_write(ctx, "create_material", args)
    if isinstance(prepared, tools.ToolResult):
        return prepared
    books, todo = prepared
    rid, title = material_id(message_id, call_id), str(args.get("title") or "").strip()
    record = {
        "id": rid,
        "kind": kind,
        "title": title,
        "content": args.get("content") or "",
        "cards": args.get("cards") or [],
        "questions": args.get("questions") or [],
        "excerpt_ids": [str(e) for e in (args.get("excerpt_ids") or [])],
        "provenance": {"books": books} if books else None,
        "size": tools._material_size(kind, args),
        "edits": [],
    }
    state["materials"].append(record)
    write_material(state, record)
    result = tools._receipt_result(
        {
            "outcome": "succeeded",
            "effect": {
                "operation": "created",
                "resource": {
                    "kind": "material",
                    "id": rid,
                    "title": title,
                    "materialKind": kind,
                },
            },
        }
    )
    tools.note_created(ctx, result.effects[0], kind, args, todo)
    return result


async def edit_material_locally(args: dict[str, Any], ctx, state: dict[str, Any]):
    """edit_document against a material this run created: the commands are appended
    to its file and the appended section's provenance merges into the material's."""
    from pipeline.retrieval import tools

    target = args.get("target") or {}
    rid = str(target.get("id") or "")
    record = next((m for m in state["materials"] if m["id"] == rid), None)
    if record is None or target.get("kind") != "material":
        return tools._refused(
            f"edit_document: {rid} is not a material this run created.",
            code="unavailable_target",
        )
    prepared = await tools.curate_write(ctx, "edit_document", args)
    if isinstance(prepared, tools.ToolResult):
        return prepared
    books, todo = prepared
    commands = list(args.get("commands") or [])
    record["edits"].extend(commands)
    record["content"] = "\n".join(
        part
        for part in [record["content"], *(str(c.get("text") or "") for c in commands)]
        if part
    )
    record["size"] = tools._material_size(record["kind"], record)
    record["excerpt_ids"] = sorted(
        {*record["excerpt_ids"], *(str(e) for e in (args.get("excerpt_ids") or []))}
    )
    if books:
        existing = (record["provenance"] or {}).get("books") or []
        record["provenance"] = {"books": merge_books(existing, books)}
    write_material(state, record)
    result = tools._receipt_result(
        {
            "outcome": "succeeded",
            "effect": {
                "operation": "edited",
                "resource": {
                    "kind": "material",
                    "id": rid,
                    "title": record["title"],
                    "materialKind": record["kind"],
                },
            },
        }
    )
    tools.note_appended(ctx, rid, len(commands), todo)
    return result


def ledger_state(ledger) -> dict[str, Any]:
    """The ledger two ways. The top level is the turn as the model sees it: every
    todo with the id the rendered ledger shows, plus this turn's reads and
    progress. `stored` is what the gateway would persist at turn end - the
    newest 24 open todos, the last 5 requests and 50 materials - so watching it
    shrink is how the bound is checked. `--ledger` and the config's `ledger`
    field read `stored`, so a follow-up turn starts where a real one would."""
    return {
        "requests": list(ledger.requests),
        "next_todo_id": ledger.next_todo_id,
        "todos": [
            {"id": t.id, "text": t.text, "done": t.done, "materialId": t.material_id}
            for t in ledger.todos
        ],
        "materials": [
            {
                "id": m.id,
                "kind": m.kind,
                "title": m.title,
                "size": m.size,
                "todo": m.todo,
            }
            for m in ledger.materials
        ],
        "progress": ledger.progress,
        "reads": [
            {"excerpt_id": r.excerpt_id, "start": r.start, "section": r.section}
            for r in ledger.reads
        ],
        "stored": ledger.stored(),
    }


def starting_ledger(path: str | None):
    """The ledger a run starts from: a previous run.json, or a bare stored
    ledger. Without one the conversation starts with an empty ledger."""
    from pipeline.retrieval import tools

    if not path:
        return tools.Ledger()
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    ledger = raw.get("ledger", raw)
    return tools.Ledger.from_stored(ledger.get("stored", ledger))


def save_knowledge_capture(
    state: dict[str, Any], ctx, call_id: str, run_id: str
) -> dict[str, Any]:
    """capture_knowledge_page renders through the production tool, which keeps its
    JPEG on the ToolContext; put it on disk in the shape the page already renders."""
    import base64

    entry = next((cap for cap in ctx.captures if cap["callId"] == call_id), None)
    label, url = ctx.pending_images.get(call_id, ("", ""))
    if entry is None or not url:
        return {"type": "capture_missing", "call_id": call_id}
    n = len(state["captures"]) + 1
    path = state["run_dir"] / "captures" / f"{n}.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(base64.b64decode(url.split(",", 1)[1]))
    record = {
        "n": n,
        "call_id": call_id,
        "file_id": entry["fileId"],
        "page": entry["page"],
        "bbox": entry["bbox"],
        "mode": "pixels",
        "image": str(path.relative_to(LOCAL)),
        "image_bytes": entry["bytes"],
        "image_px": entry["pixels"],
        "est_image_tokens": entry["estimatedImageTokens"],
        "label": label,
        "text": "",
    }
    state["captures"].append(record)
    return {"type": "capture", **record, "url": f"/api/runs/{run_id}/captures/{n}.jpg"}


def write_material(state: dict[str, Any], record: dict[str, Any]) -> None:
    path = state["run_dir"] / "materials" / f"{record['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


def load_quality(target: str, workspace_id: str) -> dict[str, Any]:
    path = LOCAL / "quality" / f"{target}-{workspace_id}.json"
    return (
        json.loads(path.read_text(encoding="utf-8"))["chunks"] if path.exists() else {}
    )


class Turn:
    """One question through the patched agent. Patches are process-global, so
    the server runs one turn at a time."""

    def __init__(
        self,
        config: dict[str, Any],
        question: str,
        history: list[dict[str, Any]],
        resolver: PdfResolver,
        checkpoint: dict[str, Any] | None = None,
    ):
        self.config, self.question, self.history, self.resolver = (
            config,
            question,
            history,
            resolver,
        )
        self.checkpoint = checkpoint
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self.run_dir = RUNS / self.id
        self.state: dict[str, Any] = {
            "run_dir": self.run_dir,
            "captures": [],
            "images": {},
            "calls": [],
            "provider_calls": [],
            "extra": [],
            "_result_call": {},
            "compactions": [],
            "materials": [],
            "ledger": {},
            "stall_events": [],
        }

    async def events(self):
        import capture
        import citations

        from pipeline import elitellm, obs, registry
        from pipeline.config import cfg
        from pipeline.elitellm import client as llm_client
        from pipeline.prompts import chat as chat_prompts
        from pipeline.prompts import curate as curate_prompts
        from pipeline.retrieval import agent, compact, models, search, store, tools
        from pipeline.retrieval.chunking import estimate_tokens

        c, state = self.config, self.state
        curate = bool(c["curate"])
        spec = model_spec(c["model"])
        registry.bind_request_llm(thinking=c["model"]["thinking"])
        registry.set_job_pins(registry.JobPins(captioning=spec))
        obs.set_trace(obs.new_trace_id())
        obs.start_usage()
        offered = set(c["tools"])
        use_capture = capture.NAME in offered
        handler = (
            capture.make_handler(c, self.resolver, state, self.question)
            if use_capture
            else None
        )
        quality = (
            load_quality(c["target"], c["workspace_id"]) if c["quality"]["show"] else {}
        )
        ctx = tools.ToolContext(
            workspace_id=c["workspace_id"],
            user_id="playground" if curate else "",
            curate=curate,
            operations=CURATE_OPERATIONS
            if curate
            else frozenset({"source.read", "material.read"}),
            file_ids=c["scope_file_ids"] or None,
            assistant_message_id=self.id,
            ledger=starting_ledger(c["ledger"] if curate else None),
        )
        saved = {
            "system_prompt": chat_prompts.system_prompt,
            "curate_prompt": curate_prompts.system_prompt,
            "schemas_for": tools.schemas_for,
            "run": tools.run,
            "store_ledger": tools.store_ledger,
            "mutates": tools.mutates,
            "render": tools.render_result,
            "stream": models.stream_agent_response,
            "record": store.record_search_events,
            "location": search.Passage.location,
            "llm_stream": elitellm.stream,
            "llm_complete": elitellm.complete,
            "usable_input_limit": compact.usable_input_limit,
            "summarize": compact.summarize_checkpoint,
            "agent_caps": (
                agent.PLANNING_RESPONSES,
                agent.TOOLS_PER_RESPONSE,
                agent.TOOLS_PER_TURN,
            ),
            "curate_caps": (
                agent.KNOWLEDGE_TOOLS_PER_RESPONSE,
                agent.CURATE_STALL_RESPONSES,
            ),
            "cfg": (
                cfg.agent_max_steps,
                cfg.search_top_k,
                cfg.search_per_file_cap,
                cfg.captures_per_turn,
            ),
        }

        def system_prompt(locale):
            base = saved["curate_prompt" if curate else "system_prompt"](locale)
            return effective_prompt(c, base)

        def schemas_for(ctx_):
            out = [
                s
                for s in saved["schemas_for"](ctx_)
                if s["function"]["name"] in offered
            ]
            return out + ([capture.SCHEMA] if use_capture else [])

        async def run(name, args, ctx_):
            record = {
                "sequence": len(state["calls"]),
                "name": name,
                "call_id": args.get("_tool_call_id"),
                "args": {k: v for k, v in args.items() if not k.startswith("_")},
            }
            state["calls"].append(record)
            started = time.perf_counter()
            problem = (
                tools.contract.validate_args(name, record["args"])
                if name in tools.contract.DEFINITIONS
                else None
            )
            if name not in offered:
                result = tools._refused(
                    f"{name} is not offered in this configuration.",
                    code="unsupported_operation",
                )
            elif name == capture.NAME:
                result = await handler(args, ctx_)
                if (
                    state["captures"]
                    and state["captures"][-1]["call_id"] == record["call_id"]
                ):
                    cap = state["captures"][-1]
                    state["extra"].append(
                        {
                            "type": "capture",
                            **cap,
                            "url": f"/api/runs/{self.id}/captures/{cap['n']}.jpg",
                        }
                    )
            elif problem:
                result = tools._refused(problem)
            elif name == "create_material":
                result = await create_material_locally(args, ctx_, state, self.id)
            elif name == "edit_document":
                result = await edit_material_locally(args, ctx_, state)
            else:
                result = await saved["run"](name, args, ctx_)
            if result.effects:
                rid = (result.effects[0].get("resource") or {}).get("id")
                written = next((m for m in state["materials"] if m["id"] == rid), None)
                if written is not None:
                    state["extra"].append({"type": "material", **written})
            if name == "capture_knowledge_page" and not result.refused:
                state["extra"].append(
                    save_knowledge_capture(state, ctx_, record["call_id"], self.id)
                )
            record.update(
                elapsed_seconds=round(time.perf_counter() - started, 3),
                outcome=result.outcome,
                error=result.error,
                passages=[p.chunk_id for p in result.passages],
            )
            state["_result_call"][id(result)] = record
            return result

        async def store_ledger(ctx_):
            """There is no gateway to store the ledger in: run.json is where a
            follow-up run reads it back from (`--ledger`)."""
            state["ledger"] = ledger_state(ctx_.ledger)

        def mutates(name):
            return False if name == capture.NAME else saved["mutates"](name)

        def render_result(result, numbered):
            text = saved["render"](result, numbered)
            record = state["_result_call"].get(id(result))
            if record is not None:
                shown = tools.limit_tool_result(text)
                record.update(text_sent_to_model=shown, truncated=shown != text)
                state["extra"].append(
                    {
                        "type": "tool_text",
                        "callId": record["call_id"],
                        "name": record["name"],
                        "text": shown,
                    }
                )
            return text

        transport = c["model"].get("transport")
        structured = c["answer"]["citations"] == "structured"
        builders = {
            "zai": llm_client.zai_request,
            "openai": llm_client.openai_chat_request,
            "deepseek": llm_client.deepseek_request,
        }

        async def llm_stream(model, messages, **kw):
            """Route this turn's pin to the configured endpoint; enforce JSON only on
            tool-less calls, because a tool-capable call under json_object skips tools."""
            if (
                model.pin == spec.pin
                and structured
                and not kw.get("tools")
                and kw.get("response_format") is None
            ):
                kw["response_format"] = {"type": "json_object"}
            if model.pin != spec.pin or not transport:
                async for chunk in saved["llm_stream"](model, messages, **kw):
                    yield chunk
                return
            key = os.environ.get(transport["key_env"], "")
            if not key:
                raise RuntimeError(
                    f"{transport['key_env']} is not set for the transport override"
                )
            temperature = kw.get("temperature")
            body = builders[transport.get("body", "zai")](
                model,
                messages,
                temperature=model.temperature() if temperature is None else temperature,
                tools=kw.get("tools"),
                response_format=kw.get("response_format"),
                max_tokens=kw.get("max_tokens"),
                thinking=llm_client._thinking_for_call(model, kw.get("reasoning")),
                stream=True,
                tool_choice=kw.get("tool_choice"),
            )
            body["model"] = transport.get("wire_model") or model.model_slug
            async for event in llm_client._stream_sse(
                transport["url"], llm_client._bearer(key), body
            ):
                yield llm_client._as_obj(event)

        async def llm_complete(model, messages, **kw):
            """Non-streaming twin of llm_stream (captions in `caption` mode)."""
            if model.pin != spec.pin or not transport:
                return await saved["llm_complete"](model, messages, **kw)
            key = os.environ.get(transport["key_env"], "")
            if not key:
                raise RuntimeError(
                    f"{transport['key_env']} is not set for the transport override"
                )
            temperature = kw.get("temperature")
            body = builders[transport.get("body", "zai")](
                model,
                messages,
                temperature=model.temperature() if temperature is None else temperature,
                tools=kw.get("tools"),
                response_format=kw.get("response_format"),
                max_tokens=kw.get("max_tokens"),
                thinking=llm_client._thinking_for_call(model, kw.get("reasoning")),
                stream=False,
                tool_choice=kw.get("tool_choice"),
            )
            body["model"] = transport.get("wire_model") or model.model_slug
            return llm_client._as_obj(
                await llm_client._post_json(
                    transport["url"], llm_client._bearer(key), body
                )
            )

        limit_override = c["context"]["input_limit_tokens"]

        def usable_input_limit(model, **kw):
            """Force the agent's compaction threshold only; the summarizer's own
            fit check (it passes max_tokens) keeps the real limit."""
            real = saved["usable_input_limit"](model, **kw)
            if limit_override and kw.get("max_tokens") is None:
                return min(real, int(limit_override))
            return real

        async def summarize_checkpoint(**kw):
            started = time.perf_counter()
            summary = await saved["summarize"](**kw)
            record = {
                "purpose": kw.get("purpose", "checkpoint"),
                "turns_folded": len(kw.get("turns") or []),
                "kind": getattr(
                    kw.get("build"), "__name__", "checkpoint_messages"
                ).removesuffix("_messages"),
                "prior_summary_tokens": estimate_tokens(kw.get("prior_summary") or ""),
                "summary_tokens": estimate_tokens(summary),
                "elapsed_seconds": round(time.perf_counter() - started, 2),
                "summary": summary,
            }
            state["compactions"].append(record)
            state["extra"].append({"type": "compaction", **record})
            return summary

        def context_breakdown(messages, tools):
            """Estimated tokens by part of the request, the production estimator's
            total, and the limit the compactor enforces."""
            parts = {
                "system": 0,
                "memory": 0,
                "history": 0,
                "query": 0,
                "assistant": 0,
                "tool_results": 0,
            }
            counts = {"tool_results": 0, "images": 0}
            after_query = False
            for m in messages:
                role, kind, content = m.get("role"), m.get("_kind"), m.get("content")
                if isinstance(content, list):
                    text = " ".join(
                        p.get("text", "")
                        for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                    )
                    counts["images"] += sum(
                        1
                        for p in content
                        if isinstance(p, dict)
                        and p.get("type") in ("image_url", "image")
                    )
                else:
                    text = content or ""
                tokens = estimate_tokens(text)
                if role == "assistant" and m.get("tool_calls"):
                    tokens += estimate_tokens(json.dumps(m["tool_calls"]))
                if role == "system":
                    parts["system"] += tokens
                elif kind == "memory":
                    parts["memory"] += tokens
                elif kind == "query":
                    parts["query"] += tokens
                    after_query = True
                elif role == "tool":
                    parts["tool_results"] += tokens
                    counts["tool_results"] += 1
                else:
                    parts["assistant" if after_query else "history"] += tokens
            attached = set(state["images"]) | set(ctx.pending_images)
            parts["images_est"] = sum(
                cap.get("est_image_tokens", 0)
                for cap in state["captures"]
                if cap["call_id"] in attached
            )
            measured = models.measure_request_context(messages, model=spec, tools=tools)
            parts["schemas"] = measured.tool_tokens
            return {
                "parts": parts,
                "counts": counts,
                "estimated_total": measured.total_tokens + parts["images_est"],
                "limit": usable_input_limit(spec),
            }

        async def stream(messages, **kw):
            started = time.perf_counter()
            state["last_messages"] = list(messages)
            request = capture.inject_images(
                messages, state["images"], spec.provider_slug, c["capture"]["detail"]
            )
            context = context_breakdown(request, kw.get("tools"))
            call = len(state["provider_calls"]) + 1
            if curate:
                state["ledger"] = ledger_state(ctx.ledger)
                state["extra"].append(
                    {"type": "ledger", "call": call, **state["ledger"]}
                )
                if kw.get("tools") is None:
                    # In curate the only way tools go off is the stall guard (or
                    # the terminal call after credits run out).
                    stall = {
                        "call": call,
                        "progress": ctx.ledger.progress,
                        "todos_done": sum(1 for t in ctx.ledger.todos if t.done),
                        "todos": len(ctx.ledger.todos),
                    }
                    state["stall_events"].append(stall)
                    state["extra"].append({"type": "stall", **stall})
            try:
                assembled = await saved["stream"](request, **kw)
            except Exception as exc:
                # The agent maps every provider failure to a generic client error;
                # keep the real text so the page can show it.
                state["last_error"] = f"{type(exc).__name__}: {exc}"[:600]
                raise
            usage = assembled.usage
            state["provider_calls"].append(
                {
                    "elapsed_seconds": round(time.perf_counter() - started, 3),
                    "input_tokens": usage.input_tokens,
                    "output_tokens": usage.output_tokens,
                    "cached_read_tokens": usage.cached_read_tokens,
                    "reasoning_tokens": usage.reasoning_tokens,
                    "tool_calls": [call.name for call in assembled.tool_calls],
                    "images_attached": len(state["images"]),
                    "response_format": bool(structured and not kw.get("tools")),
                    "transport": transport["url"] if transport else "production",
                    "context": context,
                }
            )
            state["extra"].append(
                {
                    "type": "context",
                    "call": len(state["provider_calls"]),
                    "reported_input": usage.input_tokens,
                    "cached_read": usage.cached_read_tokens,
                    **context,
                }
            )
            return assembled

        async def record_search_events(events):
            return None

        def location(passage):
            base = saved["location"](passage)
            q = quality.get(passage.chunk_id)
            if (
                q
                and q.get("score") is not None
                and q["score"] < c["quality"]["only_below"]
            ):
                base += c["quality"]["template"].format(
                    score=q["score"],
                    reasons="; ".join(q["reasons"]) or "no issue found",
                )
            return base

        chat_prompts.system_prompt = curate_prompts.system_prompt = system_prompt
        tools.schemas_for, tools.run, tools.store_ledger = (
            schemas_for,
            run,
            store_ledger,
        )
        tools.mutates, tools.render_result, models.stream_agent_response = (
            mutates,
            render_result,
            stream,
        )
        store.record_search_events, search.Passage.location = (
            record_search_events,
            location,
        )
        elitellm.stream, elitellm.complete = llm_stream, llm_complete
        compact.usable_input_limit, compact.summarize_checkpoint = (
            usable_input_limit,
            summarize_checkpoint,
        )
        agent.PLANNING_RESPONSES, agent.TOOLS_PER_RESPONSE, agent.TOOLS_PER_TURN = (
            c["limits"]["planning_responses"],
            c["limits"]["tools_per_response"],
            c["limits"]["tools_per_turn"],
        )
        agent.KNOWLEDGE_TOOLS_PER_RESPONSE, agent.CURATE_STALL_RESPONSES = (
            c["limits"]["knowledge_tools_per_response"],
            c["limits"]["stall_responses"],
        )
        (
            cfg.agent_max_steps,
            cfg.search_top_k,
            cfg.search_per_file_cap,
            cfg.captures_per_turn,
        ) = (
            c["limits"]["planning_responses"],
            c["search"]["top_k"],
            c["search"]["per_file_cap"],
            c["limits"]["captures_per_turn"],
        )
        self.run_dir.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        recorded: list[dict[str, Any]] = []
        # A curate turn carries no citations at all.
        mode = "as_is" if curate else c["answer"]["citations"]
        blocks: dict[str, str] = {}
        renum: citations.Renumberer | None = None
        version = 0
        final_answer: str | None = None

        def final_citations(order: list[int]) -> dict[str, Any]:
            nonlocal version
            version += 1
            used = [ctx.citations[n - 1].as_citation() for n in order]
            unused = [
                p.as_citation()
                for i, p in enumerate(ctx.citations)
                if i + 1 not in order
            ]
            return {
                "type": "citations",
                "version": version,
                "final": True,
                "citations": used,
                "unused": unused,
            }

        async def structured_answer(raw: str) -> tuple[str, list[int], dict[str, Any]]:
            items = citations.parse_structured(raw)
            note: dict[str, Any] = {"repaired": False, "parse_failed": False}
            if items is None and state.get("last_messages"):
                note["repaired"] = True
                repair = state["last_messages"] + [
                    {"role": "assistant", "content": raw},
                    {"role": "user", "content": citations.REPAIR_PROMPT},
                ]
                assembled = await models.stream_agent_response(
                    repair, model=spec, tools=None
                )
                items = citations.parse_structured(assembled.text)
                state["repair_raw"] = assembled.text
            if items is None:
                note["parse_failed"] = True
                return raw, [], note
            text, order = citations.render_structured(items, len(ctx.citations))
            return text, order, note

        async def shaped(event: dict[str, Any]):
            """Apply the citation mode to one agent event; may yield several."""
            nonlocal renum, final_answer, version
            t = event.get("type")
            if t == "citations":
                version = max(version, event.get("version", 0))
            if t == "error" and state.get("last_error"):
                event = {**event, "detail": state["last_error"]}
            if mode == "as_is" or t == "citations":
                yield event
                return
            if t == "block_start":
                blocks[event["blockId"]] = ""
                renum = citations.Renumberer(lambda: len(ctx.citations))
                yield event
            elif t == "block_delta":
                blocks[event["blockId"]] = (
                    blocks.get(event["blockId"], "") + event["text"]
                )
                if mode == "renumber" and renum is not None:
                    out = renum.push(event["text"])
                    if out:
                        yield {**event, "text": out}
                else:
                    yield event
            elif t == "block_end":
                raw = blocks.get(event["blockId"], "")
                if mode == "renumber" and renum is not None:
                    tail = renum.flush()
                    if tail:
                        yield {
                            "type": "block_delta",
                            "blockId": event["blockId"],
                            "text": tail,
                        }
                    yield event
                    if event.get("kind") == "answer":
                        final_answer, order = citations.renumber(
                            raw, len(ctx.citations)
                        )
                        yield final_citations(order)
                elif event.get("kind") == "answer":
                    text, order, note = await structured_answer(raw)
                    final_answer = text
                    yield event
                    yield {
                        "type": "answer_rendered",
                        "blockId": event["blockId"],
                        "text": text,
                        **note,
                    }
                    yield final_citations(order)
                else:
                    yield event
            elif t == "error" and state.get("last_error"):
                yield {**event, "detail": state["last_error"]}
            elif t == "done":
                if final_answer is not None:
                    yield {
                        **event,
                        "answer_raw": event.get("answer", ""),
                        "answer": final_answer,
                    }
                else:
                    yield event
            else:
                yield event

        try:
            async for raw_event in agent.run_agent(
                query=self.question,
                ctx=ctx,
                history=self.history,
                model=spec,
                locale=c["locale"],
                checkpoint=self.checkpoint,
            ):
                for extra in state["extra"]:
                    recorded.append(extra)
                    yield extra
                state["extra"].clear()
                async for event in shaped(raw_event):
                    if event.get("type") != "block_delta":
                        recorded.append(event)
                    yield event
        except Exception as exc:  # noqa: BLE001 - keep the failed turn on disk
            event = {
                "type": "error",
                "code": "harness_exception",
                "message": f"{type(exc).__name__}: {exc}",
            }
            recorded.append(event)
            yield event
        finally:
            chat_prompts.system_prompt, curate_prompts.system_prompt = (
                saved["system_prompt"],
                saved["curate_prompt"],
            )
            tools.schemas_for, tools.run, tools.store_ledger = (
                saved["schemas_for"],
                saved["run"],
                saved["store_ledger"],
            )
            tools.mutates, tools.render_result, models.stream_agent_response = (
                saved["mutates"],
                saved["render"],
                saved["stream"],
            )
            store.record_search_events, search.Passage.location = (
                saved["record"],
                saved["location"],
            )
            elitellm.stream, elitellm.complete = (
                saved["llm_stream"],
                saved["llm_complete"],
            )
            compact.usable_input_limit, compact.summarize_checkpoint = (
                saved["usable_input_limit"],
                saved["summarize"],
            )
            agent.PLANNING_RESPONSES, agent.TOOLS_PER_RESPONSE, agent.TOOLS_PER_TURN = (
                saved["agent_caps"]
            )
            agent.KNOWLEDGE_TOOLS_PER_RESPONSE, agent.CURATE_STALL_RESPONSES = saved[
                "curate_caps"
            ]
            (
                cfg.agent_max_steps,
                cfg.search_top_k,
                cfg.search_per_file_cap,
                cfg.captures_per_turn,
            ) = saved["cfg"]
            registry.set_job_pins(None)
        done = next((e for e in reversed(recorded) if e.get("type") == "done"), {})
        usage = obs.current_usage()
        summary = {
            "id": self.id,
            "started_unix": time.time() - (time.perf_counter() - started),
            "elapsed_seconds": round(time.perf_counter() - started, 2),
            "config": c,
            "question": self.question,
            "history": self.history,
            "system_prompt": system_prompt(c["locale"]),
            "answer": done.get("answer", ""),
            "answer_raw": done.get("answer_raw"),
            "repair_raw": state.get("repair_raw"),
            "citation_mode": mode,
            "telemetry": done.get("telemetry"),
            "citations": next(
                (
                    e["citations"]
                    for e in reversed(recorded)
                    if e.get("type") == "citations"
                ),
                [],
            ),
            "usage": usage.as_dict() if usage is not None else None,
            "provider_calls": state["provider_calls"],
            "calls": state["calls"],
            "captures": state["captures"],
            "compactions": state["compactions"],
            "checkpoint_in": self.checkpoint,
            "events": recorded,
            # Curate: what the loop read and wrote. Materials carry their own
            # provenance books, which is the attribution a real material keeps.
            "curate": curate,
            "ledger": ledger_state(ctx.ledger),
            "stall_events": state["stall_events"],
            "materials": state["materials"],
        }
        (self.run_dir / "run.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        yield {
            "type": "run_saved",
            "id": self.id,
            "elapsed_seconds": summary["elapsed_seconds"],
            "usage": summary["usage"],
        }


def build_app(target: str):
    from pipeline.config import cfg
    from pipeline.retrieval import library, store

    # There is no gateway here: create_material and edit_document are handled in
    # process and write files. This only makes tool admission decide as it does
    # in production, so the offered tools match what a real turn would see.
    cfg.gateway_url = cfg.gateway_url or "http://playground.invalid"
    cfg.pipeline_secret = cfg.pipeline_secret or "playground"
    app = FastAPI(title="Capy agentic playground")
    resolver = PdfResolver(target)
    turn_lock = asyncio.Lock()

    async def library_summary() -> dict[str, Any] | None:
        """What curate turns read: the live library's current books, their
        excerpts and the topic catalog, or None when no library URL is set."""
        if not library.enabled():
            return None
        pool = await library.pool()
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT (SELECT count(*) FROM library_books) AS books, "
                "(SELECT count(*) FROM library_excerpts e JOIN library_books b ON b.content_id = e.content_id) AS excerpts, "
                "(SELECT count(*) FROM library_topics) AS topics"
            )
            row = await cur.fetchone()
        return dict(row)

    async def reconnect() -> None:
        """Reopen the ingest-host tunnel if it died since the last request, and
        drop both pools when it did: their connections went with the old tunnel."""
        if target != "local" and ensure_tunnel():
            await store.close_pool()
            await library.close_pool()

    @app.on_event("shutdown")
    async def close_library():
        await library.close_pool()

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (ROOT / "scripts/ui.html").read_text(encoding="utf-8")

    @app.get("/api/state")
    async def state():
        await reconnect()
        pool = await store.pool()
        async with pool.connection() as conn:
            cur = await conn.execute(
                "SELECT provider_slug, model_slug, version, thinking_levels, default_thinking, capabilities, platform_enabled "
                "FROM model_configs WHERE enabled AND 'chat' = ANY(slots) ORDER BY 1, 2, 3"
            )
            models = [dict(r) for r in await cur.fetchall()]
            cur = await conn.execute(
                "SELECT w.id, w.name, count(f.id) AS files, (SELECT count(*) FROM rag_chunks c WHERE c.workspace_id = w.id) AS chunks "
                "FROM workspaces w LEFT JOIN files f ON f.workspace_id = w.id AND f.trashed_at IS NULL GROUP BY 1, 2 ORDER BY 4 DESC, 2"
            )
            workspaces = [dict(r) for r in await cur.fetchall()]
        quality = sorted(p.name for p in (LOCAL / "quality").glob(f"{target}-*.json"))
        return {
            "target": target,
            "configs": sorted(p.stem for p in CONFIGS.glob("*.json")),
            "defaults": DEFAULT_CONFIG,
            "models": models,
            "workspaces": workspaces,
            "library": await library_summary(),
            "quality_files": quality,
            "runs": sorted(
                (p.name for p in RUNS.glob("*/run.json") for p in [p.parent]),
                reverse=True,
            )[:200],
        }

    @app.get("/api/workspaces/{workspace_id}/files")
    async def files(workspace_id: str):
        outline = await store.workspace_outline(workspace_id)
        return [
            {
                "id": f["id"],
                "name": f["name"],
                "chunks": f["chunks"],
                "status": f["status"],
            }
            for f in outline["files"]
        ]

    @app.get("/api/configs/{name}")
    def get_config(name: str):
        path = CONFIGS / f"{name}.json"
        if not path.exists():
            raise HTTPException(404)
        return {
            "raw": json.loads(path.read_text(encoding="utf-8")),
            "effective": load_config(name),
        }

    @app.put("/api/configs/{name}")
    async def put_config(name: str, request: Request):
        if not name.replace("-", "").replace("_", "").isalnum():
            raise HTTPException(400, "config names are letters, digits, - and _")
        raw = await request.json()
        merged(raw)
        (CONFIGS / f"{name}.json").write_text(
            json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return {"saved": name}

    @app.post("/api/prompt")
    async def prompt(request: Request):
        """The two layers a turn sends: the system prompt and the tools array."""
        import capture

        from pipeline.retrieval import contract, tools

        c = merged(await request.json())
        if c["curate"]:
            # The pinned version's topic catalog rides in the knowledge tool
            # descriptions, so this reads the library exactly as a turn does.
            ctx = tools.ToolContext(
                workspace_id=c["workspace_id"],
                user_id="playground",
                curate=True,
                operations=CURATE_OPERATIONS,
            )
            await tools.load_library_catalog(ctx)
            schemas = [
                s for s in tools.schemas_for(ctx) if s["function"]["name"] in c["tools"]
            ]
        else:
            schemas = [
                contract.model_schema(name)
                for name in c["tools"]
                if name in contract.DEFINITIONS
            ]
        if capture.NAME in c["tools"]:
            schemas.append(capture.SCHEMA)
        return {"prompt": effective_prompt(c), "tools": schemas}

    @app.post("/api/turn")
    async def turn(request: Request):
        await reconnect()
        body = await request.json()
        config = merged(body["config"])
        if config["target"] != target:
            raise HTTPException(
                400,
                f"this server runs against {target}; the config targets {config['target']}",
            )

        async def relay():
            async with turn_lock:
                run = Turn(
                    config,
                    body["question"],
                    body.get("history") or [],
                    resolver,
                    body.get("checkpoint"),
                )
                async for event in run.events():
                    yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

        return StreamingResponse(relay(), media_type="text/event-stream")

    @app.get("/api/runs/{run_id}")
    def get_run(run_id: str):
        path = RUNS / run_id / "run.json"
        if not path.exists():
            raise HTTPException(404)
        return FileResponse(path)

    @app.get("/api/runs/{run_id}/captures/{name}")
    def get_capture(run_id: str, name: str):
        path = RUNS / run_id / "captures" / name
        if not path.exists():
            raise HTTPException(404)
        return FileResponse(path)

    @app.get("/api/page")
    async def page(file_id: str, page: int, bbox: str | None = None):
        import capture

        box = [float(v) for v in bbox.split(",")] if bbox else None
        try:
            jpeg, _ = capture.render(await resolver.path(file_id), page, box, 1400)
        except (KeyError, ValueError) as exc:
            raise HTTPException(404, str(exc)) from exc
        return Response(jpeg, media_type="image/jpeg")

    return app


def check() -> None:
    assert merged({"limits": {"tools_per_turn": 3}})["limits"] == {
        **DEFAULT_CONFIG["limits"],
        "tools_per_turn": 3,
    }
    assert merged({"system_prompt": "x"})["system_prompt"] == "x"
    assert (
        material_id("m_1", "call_1")
        == material_id("m_1", "call_1")
        != material_id("m_1", "call_2")
    )
    for path in CONFIGS.glob("*.json"):
        c = merged(json.loads(path.read_text(encoding="utf-8")))
        assert c["target"] in TARGETS and c["capture"]["mode"] in (
            "pixels",
            "ocr",
            "caption",
        ), path
        assert c["answer"]["citations"] in ("as_is", "renumber", "structured"), path
        assert c["capture"]["citation"] in ("page", "new"), path
        assert set(c["tools"]) <= ALLOWED_TOOLS, path
        assert c["ledger"] is None or isinstance(c["ledger"], str), path
        knowledge = set(c["tools"]) & set(KNOWLEDGE_TOOLS)
        assert c["curate"] or not knowledge, f"{path}: knowledge tools need curate"
        assert not c["curate"] or knowledge, (
            f"{path}: a curate config offers no knowledge tool"
        )
        # Without create_ledger a curate turn cannot write anything at all.
        assert not c["curate"] or "create_ledger" in c["tools"], (
            f"{path}: no create_ledger"
        )
    print("playground checks passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS), default="lab")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--ledger",
        help="start curate turns from this stored ledger (a previous run.json), "
        "for configs that do not set `ledger` themselves",
    )
    args = parser.parse_args()
    if args.check:
        check()
        return
    if args.ledger:
        DEFAULT_CONFIG["ledger"] = args.ledger
    dsn = prepare_environment(args.target)
    sys.path.insert(0, str(REPO / "pipeline"))
    import uvicorn

    from pipeline import registry

    registry.registry.start()
    print(
        f"target={args.target} dsn={dsn.split('@')[-1]} http://127.0.0.1:{args.port}",
        flush=True,
    )
    if sys.platform == "win32":
        # psycopg's async pool refuses the Proactor loop that uvicorn installs on
        # Windows, so serve on a selector loop of our own.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    config = uvicorn.Config(
        build_app(args.target),
        host="127.0.0.1",
        port=args.port,
        log_level="warning",
        loop="none",
    )
    asyncio.run(uvicorn.Server(config).serve())


if __name__ == "__main__":
    main()
