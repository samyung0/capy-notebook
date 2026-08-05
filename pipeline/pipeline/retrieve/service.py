"""Retrieval HTTP service. The Go gateway proxies /chat and /generate here.

Queries run against the per-workspace LightRAG instances (query-side: pro by
default, flash reachable via the ``model`` field). One ``RagCache`` lives on the
FastAPI event loop so the asyncpg pools stay valid.

Run: ``uvicorn pipeline.retrieve.service:app --host 0.0.0.0 --port 8001``
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import StreamingResponse
from lightrag import QueryParam
from pydantic import BaseModel

from ..config import cfg
from ..rag.cache import RagCache
from ..rag.clone import clone_workspace_state
from ..rag.factory import build_query_rag
from ..rag.teardown import drop_workspace_state
from ..rag.models import query_model_override
from ..store import db
from .ai_adapter import router as plate_ai_router

log = logging.getLogger("evo.retrieve")

_cache: RagCache | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _cache
    _cache = RagCache(build_query_rag, maxsize=cfg.lightrag_cache_size)
    log.info(
        "retrieval up — query_model=%s alt=%s embedding=%s",
        cfg.query_model,
        cfg.query_model_alt,
        cfg.embedding_model,
    )
    try:
        yield
    finally:
        await _cache.close()


app = FastAPI(title="Evo Notes retrieval", lifespan=lifespan)
app.include_router(plate_ai_router)


class ChatReq(BaseModel):
    query: str
    workspaceId: str
    k: int = 6
    model: str | None = None  # deepseek-v4-pro | deepseek-v4-flash


class ChatStreamReq(BaseModel):
    query: str
    workspaceId: str
    model: str | None = None
    # Prior turns as OpenAI-style role/content pairs, sent to the LLM only.
    history: list[dict] | None = None


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
    fileIds: list[str] | None = None  # file-scoped retrieval filtering (doc ids)
    detail: str | None = None  # mindmap: brief|standard|detailed
    diagramType: str | None = None  # diagram: auto|flowchart|sequence|class|state|er
    timeLimitMin: int | None = None


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


def _extract_json(text: str) -> Any:
    """Pull the first JSON value out of an LLM reply, tolerating prose/fences."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else text
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass
    m = re.search(r"(\{.*\}|\[.*\])", candidate, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


async def _answer(
    workspace: str,
    query: str,
    model: str | None,
) -> str:
    assert _cache is not None
    rag = await _cache.get(workspace)
    token = query_model_override.set(model if model in cfg.query_models else None)
    try:
        return await rag.aquery(query, param=QueryParam(mode="mix"))
    finally:
        query_model_override.reset(token)


def _file_names(file_ids: list[str]) -> list[str]:
    with db.connect() as conn, conn.cursor() as cur:
        return db.file_names_for_ids(cur, file_ids)


async def _scope_hint(chapters: list[str] | None, file_ids: list[str] | None) -> str:
    """A natural-language instruction narrowing the answer to the requested
    scope.

    LightRAG v1.5 dropped ``QueryParam(ids=...)`` document filtering, so the
    prompt is the only scoping lever. Naming the actual source files (LightRAG
    stores each document's basename as its citation ``file_path``) steers
    retrieval-grounded generation far better than a bare file count.

    The Go gateway already expands chapter ids to their member file ids and
    unions them into ``file_ids`` (see ``resolveScope``), so those files are
    named here too; ``chapters`` carries the resolved chapter names for a
    human-readable scope label.
    """
    parts: list[str] = []
    if chapters:
        parts.append("chapters titled: " + ", ".join(chapters))
    if file_ids:
        try:
            names = await asyncio.to_thread(_file_names, list(file_ids))
        except Exception:
            log.warning("file name lookup for scope hint failed", exc_info=True)
            names = []
        if names:
            parts.append("the source files named: " + ", ".join(names))
        else:
            parts.append(f"the {len(file_ids)} selected source file(s)")
    if not parts:
        return ""
    return (
        "Use ONLY the following scope of the workspace — "
        + "; ".join(parts)
        + ". Ignore material outside this scope.\n\n"
    )


def _strip_fence(text: str) -> str:
    """Remove a surrounding ``` / ```mermaid fence from an LLM reply, if any."""
    if not text:
        return ""
    m = re.search(r"```(?:mermaid)?\s*(.+?)\s*```", text, re.DOTALL)
    return (m.group(1) if m else text).strip()


@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "query_model": cfg.query_model,
        "embedding": cfg.embedding_model,
    }


