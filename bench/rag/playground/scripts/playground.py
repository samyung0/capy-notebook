"""Local agentic-loop playground.

Runs the production chat agent (pipeline.retrieval.agent) in this process against
the lab or UAT index. The system prompt, offered tools, tool caps, model, search
knobs, capture_page mode and extraction-confidence notes come from a JSON config
edited in the browser and saved under configs/. Read tools only; the search
telemetry write is disabled. Every turn is recorded under local/runs/.

  uv run --with pymupdf==1.28.2 python bench/rag/playground/scripts/playground.py --target lab
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CONFIGS, LOCAL, REPO, ROOT, TARGETS, PdfResolver, prepare_environment  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse  # noqa: E402

RUNS = LOCAL / "runs"
DEFAULT_CONFIG: dict[str, Any] = {
    "target": "lab",
    "workspace_id": "odl_eval_odl",
    "scope_file_ids": None,
    "locale": "en",
    # transport: send this pin to another OpenAI-compatible endpoint instead of the
    # production route, e.g. {"url": ".../v1/chat/completions", "key_env": "TENCENT_API_KEY",
    # "wire_model": "glm-5.3-flash", "body": "zai"}. body picks the request builder.
    "model": {"provider_slug": "deepseek", "model_slug": "deepseek-v4-flash-vision-exp", "version": 1, "thinking": "instant", "transport": None},
    # null keeps the production system prompt; a string replaces it wholesale.
    "system_prompt": None,
    "prompt_addon": "",
    "tools": ["search_workspace", "list_sources", "describe_documents", "read_document"],
    "limits": {"planning_responses": 12, "tools_per_response": 4, "tools_per_turn": 12, "captures_per_turn": 3},
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
    "quality": {"show": False, "only_below": 1.01, "template": " [extraction confidence {score:.2f}: {reasons}]"},
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
    return merged(json.loads((CONFIGS / f"{name}.json").read_text()))


def model_spec(model: dict[str, Any]):
    """A model_configs row by pin, or an ad-hoc pin for a model the catalog lacks
    (`adhoc` carries the row fields; the provider still needs its platform key)."""
    from pipeline import registry

    adhoc = model.get("adhoc")
    if not adhoc:
        return registry.registry.get(model["provider_slug"], model["model_slug"], int(model["version"]))
    return registry.ModelConfig(
        version=int(model.get("version") or 1),
        provider_name=adhoc.get("provider_name") or model["provider_slug"],
        model_name=adhoc.get("model_name") or model["model_slug"],
        provider_slug=model["provider_slug"],
        model_slug=model["model_slug"],
        platform_enabled=True,
        params=adhoc.get("params") or {"temperature": 0.3},
        slots=(registry.Slot.CHAT, registry.Slot.CAPTIONING),
        thinking_levels=tuple(adhoc.get("thinking_levels") or ("instant", "low", "mid", "high", "max")),
        default_thinking=model.get("thinking") or "instant",
        context_window_tokens=int(adhoc.get("context_window_tokens") or 200000),
    )


def effective_prompt(c: dict[str, Any], base: str | None = None) -> str:
    """The exact system prompt a turn sends: production text (or the config's
    replacement), then the addon, then the capture_page rule."""
    import capture
    import citations
    from pipeline.prompts import chat as chat_prompts

    text = c["system_prompt"] or base or chat_prompts.system_prompt(c["locale"])
    use_capture = capture.NAME in c["tools"] and c["capture"]["addon"]
    structured = c["answer"]["citations"] == "structured"
    return (
        text + (c["prompt_addon"] or "") + (capture.ADDON if use_capture else "")
        + (citations.STRUCTURED_ADDON if structured else "")
    )


def load_quality(target: str, workspace_id: str) -> dict[str, Any]:
    path = LOCAL / "quality" / f"{target}-{workspace_id}.json"
    return json.loads(path.read_text())["chunks"] if path.exists() else {}


class Turn:
    """One question through the patched agent. Patches are process-global, so
    the server runs one turn at a time."""

    def __init__(self, config: dict[str, Any], question: str, history: list[dict[str, Any]], resolver: PdfResolver, checkpoint: dict[str, Any] | None = None):
        self.config, self.question, self.history, self.resolver = config, question, history, resolver
        self.checkpoint = checkpoint
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self.run_dir = RUNS / self.id
        self.state: dict[str, Any] = {
            "run_dir": self.run_dir, "captures": [], "images": {}, "calls": [],
            "provider_calls": [], "extra": [], "_result_call": {}, "compactions": [],
        }

    async def events(self):
        import capture
        import citations
        from pipeline import elitellm, obs, registry
        from pipeline.config import cfg
        from pipeline.elitellm import client as llm_client
        from pipeline.prompts import chat as chat_prompts
        from pipeline.retrieval import agent, compact, models, search, store, tools
        from pipeline.retrieval.chunking import estimate_tokens

        c, state = self.config, self.state
        spec = model_spec(c["model"])
        registry.bind_request_llm(thinking=c["model"]["thinking"])
        registry.set_job_pins(registry.JobPins(captioning=spec))
        obs.set_trace(obs.new_trace_id())
        obs.start_usage()
        offered = set(c["tools"])
        use_capture = capture.NAME in offered
        handler = capture.make_handler(c, self.resolver, state, self.question) if use_capture else None
        quality = load_quality(c["target"], c["workspace_id"]) if c["quality"]["show"] else {}
        ctx = tools.ToolContext(
            workspace_id=c["workspace_id"],
            operations=frozenset({"source.read", "material.read"}),
            file_ids=c["scope_file_ids"] or None,
            assistant_message_id=self.id,
        )
        saved = {
            "system_prompt": chat_prompts.system_prompt, "schemas_for": tools.schemas_for, "run": tools.run,
            "mutates": tools.mutates, "render": tools.render_result, "stream": models.stream_agent_response,
            "record": store.record_search_events, "location": search.Passage.location, "llm_stream": elitellm.stream, "llm_complete": elitellm.complete,
            "usable_input_limit": compact.usable_input_limit, "summarize": compact.summarize_checkpoint,
            "agent_caps": (agent.PLANNING_RESPONSES, agent.TOOLS_PER_RESPONSE, agent.TOOLS_PER_TURN),
            "cfg": (cfg.agent_max_steps, cfg.search_top_k, cfg.search_per_file_cap),
        }

        def system_prompt(locale):
            return effective_prompt(c, saved["system_prompt"](locale))

        def schemas_for(ctx_):
            out = [s for s in saved["schemas_for"](ctx_) if s["function"]["name"] in offered]
            return out + ([capture.SCHEMA] if use_capture else [])

        async def run(name, args, ctx_):
            record = {
                "sequence": len(state["calls"]), "name": name, "call_id": args.get("_tool_call_id"),
                "args": {k: v for k, v in args.items() if not k.startswith("_")},
            }
            state["calls"].append(record)
            started = time.perf_counter()
            if name not in offered:
                result = tools._refused(f"{name} is not offered in this configuration.", code="unsupported_operation")
            elif name == capture.NAME:
                result = await handler(args, ctx_)
                if state["captures"] and state["captures"][-1]["call_id"] == record["call_id"]:
                    cap = state["captures"][-1]
                    state["extra"].append({"type": "capture", **cap, "url": f"/api/runs/{self.id}/captures/{cap['n']}.jpg"})
            else:
                result = await saved["run"](name, args, ctx_)
            record.update(
                elapsed_seconds=round(time.perf_counter() - started, 3), outcome=result.outcome,
                error=result.error, passages=[p.chunk_id for p in result.passages],
            )
            state["_result_call"][id(result)] = record
            return result

        def mutates(name):
            return False if name == capture.NAME else saved["mutates"](name)

        def render_result(result, numbered):
            text = saved["render"](result, numbered)
            record = state["_result_call"].get(id(result))
            if record is not None:
                shown = tools.limit_tool_result(text)
                record.update(text_sent_to_model=shown, truncated=shown != text)
                state["extra"].append({"type": "tool_text", "callId": record["call_id"], "name": record["name"], "text": shown})
            return text

        transport = c["model"].get("transport")
        structured = c["answer"]["citations"] == "structured"
        builders = {"zai": llm_client.zai_request, "openai": llm_client.openai_chat_request, "deepseek": llm_client.deepseek_request}

        async def llm_stream(model, messages, **kw):
            """Route this turn's pin to the configured endpoint; enforce JSON only on
            tool-less calls, because a tool-capable call under json_object skips tools."""
            if model.pin == spec.pin and structured and not kw.get("tools") and kw.get("response_format") is None:
                kw["response_format"] = {"type": "json_object"}
            if model.pin != spec.pin or not transport:
                async for chunk in saved["llm_stream"](model, messages, **kw):
                    yield chunk
                return
            key = os.environ.get(transport["key_env"], "")
            if not key:
                raise RuntimeError(f"{transport['key_env']} is not set for the transport override")
            temperature = kw.get("temperature")
            body = builders[transport.get("body", "zai")](
                model, messages, temperature=model.temperature() if temperature is None else temperature,
                tools=kw.get("tools"), response_format=kw.get("response_format"), max_tokens=kw.get("max_tokens"),
                thinking=llm_client._thinking_for_call(model, kw.get("reasoning")), stream=True, tool_choice=kw.get("tool_choice"),
            )
            body["model"] = transport.get("wire_model") or model.model_slug
            async for event in llm_client._stream_sse(transport["url"], llm_client._bearer(key), body):
                yield llm_client._as_obj(event)

        async def llm_complete(model, messages, **kw):
            """Non-streaming twin of llm_stream (captions in `caption` mode)."""
            if model.pin != spec.pin or not transport:
                return await saved["llm_complete"](model, messages, **kw)
            key = os.environ.get(transport["key_env"], "")
            if not key:
                raise RuntimeError(f"{transport['key_env']} is not set for the transport override")
            temperature = kw.get("temperature")
            body = builders[transport.get("body", "zai")](
                model, messages, temperature=model.temperature() if temperature is None else temperature,
                tools=kw.get("tools"), response_format=kw.get("response_format"), max_tokens=kw.get("max_tokens"),
                thinking=llm_client._thinking_for_call(model, kw.get("reasoning")), stream=False, tool_choice=kw.get("tool_choice"),
            )
            body["model"] = transport.get("wire_model") or model.model_slug
            return llm_client._as_obj(await llm_client._post_json(transport["url"], llm_client._bearer(key), body))

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
                "purpose": kw.get("purpose", "checkpoint"), "turns_folded": len(kw.get("turns") or []),
                "prior_summary_tokens": estimate_tokens(kw.get("prior_summary") or ""),
                "summary_tokens": estimate_tokens(summary), "elapsed_seconds": round(time.perf_counter() - started, 2),
                "summary": summary,
            }
            state["compactions"].append(record)
            state["extra"].append({"type": "compaction", **record})
            return summary

        def context_breakdown(messages, tools):
            """Estimated tokens by part of the request, the production estimator's
            total, and the limit the compactor enforces."""
            parts = {"system": 0, "memory": 0, "history": 0, "query": 0, "assistant": 0, "tool_results": 0}
            counts = {"tool_results": 0, "images": 0}
            after_query = False
            for m in messages:
                role, kind, content = m.get("role"), m.get("_kind"), m.get("content")
                if isinstance(content, list):
                    text = " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
                    counts["images"] += sum(1 for p in content if isinstance(p, dict) and p.get("type") in ("image_url", "image"))
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
            attached = {cid for cid in state["images"]}
            parts["images_est"] = sum(cap.get("est_image_tokens", 0) for cap in state["captures"] if cap["call_id"] in attached)
            measured = models.measure_request_context(messages, model=spec, tools=tools)
            parts["schemas"] = measured.tool_tokens
            return {
                "parts": parts, "counts": counts,
                "estimated_total": measured.total_tokens + parts["images_est"],
                "limit": usable_input_limit(spec),
            }

        async def stream(messages, **kw):
            started = time.perf_counter()
            state["last_messages"] = list(messages)
            request = capture.inject_images(messages, state["images"], spec.provider_slug, c["capture"]["detail"])
            context = context_breakdown(request, kw.get("tools"))
            try:
                assembled = await saved["stream"](request, **kw)
            except Exception as exc:
                # The agent maps every provider failure to a generic client error;
                # keep the real text so the page can show it.
                state["last_error"] = f"{type(exc).__name__}: {exc}"[:600]
                raise
            usage = assembled.usage
            state["provider_calls"].append({
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
                "cached_read_tokens": usage.cached_read_tokens, "reasoning_tokens": usage.reasoning_tokens,
                "tool_calls": [call.name for call in assembled.tool_calls], "images_attached": len(state["images"]),
                "response_format": bool(structured and not kw.get("tools")), "transport": transport["url"] if transport else "production",
                "context": context,
            })
            state["extra"].append({"type": "context", "call": len(state["provider_calls"]), "reported_input": usage.input_tokens,
                                   "cached_read": usage.cached_read_tokens, **context})
            return assembled

        async def record_search_events(events):
            return None

        def location(passage):
            base = saved["location"](passage)
            q = quality.get(passage.chunk_id)
            if q and q.get("score") is not None and q["score"] < c["quality"]["only_below"]:
                base += c["quality"]["template"].format(score=q["score"], reasons="; ".join(q["reasons"]) or "no issue found")
            return base

        chat_prompts.system_prompt, tools.schemas_for, tools.run = system_prompt, schemas_for, run
        tools.mutates, tools.render_result, models.stream_agent_response = mutates, render_result, stream
        store.record_search_events, search.Passage.location = record_search_events, location
        elitellm.stream, elitellm.complete = llm_stream, llm_complete
        compact.usable_input_limit, compact.summarize_checkpoint = usable_input_limit, summarize_checkpoint
        agent.PLANNING_RESPONSES, agent.TOOLS_PER_RESPONSE, agent.TOOLS_PER_TURN = (
            c["limits"]["planning_responses"], c["limits"]["tools_per_response"], c["limits"]["tools_per_turn"])
        cfg.agent_max_steps, cfg.search_top_k, cfg.search_per_file_cap = (
            c["limits"]["planning_responses"], c["search"]["top_k"], c["search"]["per_file_cap"])
        self.run_dir.mkdir(parents=True, exist_ok=True)
        started = time.perf_counter()
        recorded: list[dict[str, Any]] = []
        mode = c["answer"]["citations"]
        blocks: dict[str, str] = {}
        renum: citations.Renumberer | None = None
        version = 0
        final_answer: str | None = None

        def final_citations(order: list[int]) -> dict[str, Any]:
            nonlocal version
            version += 1
            used = [ctx.citations[n - 1].as_citation() for n in order]
            unused = [p.as_citation() for i, p in enumerate(ctx.citations) if i + 1 not in order]
            return {"type": "citations", "version": version, "final": True, "citations": used, "unused": unused}

        async def structured_answer(raw: str) -> tuple[str, list[int], dict[str, Any]]:
            items = citations.parse_structured(raw)
            note: dict[str, Any] = {"repaired": False, "parse_failed": False}
            if items is None and state.get("last_messages"):
                note["repaired"] = True
                repair = state["last_messages"] + [
                    {"role": "assistant", "content": raw}, {"role": "user", "content": citations.REPAIR_PROMPT}]
                assembled = await models.stream_agent_response(repair, model=spec, tools=None)
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
                blocks[event["blockId"]] = blocks.get(event["blockId"], "") + event["text"]
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
                        yield {"type": "block_delta", "blockId": event["blockId"], "text": tail}
                    yield event
                    if event.get("kind") == "answer":
                        final_answer, order = citations.renumber(raw, len(ctx.citations))
                        yield final_citations(order)
                elif event.get("kind") == "answer":
                    text, order, note = await structured_answer(raw)
                    final_answer = text
                    yield event
                    yield {"type": "answer_rendered", "blockId": event["blockId"], "text": text, **note}
                    yield final_citations(order)
                else:
                    yield event
            elif t == "error" and state.get("last_error"):
                yield {**event, "detail": state["last_error"]}
            elif t == "done":
                if final_answer is not None:
                    yield {**event, "answer_raw": event.get("answer", ""), "answer": final_answer}
                else:
                    yield event
            else:
                yield event

        try:
            async for raw_event in agent.run_agent(query=self.question, ctx=ctx, history=self.history, model=spec, locale=c["locale"], checkpoint=self.checkpoint):
                for extra in state["extra"]:
                    recorded.append(extra)
                    yield extra
                state["extra"].clear()
                async for event in shaped(raw_event):
                    if event.get("type") != "block_delta":
                        recorded.append(event)
                    yield event
        except Exception as exc:  # noqa: BLE001 - keep the failed turn on disk
            event = {"type": "error", "code": "harness_exception", "message": f"{type(exc).__name__}: {exc}"}
            recorded.append(event)
            yield event
        finally:
            chat_prompts.system_prompt, tools.schemas_for, tools.run = saved["system_prompt"], saved["schemas_for"], saved["run"]
            tools.mutates, tools.render_result, models.stream_agent_response = saved["mutates"], saved["render"], saved["stream"]
            store.record_search_events, search.Passage.location = saved["record"], saved["location"]
            elitellm.stream, elitellm.complete = saved["llm_stream"], saved["llm_complete"]
            compact.usable_input_limit, compact.summarize_checkpoint = saved["usable_input_limit"], saved["summarize"]
            agent.PLANNING_RESPONSES, agent.TOOLS_PER_RESPONSE, agent.TOOLS_PER_TURN = saved["agent_caps"]
            cfg.agent_max_steps, cfg.search_top_k, cfg.search_per_file_cap = saved["cfg"]
            registry.set_job_pins(None)
        done = next((e for e in reversed(recorded) if e.get("type") == "done"), {})
        usage = obs.current_usage()
        summary = {
            "id": self.id, "started_unix": time.time() - (time.perf_counter() - started),
            "elapsed_seconds": round(time.perf_counter() - started, 2), "config": c, "question": self.question,
            "history": self.history, "system_prompt": system_prompt(c["locale"]),
            "answer": done.get("answer", ""), "answer_raw": done.get("answer_raw"), "repair_raw": state.get("repair_raw"),
            "citation_mode": mode, "telemetry": done.get("telemetry"),
            "citations": next((e["citations"] for e in reversed(recorded) if e.get("type") == "citations"), []),
            "usage": usage.as_dict() if usage is not None else None, "provider_calls": state["provider_calls"],
            "calls": state["calls"], "captures": state["captures"], "compactions": state["compactions"],
            "checkpoint_in": self.checkpoint, "events": recorded,
        }
        (self.run_dir / "run.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
        yield {"type": "run_saved", "id": self.id, "elapsed_seconds": summary["elapsed_seconds"], "usage": summary["usage"]}


def build_app(target: str):
    from pipeline.retrieval import store

    app = FastAPI(title="Capy agentic playground")
    resolver = PdfResolver(target)
    turn_lock = asyncio.Lock()

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (ROOT / "scripts/ui.html").read_text()

    @app.get("/api/state")
    async def state():
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
            "target": target, "configs": sorted(p.stem for p in CONFIGS.glob("*.json")), "defaults": DEFAULT_CONFIG,
            "models": models, "workspaces": workspaces, "quality_files": quality,
            "runs": sorted((p.name for p in RUNS.glob("*/run.json") for p in [p.parent]), reverse=True)[:200],
        }

    @app.get("/api/workspaces/{workspace_id}/files")
    async def files(workspace_id: str):
        outline = await store.workspace_outline(workspace_id)
        return [{"id": f["id"], "name": f["name"], "chunks": f["chunks"], "status": f["status"]} for f in outline["files"]]

    @app.get("/api/configs/{name}")
    def get_config(name: str):
        path = CONFIGS / f"{name}.json"
        if not path.exists():
            raise HTTPException(404)
        return {"raw": json.loads(path.read_text()), "effective": load_config(name)}

    @app.put("/api/configs/{name}")
    async def put_config(name: str, request: Request):
        if not name.replace("-", "").replace("_", "").isalnum():
            raise HTTPException(400, "config names are letters, digits, - and _")
        raw = await request.json()
        merged(raw)
        (CONFIGS / f"{name}.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n")
        return {"saved": name}

    @app.post("/api/prompt")
    async def prompt(request: Request):
        """The two layers a turn sends: the system prompt and the tools array."""
        import capture
        from pipeline.retrieval import contract

        c = merged(await request.json())
        schemas = [contract.model_schema(name) for name in c["tools"] if name in contract.DEFINITIONS]
        if capture.NAME in c["tools"]:
            schemas.append(capture.SCHEMA)
        return {"prompt": effective_prompt(c), "tools": schemas}

    @app.post("/api/turn")
    async def turn(request: Request):
        body = await request.json()
        config = merged(body["config"])
        if config["target"] != target:
            raise HTTPException(400, f"this server runs against {target}; the config targets {config['target']}")

        async def relay():
            async with turn_lock:
                run = Turn(config, body["question"], body.get("history") or [], resolver, body.get("checkpoint"))
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
    assert merged({"limits": {"tools_per_turn": 3}})["limits"] == {**DEFAULT_CONFIG["limits"], "tools_per_turn": 3}
    assert merged({"system_prompt": "x"})["system_prompt"] == "x"
    for path in CONFIGS.glob("*.json"):
        c = merged(json.loads(path.read_text()))
        assert c["target"] in TARGETS and c["capture"]["mode"] in ("pixels", "ocr", "caption"), path
        assert c["answer"]["citations"] in ("as_is", "renumber", "structured"), path
        assert c["capture"]["citation"] in ("page", "new"), path
        assert set(c["tools"]) <= {"search_workspace", "list_sources", "describe_documents", "read_document", "capture_page"}, path
    print("playground checks passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=sorted(TARGETS), default="lab")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    dsn = prepare_environment(args.target)
    sys.path.insert(0, str(REPO / "pipeline"))
    import uvicorn

    from pipeline import registry

    registry.registry.start()
    print(f"target={args.target} dsn={dsn.split('@')[-1]} http://127.0.0.1:{args.port}", flush=True)
    uvicorn.run(build_app(args.target), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
