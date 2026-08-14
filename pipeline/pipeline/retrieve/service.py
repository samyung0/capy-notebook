"""Retrieval HTTP service. The Go gateway proxies /chat/stream and /generate here.

Chat runs a capped tool loop over the workspace index (see retrieval/agent.py).
Generation runs fixed workflows instead, because its output has to parse.

Run: ``uvicorn pipeline.retrieve.service:app --host 0.0.0.0 --port 8001``
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import obs, registry, use_compatible_event_loop
from ..config import cfg
from ..retrieval import models, store, workflows
from ..retrieval.agent import run_agent
from ..retrieval.locale import response_language_rule, rewrite_language_rule
from ..retrieval.tools import ToolContext
from .ai_adapter import router as plate_ai_router

obs.init_logging("retrieval")
obs.init_sentry("retrieval")

log = logging.getLogger("evo.retrieve")

# uvicorn imports this module before it builds its event loop, which is the only
# point at which the policy can still be chosen.
use_compatible_event_loop()


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry.registry.start()
    threading.Thread(
        target=registry.poll_forever, name="model-registry", daemon=True
    ).start()
    await store.pool()
    log.info(
        "retrieval up — query_model=%s embedding=%s tools=%s",
        cfg.query_model,
        cfg.embedding_model,
        "on" if cfg.gateway_url else "read-only",
    )
    try:
        yield
    finally:
        await store.close_pool()


app = FastAPI(title="Evo Notes retrieval", lifespan=lifespan)


@app.middleware("http")
async def request_context(request: Request, call_next):
    """Continue the gateway's trace and open a usage accumulator per request.

    A contextvar accumulator is what lets ``models.py`` capture tokens without
    every call site threading a ledger object through. Requests that never call
    a model simply finish with an empty one.
    """
    obs.set_trace(obs.parse_traceparent(request.headers.get(obs.TRACEPARENT_HEADER)))
    obs.start_usage()
    obs.bind_error_context()
    response = await call_next(request)
    response.headers["X-Request-Id"] = obs.trace_id()
    return response


app.include_router(plate_ai_router)


def _uid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


class ChatStreamReq(BaseModel):
    query: str
    workspaceId: str
    userId: str | None = None
    fileIds: list[str] | None = None
    model: str | None = None  # ignored; pin is modelKey + configVersion
    modelKey: str | None = None
    configVersion: int | None = None
    # Prior turns as OpenAI-style role/content pairs, sent to the LLM only.
    history: list[dict] | None = None
    # Account locale from the gateway (users.locale). Do not trust a browser field.
    locale: str | None = None


class GenerateReq(BaseModel):
    workspaceId: str
    kind: str = "quiz"  # flashcards | quiz | mindmap | diagram (summary: legacy)
    length: str | None = None
    format: str | None = None
    count: int | None = None
    style: str | None = None
    types: list[str] | None = None
    levels: list[str] | None = None  # cognitive levels: recall|application|analysis
    difficulty: list[str] | None = None  # legacy alias, still accepted
    chapters: list[str] | None = None
    fileIds: list[str] | None = None  # real files.id values, from the gateway
    detail: str | None = None  # mindmap: brief|standard|detailed
    diagramType: str | None = None  # diagram: auto|flowchart|sequence|class|state|er
    timeLimitMin: int | None = None
    locale: str | None = None
    modelKey: str | None = None
    configVersion: int | None = None


# Legacy easy/medium/hard -> cognitive level, so old callers keep working.
_LEVEL_ALIASES = {"easy": "recall", "medium": "application", "hard": "analysis"}
_VALID_LEVELS = {"recall", "application", "analysis"}

# What each cognitive level asks the LLM to write, so questions have a purpose
# instead of a vague difficulty knob.
_LEVEL_GUIDE = (
    "recall (remember a fact, term, or definition), "
    "application (use a concept or procedure to solve a problem), "
    "analysis (compare, break down, or reason about relationships between ideas)"
)


def _cognitive_levels(req: GenerateReq) -> list[str]:
    if req.levels:
        return [lvl for lvl in req.levels if lvl in _VALID_LEVELS] or [
            "recall",
            "application",
        ]
    if req.difficulty:
        return [_LEVEL_ALIASES.get(d, "application") for d in req.difficulty]
    return ["recall", "application"]


def _new_srs() -> dict:
    """Fresh FSRS 'new' state matching SrsState in src/api/types.ts."""
    from datetime import datetime, timezone

    return {
        "due": datetime.now(timezone.utc).isoformat(),
        "stability": 0,
        "difficulty": 0,
        "elapsed_days": 0,
        "scheduled_days": 0,
        "reps": 0,
        "lapses": 0,
        "state": 0,
        "learning_steps": 0,
    }


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "query_model": cfg.query_model,
        "embedding": cfg.embedding_model,
    }


async def _chat_events(req: ChatStreamReq, request: Request):
    ctx = ToolContext(
        workspace_id=req.workspaceId,
        user_id=req.userId or "",
        file_ids=list(req.fileIds or []),
    )
    try:
        async for event in run_agent(
            query=req.query,
            ctx=ctx,
            history=req.history,
            model=models.resolve_query_model(req.modelKey, req.configVersion),
            locale=req.locale,
        ):
            if await request.is_disconnected():
                break
            yield _sse(event)
    except Exception as exc:
        log.exception("chat stream failed")
        yield _sse({"type": "error", "message": str(exc)})


@app.post("/chat/stream")
async def chat_stream(req: ChatStreamReq, request: Request):
    return StreamingResponse(
        _chat_events(req, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------- AI completion
# Direct (non-RAG) LLM completion for the note editor: an AI command menu and
# Copilot-style "continue writing". Streams plain tokens in the same SSE shape
# as chat so the Go gateway relays them unchanged.


class CompleteReq(BaseModel):
    workspaceId: str
    mode: str = "command"  # command | continue
    prompt: str | None = None
    context: str | None = None
    model: str | None = None  # ignored; pin is modelKey + configVersion
    modelKey: str | None = None
    configVersion: int | None = None
    locale: str | None = None


def _complete_messages(req: CompleteReq) -> list[dict]:
    context = (req.context or "").strip()
    if req.mode == "continue":
        # Continuation matches the note, not the UI locale — forcing Chinese
        # onto an English paragraph would be worse than leaving it English.
        system = (
            "You are a writing assistant embedded in a note editor. Continue the "
            "user's note naturally from where it stops. Write only the continuation "
            "(no preamble, no repetition of the existing text). Match the existing tone."
        )
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": context or "(empty note)"},
        ]
    language = (
        rewrite_language_rule(req.locale)
        if context
        else response_language_rule(req.locale)
    )
    system = (
        "You are a writing assistant embedded in a note editor. Apply the user's "
        "instruction and return ONLY the resulting text to insert (no preamble, no "
        "code fences unless the instruction asks for code).\n" + language
    )
    user = f"Instruction: {(req.prompt or '').strip()}"
    if context:
        user += f"\n\nContent:\n{context}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


async def _complete_stream(req: CompleteReq, request: Request):
    model = models.resolve_query_model(
        req.modelKey, req.configVersion, surface=registry.SURFACE_EDITOR
    )
    try:
        async for token in models.stream_text(
            _complete_messages(req), model=model, temperature=0.7
        ):
            if await request.is_disconnected():
                break
            yield _sse({"type": "token", "text": token})
        done: dict[str, Any] = {"type": "done"}
        usage = obs.current_usage()
        if usage is not None and not usage.is_empty():
            done["usage"] = usage.as_dict()
        yield _sse(done)
    except Exception as e:
        log.exception("complete stream failed")
        yield _sse({"type": "error", "message": str(e)})


@app.post("/complete/stream")
async def complete_stream(req: CompleteReq, request: Request):
    return StreamingResponse(
        _complete_stream(req, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/ai/command")
async def ai_command(req: CompleteReq):
    """Non-streaming one-shot AI command (kept for parity with the gateway)."""
    try:
        text = await models.complete_text(
            _complete_messages(req),
            model=models.resolve_query_model(
                req.modelKey, req.configVersion, surface=registry.SURFACE_EDITOR
            ),
            temperature=0.7,
        )
        return {"text": text}
    except Exception as e:
        log.exception("ai command failed")
        return {"text": "", "error": str(e)}


# --------------------------------------------------------------- transcription


@app.post("/transcribe")
async def transcribe(file: Annotated[UploadFile, File()]):
    """Transcribe an uploaded audio blob via a Whisper-compatible STT provider."""
    spec = registry.resolve_pinned(None, None, registry.SURFACE_STT)
    try:
        client = models.client_for(spec)
        data = await file.read()
        text = ""
        duration_ms = 0
        try:
            resp = await client.audio.transcriptions.create(
                model=spec.provider_model_id,
                file=(file.filename or "audio.webm", data),
                response_format="verbose_json",
            )
            text = getattr(resp, "text", "") or ""
            duration_s = float(getattr(resp, "duration", 0) or 0)
            duration_ms = int(duration_s * 1000)
        except Exception:  # noqa: BLE001 - verbose_json is not universal
            resp = await client.audio.transcriptions.create(
                model=spec.provider_model_id,
                file=(file.filename or "audio.webm", data),
            )
            text = getattr(resp, "text", "") or ""
        if duration_ms <= 0 and data:
            # ~32 kbit/s floor so a provider that omits duration still bills.
            duration_ms = max(1000, (len(data) * 8) // 32)
        return {"text": text, "durationMillis": duration_ms}
    except Exception as e:
        log.exception("transcription failed")
        return {"text": "", "durationMillis": 0, "error": str(e)}


# ------------------------------------------------------------------- generate

_DIAGRAM_HEADER = {
    "flowchart": "flowchart TD",
    "sequence": "sequenceDiagram",
    "class": "classDiagram",
    "state": "stateDiagram-v2",
    "er": "erDiagram",
}


@app.post("/generate")
async def generate(req: GenerateReq) -> dict[str, Any]:
    """Produce a material and report what it cost.

    The usage envelope is attached here rather than inside each workflow so
    every generate kind reports it the same way, including the ones that
    map-reduce across files and therefore make many more model calls than the
    single-shot kinds.
    """
    payload = await _generate(req)
    usage = obs.current_usage()
    if usage is not None and not usage.is_empty():
        payload["usage"] = usage.as_dict()
    return payload


async def _generate(req: GenerateReq) -> dict[str, Any]:
    model = models.resolve_query_model(
        req.modelKey, req.configVersion, surface=registry.SURFACE_GENERATE
    )
    chapters = req.chapters or []
    file_ids = req.fileIds or []
    context, passages = await workflows.gather_context(
        workspace_id=req.workspaceId, file_ids=file_ids or None
    )
    file_names = sorted({p.file_name for p in passages})
    scope = workflows.scope_label(chapters, file_names)

    if req.kind == "summary":  # legacy; UI no longer offers this
        instruction = (
            "Write a concise study summary of the most important ideas in these "
            "sources. Use short bullet points."
        )
        if workflows.overflows(context, passages):
            body = await workflows.produce_mapped(
                instruction=instruction,
                passages=passages,
                scope=scope,
                model=model,
                combine=(
                    "Merge these per-document summaries into one bullet list, "
                    "removing duplicates and keeping the source distinctions clear."
                ),
                locale=req.locale,
            )
        else:
            body = await workflows.produce(
                instruction=instruction,
                context=context,
                scope=scope,
                model=model,
                locale=req.locale,
            )
        return {"kind": "summary", "title": "Workspace summary", "body": body}

    if req.kind == "flashcards":
        n = req.count or 10
        raw = await workflows.produce(
            instruction=(
                f"Create {n} study flashcards from these sources. Return ONLY a JSON "
                'array of objects {"front": "...", "back": "..."}. Each front is a '
                "single question or term; each back is a self-contained answer."
            ),
            context=context,
            scope=scope,
            model=model,
            locale=req.locale,
        )
        data = workflows.extract_json(raw) or []
        cards = [
            {
                "id": _uid("c"),
                "deckId": "generated",
                "front": str(item.get("front", "")),
                "back": str(item.get("back", "")),
                "known": False,
                "srs": _new_srs(),
            }
            for item in data
            if isinstance(item, dict)
        ]
        return {"kind": "flashcards", "cards": cards}

    if req.kind == "mindmap":
        detail = req.detail or "standard"
        raw = await workflows.produce(
            instruction=(
                "Create a Mermaid `mindmap` organizing the key concepts of these "
                f"sources and their relationships ({detail} level of detail). Return "
                "ONLY the Mermaid code starting with the line `mindmap` — no code "
                "fences, no prose."
            ),
            context=context,
            scope=scope,
            model=model,
            locale=req.locale,
        )
        code = workflows.strip_fence(raw) or "mindmap\n  root((Topic))"
        return {
            "kind": "mindmap",
            "title": "Mindmap",
            "content": f"# Mindmap\n\n```mermaid\n{code}\n```",
        }

    if req.kind == "diagram":
        dtype = (req.diagramType or "auto").lower()
        header = _DIAGRAM_HEADER.get(dtype)
        want = (
            f"a Mermaid `{header}` diagram"
            if header
            else "the most appropriate Mermaid diagram"
        )
        raw = await workflows.produce(
            instruction=(
                f"Create {want} that best illustrates the key ideas, processes or "
                "relationships in these sources. Return ONLY the Mermaid code (a "
                "valid diagram) — no code fences, no prose."
            ),
            context=context,
            scope=scope,
            model=model,
            locale=req.locale,
        )
        code = workflows.strip_fence(raw) or "flowchart LR\n  A --> B"
        return {
            "kind": "diagram",
            "title": "Diagram",
            "content": f"# Diagram\n\n```mermaid\n{code}\n```",
        }

    # quiz
    n = req.count or 5
    types = req.types or ["mcq"]
    levels = _cognitive_levels(req)
    raw = await workflows.produce(
        instruction=(
            f"Create a {n}-question quiz from these sources using question types "
            f'{types}. Tag each question with a cognitive "level" chosen from: '
            f"{_LEVEL_GUIDE}. Aim for a mix across these levels: {levels}, and make "
            "each question genuinely match the cognitive demand of its level. "
            "Return ONLY a JSON array of question objects. Each object has: "
            '"type" (one of mcq, multi, boolean, fill, short, ordering, matching), '
            '"level" (recall|application|analysis), "prompt", and the fields '
            "appropriate to its type (mcq/multi: options[] + correct[] indices; "
            "boolean: correct bool; fill/short: accepted[]; ordering: items[] in "
            "order; matching: pairs[] of {left,right}). For mcq and multi, each "
            'option MUST be an object {"value": "...", "explanation": "..."} where '
            "the explanation says why that option is correct or incorrect. For "
            "boolean, fill, short, ordering and matching, add a single "
            '"explanation" field for the question.'
        ),
        context=context,
        scope=scope,
        model=model,
        locale=req.locale,
    )
    questions = workflows.normalize_questions(
        workflows.extract_json(raw) or [], _LEVEL_ALIASES
    )
    return {
        "kind": "quiz",
        "name": "Workspace quiz",
        "chapters": chapters,
        "questions": questions,
        "timeLimitMin": req.timeLimitMin,
    }