class CloneWorkspaceReq(BaseModel):
    sourceWorkspaceId: str
    targetWorkspaceId: str


@app.post("/workspace/clone")
async def workspace_clone(req: CloneWorkspaceReq):
    """Copy one workspace's parsed LightRAG state (PG rows + AGE graph) into
    another workspace. Called by the Go gateway after it clones the app rows
    (files/materials keep their doc ids, so the copied state lines up)."""
    assert _cache is not None
    # Initialize the target workspace first so LightRAG creates its graph,
    # labels and indexes — the row copy requires them to exist.
    await _cache.get(req.targetWorkspaceId)
    result = await asyncio.to_thread(
        clone_workspace_state, req.sourceWorkspaceId, req.targetWorkspaceId
    )
    return {"ok": True, **result}


class DeleteWorkspaceReq(BaseModel):
    workspaceId: str


@app.post("/workspace/delete")
async def workspace_delete(req: DeleteWorkspaceReq):
    """Drop a workspace's LightRAG state (PG rows + AGE graph).

    Called by the Go gateway after it deletes the app rows, and during an account
    purge. None of this state is reachable from the Go schema, so without this
    call every deleted workspace leaves its lightrag_* rows and graph behind.

    Idempotent: a workspace that was never ingested has no state to remove.
    """
    assert _cache is not None
    # Evict first: a cached handle would outlive the tables it points at.
    await _cache.discard(req.workspaceId)
    result = await asyncio.to_thread(drop_workspace_state, req.workspaceId)
    return {"ok": True, **result}


@app.post("/chat")
async def chat(req: ChatReq):
    text = await _answer(req.workspaceId, req.query, req.model)
    # Citations: LightRAG returns a synthesized answer (with an inline reference
    # section when configured) rather than structured spans; structured citations
    # are a follow-up. The Go gateway tolerates an empty list.
    return {"id": db.uid("m"), "role": "assistant", "text": text, "citations": []}


def _citations_from_result(result: dict) -> list[dict]:
    """Best-effort map of LightRAG references onto our Citation shape.

    LightRAG returns retrieval references as ``{reference_id, file_path, ...}``;
    the frontend wants ``{fileId, fileName, snippet}``. Missing fields degrade
    gracefully to empty strings.
    """
    refs = (result.get("data") or {}).get("references") or []
    out: list[dict] = []
    seen: set[str] = set()
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        file_path = str(ref.get("file_path") or ref.get("reference_id") or "").strip()
        if not file_path or file_path in seen or file_path == "unknown_source":
            continue
        seen.add(file_path)
        out.append(
            {
                "fileId": str(ref.get("reference_id") or file_path),
                "fileName": file_path,
                "snippet": str(ref.get("content") or "")[:280],
            }
        )
    return out


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def _answer_stream(req: ChatStreamReq, request: Request):
    """Yield SSE events (citations -> token* -> done) for a grounded answer.

    Uses ``LightRAG.aquery_llm(stream=True)`` so we can iterate the token
    iterator. Stops early if the client disconnects.
    """
    assert _cache is not None
    rag = await _cache.get(req.workspaceId)
    token = query_model_override.set(
        req.model if req.model in cfg.query_models else None
    )
    try:
        param = QueryParam(
            mode="mix",
            stream=True,
            conversation_history=req.history or [],
        )
        result = await rag.aquery_llm(req.query, param=param)

        citations = _citations_from_result(result)
        if citations:
            yield _sse({"type": "citations", "citations": citations})

        llm = result.get("llm_response", {}) or {}
        if llm.get("is_streaming"):
            async for chunk in llm.get("response_iterator"):
                if not chunk:
                    continue
                if await request.is_disconnected():
                    break
                yield _sse({"type": "token", "text": chunk})
        else:
            content = llm.get("content") or "No relevant context found for the query."
            yield _sse({"type": "token", "text": content})

        yield _sse({"type": "done"})
    except Exception as e:
        log.exception("chat stream failed")
        yield _sse({"type": "error", "message": str(e)})
    finally:
        query_model_override.reset(token)


