"""Retrieval HTTP service. The Go gateway proxies /chat/stream, /generate, /quiz-grade and /plate-ai here.

Chat runs a capped tool loop over the workspace index (see retrieval/agent.py).
Generation runs fixed workflows instead, because its output has to parse.

Run: ``uvicorn pipeline.retrieve.service:app --host 0.0.0.0 --port 8001``
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import threading
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .. import obs, registry, use_compatible_event_loop
from ..config import cfg
from ..retrieval import accounting, models, store, workflows
from ..retrieval.agent import CLIENT_ERROR, CLIENT_ERROR_CODE, ClientDrop, run_agent
from ..retrieval.chunking import clip_to_tokens, estimate_tokens
from ..retrieval.events import error as client_error
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
    log.info("retrieval up — tools=%s", "on" if cfg.gateway_url else "read-only")
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


@app.exception_handler(workflows.InvalidGenerateScope)
async def invalid_generate_scope_handler(
    _request: Request, exc: workflows.InvalidGenerateScope
):
    return JSONResponse({"code": "invalid_scope", "message": str(exc)}, status_code=400)


@app.exception_handler(workflows.GenerateNoContent)
async def generate_no_content_handler(
    _request: Request, exc: workflows.GenerateNoContent
):
    return JSONResponse(
        {"code": "scope_has_no_indexed_content", "message": str(exc)},
        status_code=400,
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


ThinkingLevel = Literal["instant", "low", "mid", "high", "max"]


class LLMPin(BaseModel):
    providerSlug: str | None = None
    modelSlug: str | None = None
    configVersion: int | None = None
    userId: str | None = None
    paidBy: str | None = None
    thinking: ThinkingLevel


def _bind_llm(req: LLMPin) -> None:
    registry.bind_request_llm(req.userId, req.paidBy, req.thinking)


class ChatStreamReq(LLMPin):
    query: str = Field(min_length=1, max_length=65_536)
    workspaceId: str
    fileIds: list[str] | None = None
    model: str | None = None  # ignored; the provider/model/version pin is authoritative
    # Prior turns as OpenAI-style role/content pairs, sent to the LLM only.
    history: list[dict] | None = None
    checkpoint: dict | None = None
    assistantMessageId: str | None = None
    spendSessionId: str
    # Account locale from the gateway (users.locale). Do not trust a browser field.
    locale: str | None = None


def _bind_accounting(session_id: str):
    if not session_id:
        return None
    return accounting.bind(session_id)


QUERY_MAX_ESTIMATED_TOKENS = 8192
QUERY_MAX_BYTES = 65_536


def _reset_accounting(token) -> None:
    if token is not None:
        accounting.reset(token)


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
    spendSessionId: str = ""


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
    return {"ok": True}


async def _relay_until_disconnect(
    request: Request,
    agen,
    client: ClientDrop,
):
    """Write SSE while the client is here. Never cancel the agent pump.

    On disconnect we stop writing and wait for the current provider call to
    settle. The agent sees ``client.dropped`` and does not start another call.
    """
    queue: asyncio.Queue[object] = asyncio.Queue()

    async def _pump() -> None:
        try:
            async for event in agen:
                await queue.put(event)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - relay to the SSE writer
            await queue.put(exc)
        finally:
            await queue.put(None)

    pump = asyncio.create_task(_pump())
    try:
        while True:
            if await request.is_disconnected():
                client.mark()
                break
            try:
                item = await asyncio.wait_for(queue.get(), timeout=0.2)
            except TimeoutError:
                continue
            if item is None:
                return
            if isinstance(item, BaseException):
                raise item
            yield _sse(item)
    finally:
        if not pump.done():
            client.mark()
            await asyncio.shield(pump)


async def _chat_events(req: ChatStreamReq, request: Request):
    if (
        len(req.query.encode("utf-8")) > QUERY_MAX_BYTES
        or estimate_tokens(req.query) > QUERY_MAX_ESTIMATED_TOKENS
    ):
        yield _sse(
            client_error(
                "The message is too long. Shorten it and try again.",
                "query_too_long",
            )
        )
        return
    _bind_llm(req)
    accounting_token = None
    client = ClientDrop()
    ctx = ToolContext(
        workspace_id=req.workspaceId,
        user_id=req.userId or "",
        file_ids=list(req.fileIds or []),
        assistant_message_id=req.assistantMessageId or "",
    )
    try:
        accounting_token = accounting.bind(req.spendSessionId)
        agen = run_agent(
            query=req.query,
            ctx=ctx,
            history=req.history,
            model=models.resolve_query_model(
                req.providerSlug, req.modelSlug, req.configVersion
            ),
            locale=req.locale,
            checkpoint=req.checkpoint,
            client=client,
        )
        async for chunk in _relay_until_disconnect(request, agen, client):
            yield chunk
    except models.UserKeyError as exc:
        if not client.dropped:
            yield _sse(exc.as_event())
    except Exception:
        log.exception("chat stream failed")
        if not client.dropped:
            yield _sse(client_error(CLIENT_ERROR, CLIENT_ERROR_CODE))
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


class QuizGradeReq(LLMPin):
    workspaceId: str | None = None
    prompt: str = ""
    hints: list[str] | None = None
    rubrics: list[str] | None = None
    modelAnswer: str = ""
    userAnswer: str = ""
    locale: str | None = None
    spendSessionId: str = ""


@app.post("/quiz-grade")
async def quiz_grade(req: QuizGradeReq) -> dict[str, Any]:
    _bind_llm(req)
    accounting_token = _bind_accounting(req.spendSessionId)
    model = models.resolve_query_model(
        req.providerSlug,
        req.modelSlug,
        req.configVersion,
        surface=registry.Surface.QUIZ,
    )
    try:
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
    finally:
        _reset_accounting(accounting_token)


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
    every generate kind reports it the same way.
    """
    accounting_token = _bind_accounting(req.spendSessionId)
    try:
        payload = await _generate(req)
        usage = obs.current_usage()
        if usage is not None and not usage.is_empty():
            payload["usage"] = usage.as_dict()
        return payload
    finally:
        _reset_accounting(accounting_token)


async def _generate(req: GenerateReq) -> dict[str, Any]:
    _bind_llm(req)
    model = models.resolve_query_model(
        req.providerSlug,
        req.modelSlug,
        req.configVersion,
        surface=registry.Surface.GENERATE,
    )
    chapters = req.chapters or []
    file_ids = req.fileIds or []
    context, passages = await workflows.gather_context(
        workspace_id=req.workspaceId,
        file_ids=file_ids or None,
        budget=registry.input_budget(model),
    )
    if not passages:
        raise workflows.GenerateNoContent("The requested scope has no indexed content.")
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
