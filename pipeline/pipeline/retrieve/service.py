"""Retrieval HTTP service. The Go gateway proxies /chat/stream, /generate and /quiz-grade here.

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
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .. import obs, registry, use_compatible_event_loop
from ..config import cfg
from ..retrieval import accounting, models, store, workflows
from ..retrieval.agent import run_agent
from ..retrieval.chunking import clip_to_tokens
from ..retrieval.locale import response_language_rule, rewrite_language_rule
from ..retrieval.tools import ToolContext
from . import quiz_grade as quiz_grade_mod
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
    # Embedding is deliberately absent: it is a per-workspace pin now, not a
    # process-wide choice, so there is no single value to report here.
    log.info(
        "retrieval up — query_model=%s tools=%s",
        cfg.query_model,
        "on" if cfg.gateway_url else "read-only",
    )
    try:
        yield
    finally:
        await store.close_pool()


app = FastAPI(title="Evo Notes retrieval", lifespan=lifespan)

_SECRET_HEADER = "X-Pipeline-Secret"
_PUBLIC_PATHS = {"/healthz"}


def pipeline_secret_ok(got: str) -> bool:
    expected = cfg.pipeline_secret
    return (
        bool(expected)
        and len(got) == len(expected)
        and secrets.compare_digest(got, expected)
    )


@app.middleware("http")
async def require_pipeline_secret(request: Request, call_next):
    if request.url.path in _PUBLIC_PATHS:
        return await call_next(request)
    if not pipeline_secret_ok(request.headers.get(_SECRET_HEADER, "")):
        return JSONResponse({"message": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.exception_handler(models.UserKeyError)
async def user_key_error_handler(_request: Request, exc: models.UserKeyError):
    return JSONResponse({"code": exc.code, "message": exc.message}, status_code=400)


@app.exception_handler(workflows.GenerateEmpty)
async def generate_empty_handler(_request: Request, exc: workflows.GenerateEmpty):
    return JSONResponse(
        {"code": "generate_empty", "message": str(exc)}, status_code=502
    )


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


class LLMPin(BaseModel):
    modelKey: str | None = None
    configVersion: int | None = None
    userId: str | None = None
    paidBy: str | None = None
    reasoningMode: str | None = None
    reasoningEffort: str | None = None


def _bind_llm(req: LLMPin) -> None:
    registry.bind_request_llm(
        req.userId, req.paidBy, req.reasoningMode, req.reasoningEffort
    )


class ChatStreamReq(LLMPin):
    query: str
    workspaceId: str
    fileIds: list[str] | None = None
    model: str | None = None  # ignored; pin is modelKey + configVersion
    # Prior turns as OpenAI-style role/content pairs, sent to the LLM only.
    history: list[dict] | None = None
    checkpoint: dict | None = None
    assistantMessageId: str | None = None
    spendSessionId: str
    # Account locale from the gateway (users.locale). Do not trust a browser field.
    locale: str | None = None


class GenerateReq(LLMPin):
    workspaceId: str
    kind: str  # flashcards | quiz | mindmap | diagram
    count: int = Field(ge=1, le=50)
    levels: list[str] = Field(min_length=1)
    types: list[str] = Field(min_length=1)
    detail: str
    diagramType: str
    length: str | None = None
    format: str | None = None
    style: str | None = None
    chapters: list[str] | None = None
    fileIds: list[str] | None = None
    timeLimitMin: int | None = None
    locale: str | None = None


_VALID_LEVELS = {"recall", "application", "analysis"}

# What each cognitive level asks the LLM to write, so questions have a purpose
# instead of a vague difficulty knob.
_LEVEL_GUIDE = (
    "recall (remember a fact, term, or definition), "
    "application (use a concept or procedure to solve a problem), "
    "analysis (compare, break down, or reason about relationships between ideas)"
)


def _cognitive_levels(req: GenerateReq) -> list[str]:
    if not req.levels:
        raise ValueError("levels is required")
    invalid = [lvl for lvl in req.levels if lvl not in _VALID_LEVELS]
    if invalid:
        raise ValueError(f"invalid levels: {invalid}")
    return list(req.levels)


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
    return {"ok": True, "query_model": cfg.query_model}


async def _chat_events(req: ChatStreamReq, request: Request):
    _bind_llm(req)
    accounting_token = None
    ctx = ToolContext(
        workspace_id=req.workspaceId,
        user_id=req.userId or "",
        file_ids=list(req.fileIds or []),
        assistant_message_id=req.assistantMessageId or "",
    )
    try:
        accounting_token = accounting.bind(req.spendSessionId)
        async for event in run_agent(
            query=req.query,
            ctx=ctx,
            history=req.history,
            model=models.resolve_query_model(req.modelKey, req.configVersion),
            locale=req.locale,
            checkpoint=req.checkpoint,
        ):
            if await request.is_disconnected():
                break
            yield _sse(event)
    except models.UserKeyError as exc:
        yield _sse(exc.as_event())
    except Exception as exc:
        log.exception("chat stream failed")
        yield _sse({"type": "error", "message": str(exc)})
    finally:
        if accounting_token is not None:
            accounting.reset(accounting_token)


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


class CompleteReq(LLMPin):
    workspaceId: str
    mode: str = "command"  # command | continue
    prompt: str | None = None
    context: str | None = None
    model: str | None = None  # ignored; pin is modelKey + configVersion
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
    _bind_llm(req)
    model = models.resolve_query_model(
        req.modelKey, req.configVersion, surface=registry.SURFACE_EDITOR
    )
    if req.context:
        req.context = clip_to_tokens(req.context, registry.input_budget(model))
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
    except models.UserKeyError as exc:
        yield _sse(exc.as_event())
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


class QuizGradeReq(LLMPin):
    workspaceId: str | None = None
    prompt: str = ""
    hints: list[str] | None = None
    rubrics: list[str] | None = None
    modelAnswer: str = ""
    userAnswer: str = ""
    locale: str | None = None


@app.post("/quiz-grade")
async def quiz_grade(req: QuizGradeReq) -> dict[str, Any]:
    _bind_llm(req)
    model = models.resolve_query_model(
        req.modelKey, req.configVersion, surface=registry.SURFACE_QUIZ
    )
    text = await models.complete_text(
        [
            {"role": "system", "content": quiz_grade_mod.GRADE_SYSTEM},
            {
                "role": "user",
                "content": clip_to_tokens(
                    quiz_grade_mod.build_grade_prompt(
                        prompt=req.prompt,
                        hints=req.hints or [],
                        rubrics=req.rubrics or [],
                        model_answer=req.modelAnswer,
                        user_answer=req.userAnswer,
                    ),
                    registry.input_budget(model),
                ),
            },
        ],
        model=model,
        temperature=0.1,
        max_tokens=models.quiz_grade_max_tokens(model),
        reasoning=False,
    )
    payload = quiz_grade_mod.parse_grade_response(text)
    usage = obs.current_usage()
    if usage is not None and not usage.is_empty():
        payload["usage"] = usage.as_dict()
    return payload


@app.post("/ai/command")
async def ai_command(req: CompleteReq):
    """Non-streaming one-shot AI command (kept for parity with the gateway)."""
    _bind_llm(req)
    try:
        text = await models.complete_text(
            _complete_messages(req),
            model=models.resolve_query_model(
                req.modelKey, req.configVersion, surface=registry.SURFACE_EDITOR
            ),
            temperature=0.7,
        )
        return {"text": text}
    except models.UserKeyError:
        raise
    except Exception as e:
        log.exception("ai command failed")
        return {"text": "", "error": str(e)}


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
    _bind_llm(req)
    model = models.resolve_query_model(
        req.modelKey, req.configVersion, surface=registry.SURFACE_GENERATE
    )
    chapters = req.chapters or []
    file_ids = req.fileIds or []
    context, passages = await workflows.gather_context(
        workspace_id=req.workspaceId,
        file_ids=file_ids or None,
        budget=registry.input_budget(model),
    )
    file_names = sorted({p.file_name for p in passages})
    scope = workflows.scope_label(chapters, file_names)

    if req.kind == "flashcards":
        n = req.count
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
        data = workflows.require_json_list(raw, "flashcards")
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
        if not cards:
            raise workflows.GenerateEmpty("flashcards")
        return {"kind": "flashcards", "cards": cards}

    if req.kind == "mindmap":
        detail = req.detail
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
        code = workflows.require_mermaid(raw, "mindmap")
        return {
            "kind": "mindmap",
            "title": "Mindmap",
            "content": f"# Mindmap\n\n```mermaid\n{code}\n```",
        }

    if req.kind == "diagram":
        dtype = req.diagramType.lower()
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
        code = workflows.require_mermaid(raw, "diagram")
        return {
            "kind": "diagram",
            "title": "Diagram",
            "content": f"# Diagram\n\n```mermaid\n{code}\n```",
        }

    if req.kind != "quiz":
        raise ValueError(f"unsupported generate kind {req.kind!r}")
    n = req.count
    types = req.types
    levels = _cognitive_levels(req)
    raw = await workflows.produce(
        instruction=(
            f"Create a {n}-question quiz from these sources using question types "
            f'{types}. Tag each question with a cognitive "level" chosen from: '
            f"{_LEVEL_GUIDE}. Aim for a mix across these levels: {levels}, and make "
            "each question genuinely match the cognitive demand of its level. "
            "Return ONLY a JSON array of question objects. Each object has: "
            '"type" (one of mcq, multi, boolean, short, open, ordering, matching), '
            '"level" (recall|application|analysis), "prompt", and the fields '
            "appropriate to its type (mcq/multi: options[] + correct[] indices; "
            "boolean: correct bool; short: accepted[]; open: accepted[] model "
            "answer, hints[], rubrics[] marking-scheme strings, optional points; "
            "ordering: items[] in order; matching: pairs[] of {left,right}). For "
            "mcq and multi, each option MUST be an object "
            '{"value": "...", "explanation": "..."} where the explanation says '
            "why that option is correct or incorrect. For boolean, short, open, "
            "ordering and matching, add a single "
            '"explanation" field for the question.'
        ),
        context=context,
        scope=scope,
        model=model,
        locale=req.locale,
    )
    questions = workflows.normalize_questions(workflows.require_json_list(raw, "quiz"))
    if not questions:
        raise workflows.GenerateEmpty("quiz")
    return {
        "kind": "quiz",
        "name": "Workspace quiz",
        "chapters": chapters,
        "questions": questions,
        "timeLimitMin": req.timeLimitMin,
    }