@app.post("/chat/stream")
async def chat_stream(req: ChatStreamReq, request: Request):
    return StreamingResponse(
        _answer_stream(req, request),
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
    model: str | None = None


def _llm_client():
    from openai import AsyncOpenAI

    return AsyncOpenAI(api_key=cfg.llm.api_key, base_url=cfg.llm.base_url)


def _complete_messages(req: CompleteReq) -> list[dict]:
    context = (req.context or "").strip()
    if req.mode == "continue":
        system = (
            "You are a writing assistant embedded in a note editor. Continue the "
            "user's note naturally from where it stops. Write only the continuation "
            "(no preamble, no repetition of the existing text). Match the existing tone."
        )
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": context or "(empty note)"},
        ]
    system = (
        "You are a writing assistant embedded in a note editor. Apply the user's "
        "instruction and return ONLY the resulting text to insert (no preamble, no "
        "code fences unless the instruction asks for code)."
    )
    user = f"Instruction: {(req.prompt or '').strip()}"
    if context:
        user += f"\n\nContent:\n{context}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


async def _complete_stream(req: CompleteReq, request: Request):
    model = req.model if req.model in cfg.query_models else cfg.query_model
    try:
        client = _llm_client()
        stream = await client.chat.completions.create(
            model=model,
            messages=_complete_messages(req),
            stream=True,
            temperature=0.7,
        )
        async for chunk in stream:
            if await request.is_disconnected():
                break
            delta = (chunk.choices[0].delta.content or "") if chunk.choices else ""
            if delta:
                yield _sse({"type": "token", "text": delta})
        yield _sse({"type": "done"})
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
        client = _llm_client()
        model = req.model if req.model in cfg.query_models else cfg.query_model
        resp = await client.chat.completions.create(
            model=model,
            messages=_complete_messages(req),
            temperature=0.7,
        )
        text = resp.choices[0].message.content if resp.choices else ""
        return {"text": text or ""}
    except Exception as e:
        log.exception("ai command failed")
        return {"text": "", "error": str(e)}


# --------------------------------------------------------------- transcription


@app.post("/transcribe")
async def transcribe(file: Annotated[UploadFile, File()]):
    """Transcribe an uploaded audio blob via a Whisper-compatible STT provider."""
    from openai import AsyncOpenAI

    try:
        client = AsyncOpenAI(api_key=cfg.stt.api_key, base_url=cfg.stt.base_url)
        data = await file.read()
        resp = await client.audio.transcriptions.create(
            model=cfg.stt_model,
            file=(file.filename or "audio.webm", data),
        )
        return {"text": getattr(resp, "text", "") or ""}
    except Exception as e:
        log.exception("transcription failed")
        return {"text": "", "error": str(e)}


_DIAGRAM_HEADER = {
    "flowchart": "flowchart TD",
    "sequence": "sequenceDiagram",
    "class": "classDiagram",
    "state": "stateDiagram-v2",
    "er": "erDiagram",
}


@app.post("/generate")
async def generate(req: GenerateReq):
    chapters = req.chapters or []
    file_ids = req.fileIds or []
    hint = await _scope_hint(chapters, file_ids)

    if req.kind == "summary":  # legacy; UI no longer offers this
        body = await _answer(
            req.workspaceId,
            hint
            + "Write a concise study summary of the most important ideas in this scope. "
            "Use short bullet points.",
            cfg.query_model_alt,
        )
        return {"kind": "summary", "title": "Workspace summary", "body": body}

    if req.kind == "flashcards":
        n = req.count or 10
        raw = await _answer(
            req.workspaceId,
            hint
            + f"Create {n} study flashcards from this scope. Return ONLY a JSON array "
            'of objects {"front": "...", "back": "..."}.',
            cfg.query_model_alt,
        )
        data = _extract_json(raw) or []
        cards = [
            {
                "id": db.uid("c"),
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
        raw = await _answer(
            req.workspaceId,
            hint
            + "Create a Mermaid `mindmap` that organizes the key concepts of this scope and "
            f"their relationships ({detail} level of detail). Return ONLY the Mermaid code "
            "starting with the line `mindmap` — no code fences, no prose.",
            cfg.query_model_alt,
        )
        code = _strip_fence(raw) or "mindmap\n  root((Topic))"
        content = f"# Mindmap\n\n```mermaid\n{code}\n```"
        return {"kind": "mindmap", "title": "Mindmap", "content": content}

    if req.kind == "diagram":
        dtype = (req.diagramType or "auto").lower()
        header = _DIAGRAM_HEADER.get(dtype)
        want = (
            f"a Mermaid `{header}` diagram"
            if header
            else "the most appropriate Mermaid diagram"
        )
        raw = await _answer(
            req.workspaceId,
            hint
            + f"Create {want} that best illustrates the key ideas, processes, or relationships "
            "in this scope. Return ONLY the Mermaid code (a valid diagram) — no code fences, "
            "no prose.",
            cfg.query_model_alt,
        )
        code = _strip_fence(raw) or "flowchart LR\n  A --> B"
        content = f"# Diagram\n\n```mermaid\n{code}\n```"
        return {"kind": "diagram", "title": "Diagram", "content": content}

    # quiz
    n = req.count or 5
    types = req.types or ["mcq"]
    levels = _cognitive_levels(req)
    raw = await _answer(
        req.workspaceId,
        hint
        + f"Create a {n}-question quiz from this scope using question types {types}. "
        'Tag each question with a cognitive "level" chosen from: '
        f"{_LEVEL_GUIDE}. Aim for a mix across these levels: {levels}, and make each "
        "question genuinely match the cognitive demand of its level. "
        "Return ONLY a JSON array of question objects. Each object has: "
        '"type" (one of mcq, multi, boolean, fill, short, ordering, matching), '
        '"level" (recall|application|analysis), "prompt", and the fields appropriate to its '
        "type (mcq/multi: options[] + correct[] indices; boolean: correct bool; "
        "fill/short: accepted[]; ordering: items[] in order; matching: pairs[] of {left,right}). "
        'For mcq and multi, each option MUST be an object {"value": "...", "explanation": "..."} '
        "where the explanation says why that option is correct or incorrect. For boolean, fill, "
        'short, ordering, and matching, add a single "explanation" field for the question.',
        cfg.query_model,
    )
    data = _extract_json(raw) or []
    questions = []
    for item in data:
        if not isinstance(item, dict):
            continue
        item.setdefault("id", db.uid("q"))
        # Tolerate models that still emit legacy difficulty.
        if "level" not in item and "difficulty" in item:
            item["level"] = _LEVEL_ALIASES.get(item.pop("difficulty"), "application")
        item.setdefault("level", "application")
        # Normalize mcq/multi options to {value, explanation} objects so the UI
        # can render per-option explanations regardless of what the model emitted.
        if item.get("type") in ("mcq", "multi") and isinstance(
            item.get("options"), list
        ):
            item["options"] = [
                opt if isinstance(opt, dict) else {"value": str(opt), "explanation": ""}
                for opt in item["options"]
            ]
        questions.append(item)
    return {
        "kind": "quiz",
        "name": "Workspace quiz",
        "chapters": chapters,
        "questions": questions,
        "timeLimitMin": req.timeLimitMin,
    }
