"""Tools the chat agent may call, and their execution.

Read tools go straight to Postgres. Anything with a side effect goes back
through the Go gateway so that authorization, storage quota and the materials
model stay in one place.

Handlers return ToolResult. Citation numbers are assigned after the batch
finishes, in original call order.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import requests

from ..config import cfg
from . import store
from .chunking import clip_to_tokens, estimate_tokens
from .limits import TurnBudget
from .search import Passage, search

log = logging.getLogger("evo.retrieval.tools")


class TurnFailed(RuntimeError):
    """The turn must stop. Do not append a tool result."""


@dataclass
class ToolResult:
    text_parts: list[str] = field(default_factory=list)
    passages: list[Passage] = field(default_factory=list)
    created_material: dict[str, Any] | None = None
    error: str | None = None
    refused: bool = False
    paged: bool = False

    def text(self) -> str:
        if self.error:
            return self.error
        return "\n\n".join(part for part in self.text_parts if part)


@dataclass
class ToolContext:
    workspace_id: str
    user_id: str = ""
    file_ids: list[str] = field(default_factory=list)
    citations: list[Passage] = field(default_factory=list)
    assistant_message_id: str = ""
    budget: TurnBudget | None = None
    _scope_outline: dict[str, Any] | None = field(default=None, repr=False)


Handler = Callable[[dict[str, Any], ToolContext], Awaitable[ToolResult]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    schema: dict[str, Any]
    handler: Handler
    mutates: bool
    uses_embedding: bool
    concurrency_class: str


@dataclass(frozen=True)
class ResolvedScope:
    file_ids: list[str]
    file_names: list[str]
    chapter_ids: list[str]
    chapter_names: list[str]
    indexed: bool


_INVALID_SCOPE = "The requested scope is invalid or unavailable."
_MISSING = object()


async def _scope_outline(ctx: ToolContext) -> dict[str, Any]:
    if ctx._scope_outline is None:
        ctx._scope_outline = await store.workspace_outline(ctx.workspace_id)
    return ctx._scope_outline


def _scope_ids(value: Any) -> list[str] | None:
    if value is _MISSING:
        return []
    if not isinstance(value, list):
        return None
    if any(not isinstance(item, str) or not item.strip() for item in value):
        return None
    return list(dict.fromkeys(item.strip() for item in value))


async def _resolve_scope(
    ctx: ToolContext,
    raw_scope: Any = None,
    *,
    required_file_ids: bool = False,
) -> ResolvedScope | ToolResult:
    if raw_scope is _MISSING:
        scope: dict[str, Any] = {}
    elif isinstance(raw_scope, dict):
        scope = raw_scope
    else:
        return _refused(_INVALID_SCOPE)
    if set(scope) - {"file_ids", "chapter_ids"}:
        return _refused(_INVALID_SCOPE)
    file_ids = _scope_ids(scope.get("file_ids", _MISSING))
    chapter_ids = _scope_ids(scope.get("chapter_ids", _MISSING))
    if file_ids is None or chapter_ids is None:
        return _refused(_INVALID_SCOPE)
    if required_file_ids and not file_ids:
        return _refused("describe_documents needs at least one file id.")

    outline = await _scope_outline(ctx)
    files = list(outline.get("files") or [])
    chapters = list(outline.get("chapters") or [])
    file_by_id = {str(file["id"]): file for file in files}
    chapter_by_id = {str(chapter["id"]): chapter for chapter in chapters}
    if ctx.file_ids and any(file_id not in file_by_id for file_id in ctx.file_ids):
        return _refused(_INVALID_SCOPE)
    allowed = set(ctx.file_ids) if ctx.file_ids else set(file_by_id)
    if any(file_id not in file_by_id or file_id not in allowed for file_id in file_ids):
        return _refused(_INVALID_SCOPE)
    if any(chapter_id not in chapter_by_id for chapter_id in chapter_ids):
        return _refused(_INVALID_SCOPE)

    selected = list(file_ids)
    seen = set(selected)
    for chapter_id in chapter_ids:
        chapter_files = [
            str(file["id"])
            for file in files
            if str(file.get("chapter_id") or "") == chapter_id
        ]
        if any(file_id not in allowed for file_id in chapter_files):
            return _refused(_INVALID_SCOPE)
        for file_id in chapter_files:
            if file_id not in seen:
                seen.add(file_id)
                selected.append(file_id)
    if not file_ids and not chapter_ids:
        selected = [str(file["id"]) for file in files if str(file["id"]) in allowed]

    selected_files = [file_by_id[file_id] for file_id in selected]
    return ResolvedScope(
        file_ids=selected,
        file_names=[str(file.get("name") or "") for file in selected_files],
        chapter_ids=chapter_ids,
        chapter_names=[
            str(chapter_by_id[cid].get("name") or "") for cid in chapter_ids
        ],
        indexed=any(int(file.get("chunks") or 0) > 0 for file in selected_files),
    )


async def resolve_current_scope(ctx: ToolContext) -> ResolvedScope | ToolResult:
    return await _resolve_scope(ctx, _MISSING)


def _schema(name: str, description: str, parameters: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }


def material_id(assistant_message_id: str, tool_call_id: str) -> str:
    digest = hashlib.sha256(
        f"{assistant_message_id}\n{tool_call_id}".encode()
    ).hexdigest()
    return "mat_" + digest[:16]


def _result(text: str, *, passages: list[Passage] | None = None) -> ToolResult:
    return ToolResult(text_parts=[text], passages=list(passages or []))


def _refused(text: str) -> ToolResult:
    return ToolResult(text_parts=[text], error=text, refused=True)


async def _search_workspace(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    query_value = args.get("query")
    if not isinstance(query_value, str) or not query_value.strip():
        return _refused("search_workspace needs a query.")
    query = query_value.strip()
    requested = args.get("file_ids", _MISSING)
    ids = _scope_ids(requested)
    if ids is None:
        return _refused(_INVALID_SCOPE)
    resolved = await _resolve_scope(ctx, {"file_ids": ids})
    if isinstance(resolved, ToolResult):
        return resolved
    if ctx.budget is not None:
        ctx.budget.embedding_calls += 1
    passages = await search(
        workspace_id=ctx.workspace_id,
        query=query,
        file_ids=resolved.file_ids or None,
    )
    if not passages:
        return _result(
            "No passages matched. Try different wording, or list_sources first."
        )
    return ToolResult(passages=passages)


async def _list_sources(_args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    outline = await store.workspace_outline(ctx.workspace_id)
    allowed = set(ctx.file_ids or [])
    lines: list[str] = []
    by_chapter: dict[str | None, list[dict[str, Any]]] = {}
    for file in outline["files"]:
        if allowed and file["id"] not in allowed:
            continue
        by_chapter.setdefault(file["chapter_id"], []).append(file)
    for chapter in outline["chapters"]:
        files = by_chapter.pop(chapter["id"], [])
        if not files:
            continue
        lines.append(f"\n## {chapter['name']}")
        lines.extend(_file_line(f) for f in files)
    unfiled = [f for files in by_chapter.values() for f in files]
    if unfiled:
        lines.append("\n## Unfiled")
        lines.extend(_file_line(f) for f in unfiled)
    return _result(
        "\n".join(lines) if lines else "This workspace has no indexed documents."
    )


_DESCRIBE_CAP = 8


async def _describe_documents(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    requested = _scope_ids(args.get("file_ids", _MISSING))
    if requested is None:
        return _refused(_INVALID_SCOPE)
    resolved = await _resolve_scope(
        ctx,
        {"file_ids": requested},
        required_file_ids=True,
    )
    if isinstance(resolved, ToolResult):
        return resolved
    if len(resolved.file_ids) > _DESCRIBE_CAP:
        return _refused(f"describe_documents accepts at most {_DESCRIBE_CAP} file ids.")
    rows = await store.file_summaries(ctx.workspace_id, resolved.file_ids)
    if not rows:
        return _result("No summaries for those documents.")
    lines: list[str] = []
    for file in rows:
        head = f"### {file['name']} (file_id={file['id']})"
        body = file.get("summary") or file.get("descriptor") or "(no summary yet)"
        lines.append(f"{head}\n{body}")
    return _result("\n\n".join(lines))


def _file_line(file: dict[str, Any]) -> str:
    head = f"- {file['name']} (file_id={file['id']}, {file['chunks']} passages)"
    if file.get("status") != "ready":
        head += f" [{file['status']}]"
    if file.get("descriptor"):
        head += f"\n  {file['descriptor']}"
    return head


async def _read_document(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    file_id = args.get("file_id")
    if not isinstance(file_id, str) or not file_id.strip():
        return _refused("read_document needs a file id.")
    resolved = await _resolve_scope(ctx, {"file_ids": [file_id.strip()]})
    if isinstance(resolved, ToolResult):
        return resolved
    try:
        start = max(0, int(args.get("start") or 0))
        count = min(12, max(1, int(args.get("count") or 4)))
    except (TypeError, ValueError):
        return _refused("read_document received an invalid range.")
    rows = await store.read_file_range(
        workspace_id=ctx.workspace_id,
        file_id=resolved.file_ids[0],
        start=start,
        count=count,
    )
    if not rows:
        return _result("No passages at that position.")
    passages = [Passage.from_row(row) for row in rows]
    return ToolResult(
        text_parts=[f"(next start = {rows[-1]['chunk_idx'] + 1})"],
        passages=passages,
        paged=True,
    )


async def _related_concepts(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    concept_value = args.get("concept")
    if not isinstance(concept_value, str) or not concept_value.strip():
        return _refused("related_concepts needs a concept.")
    concept = concept_value.strip()
    rows = await store.related_concepts(
        workspace_id=ctx.workspace_id,
        name=concept,
        file_ids=ctx.file_ids or None,
    )
    if not rows:
        return _result(f"'{concept}' is not indexed as a concept in this workspace.")
    return _result(
        "\n".join(
            f"- {row['name']} ({row['mentions']} passages; in {', '.join(row['files'][:4])})"
            for row in rows
        )
    )


def _gateway_ready() -> bool:
    return bool(cfg.gateway_url and cfg.pipeline_secret)


def _material_headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "X-Pipeline-Secret": cfg.pipeline_secret,
    }


def _material_url(path: str) -> str:
    return cfg.gateway_url.rstrip("/") + path


def _is_transient(exc: BaseException | None, status: int) -> bool:
    if isinstance(exc, (requests.Timeout, requests.ConnectionError)):
        return True
    return status in (429, 500, 502, 503, 504) or status >= 500


async def _generate_material(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id:
        return _refused("Material creation is unavailable in this deployment.")
    if not ctx.assistant_message_id:
        return _refused("Material creation needs the assistant message id.")
    kind_value = args.get("kind")
    if not isinstance(kind_value, str) or kind_value not in {
        "quiz",
        "flashcards",
        "mindmap",
        "diagram",
        "note",
    }:
        return _refused("generate_material needs a supported material kind.")
    kind = kind_value
    call_id = str(args.get("_tool_call_id") or "")
    if not call_id:
        return _refused("generate_material is missing its tool-call id.")
    resolved = await _resolve_scope(ctx, args.get("scope", _MISSING))
    if isinstance(resolved, ToolResult):
        return resolved
    if not resolved.indexed:
        return _refused("The requested scope has no indexed content.")
    mid = material_id(ctx.assistant_message_id, call_id)
    payload = {
        "id": mid,
        "workspaceId": ctx.workspace_id,
        "userId": ctx.user_id,
        "kind": kind,
        "title": args.get("title") or "",
        "cards": args.get("cards") or [],
        "questions": args.get("questions") or [],
        "content": args.get("content") or "",
        "fileIds": resolved.file_ids,
        "chapterIds": resolved.chapter_ids,
        "fileNames": resolved.file_names,
        "chapters": resolved.chapter_names,
    }

    last_exc: BaseException | None = None
    last_status = 0
    for attempt in range(4):
        try:

            def _post() -> requests.Response:
                return requests.post(
                    _material_url("/api/internal/materials"),
                    headers=_material_headers(),
                    data=json.dumps(payload),
                    timeout=10,
                )

            resp = await asyncio.to_thread(_post)
            last_status = resp.status_code
            if resp.status_code < 300:
                body = resp.json()
                return ToolResult(
                    text_parts=[
                        (
                            f"Created {body.get('kind')} '{body.get('title')}' "
                            f"(id {body.get('materialId')}). It is now in the workspace."
                        )
                    ],
                    created_material=body,
                )
            if resp.status_code in (400, 401, 403, 409, 422):
                detail = _response_detail(resp)
                return _refused(
                    f"Could not create the {kind}: {detail or resp.status_code}"
                )
            if not _is_transient(None, resp.status_code):
                detail = _response_detail(resp)
                return _refused(
                    f"Could not create the {kind}: {detail or resp.status_code}"
                )
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_exc = exc
            log.warning("material POST attempt failed: %s", exc)
        except requests.RequestException as exc:
            last_exc = exc
            log.warning("material POST attempt failed: %s", exc)
        if attempt < 3:
            await asyncio.sleep(0.25 * (2**attempt))
    if last_exc is not None:
        log.warning(
            "material POST exhausted retries: %s status=%s", last_exc, last_status
        )

    recovered = await _recover_material(mid, ctx)
    if recovered is True:
        raise TurnFailed("material create outcome is unknown")
    if recovered is None:
        return _refused(f"Could not create the {kind}: not found after retries.")
    return ToolResult(
        text_parts=[
            (
                f"Created {recovered.get('kind')} '{recovered.get('title')}' "
                f"(id {recovered.get('materialId')}). It is now in the workspace."
            )
        ],
        created_material=recovered,
    )


async def _recover_material(mid: str, ctx: ToolContext) -> dict[str, Any] | None | bool:
    """GET the material id. True means the outcome is unknown."""
    try:

        def _get() -> requests.Response:
            return requests.get(
                _material_url(f"/api/internal/materials/{mid}"),
                headers=_material_headers(),
                params={"workspaceId": ctx.workspace_id, "userId": ctx.user_id},
                timeout=15,
            )

        resp = await asyncio.to_thread(_get)
    except (requests.Timeout, requests.ConnectionError, requests.RequestException):
        return True
    if resp.status_code == 200:
        try:
            return resp.json()
        except ValueError:
            return True
    if resp.status_code == 404:
        return None
    return True


def _response_detail(resp: requests.Response) -> str:
    try:
        return str(resp.json().get("message") or "")
    except ValueError:
        return resp.text[:200]


REGISTRY: dict[str, ToolSpec] = {}


def _register(spec: ToolSpec) -> None:
    REGISTRY[spec.name] = spec


_register(
    ToolSpec(
        name="search_workspace",
        schema=_schema(
            "search_workspace",
            "Search the user's sources for passages relevant to a query. Use "
            "one focused query per call; call again with a different query "
            "rather than concatenating several questions.",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "file_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Restrict to these files. Omit to search the current scope.",
                    },
                },
                "required": ["query"],
            },
        ),
        handler=_search_workspace,
        mutates=False,
        uses_embedding=True,
        concurrency_class="search",
    )
)
_register(
    ToolSpec(
        name="list_sources",
        schema=_schema(
            "list_sources",
            "List the chapters and documents in this workspace with a short "
            "descriptor of each file. Use this first when the question is "
            "about what the workspace contains, or to decide which documents "
            "to search or describe.",
            {"type": "object", "properties": {}},
        ),
        handler=_list_sources,
        mutates=False,
        uses_embedding=False,
        concurrency_class="read",
    )
)
_register(
    ToolSpec(
        name="describe_documents",
        schema=_schema(
            "describe_documents",
            "Return the detailed summaries of up to eight documents. Call "
            "after list_sources when the short descriptors are not enough "
            "to decide, or when the question is about what a document covers "
            "as a whole.",
            {
                "type": "object",
                "properties": {
                    "file_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "maxItems": 8,
                        "description": "One to eight documents to describe.",
                    },
                },
                "required": ["file_ids"],
            },
        ),
        handler=_describe_documents,
        mutates=False,
        uses_embedding=False,
        concurrency_class="read",
    )
)
_register(
    ToolSpec(
        name="read_document",
        schema=_schema(
            "read_document",
            "Read a document in order from a given chunk index. Use after "
            "search when a passage needs its surrounding argument, or to walk "
            "a short document end to end.",
            {
                "type": "object",
                "properties": {
                    "file_id": {"type": "string"},
                    "start": {"type": "integer", "default": 0},
                    "count": {"type": "integer", "default": 4},
                },
                "required": ["file_id"],
            },
        ),
        handler=_read_document,
        mutates=False,
        uses_embedding=False,
        concurrency_class="read",
    )
)
_register(
    ToolSpec(
        name="related_concepts",
        schema=_schema(
            "related_concepts",
            "Find concepts discussed alongside a given concept, and which "
            "documents discuss them. Use for questions that span documents, "
            "such as comparing or connecting topics.",
            {
                "type": "object",
                "properties": {"concept": {"type": "string"}},
                "required": ["concept"],
            },
        ),
        handler=_related_concepts,
        mutates=False,
        uses_embedding=False,
        concurrency_class="read",
    )
)
_register(
    ToolSpec(
        name="generate_material",
        schema=_schema(
            "generate_material",
            "Create a study material in this workspace: a quiz, flashcard "
            "deck, mindmap or diagram. Only call this when the user asked for "
            "one. Ground the content in passages you already retrieved. Do "
            "not mix this call with retrieval tools in the same response.",
            {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["quiz", "flashcards", "mindmap", "diagram", "note"],
                    },
                    "title": {"type": "string"},
                    "cards": {
                        "type": "array",
                        "description": "flashcards only",
                        "items": {
                            "type": "object",
                            "properties": {
                                "front": {"type": "string"},
                                "back": {"type": "string"},
                            },
                            "required": ["front", "back"],
                        },
                    },
                    "questions": {
                        "type": "array",
                        "description": "quiz only; same shape as the quiz generator",
                        "items": {"type": "object"},
                    },
                    "content": {
                        "type": "string",
                        "description": "mindmap/diagram/note only; markdown with a mermaid block",
                    },
                    "scope": {
                        "type": "object",
                        "description": "Source scope for the material. Omit or leave empty to use the current chat scope.",
                        "properties": {
                            "file_ids": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "chapter_ids": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                        },
                        "additionalProperties": False,
                    },
                },
                "required": ["kind"],
            },
        ),
        handler=_generate_material,
        mutates=True,
        uses_embedding=False,
        concurrency_class="mutate",
    )
)


def schemas_for(ctx: ToolContext) -> list[dict[str, Any]]:
    specs = list(REGISTRY.values())
    if not (_gateway_ready() and ctx.user_id):
        specs = [s for s in specs if s.name != "generate_material"]
    return [s.schema for s in specs]


def spec_for(name: str) -> ToolSpec | None:
    return REGISTRY.get(name)


async def run(name: str, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    spec = REGISTRY.get(name)
    if spec is None:
        return _refused(f"No tool named {name}.")
    try:
        return await spec.handler(args, ctx)
    except TurnFailed:
        raise
    except Exception as exc:
        log.exception("tool %s failed", name)
        return _refused(f"The {name} tool failed: {exc}")


def assign_citations(
    ctx: ToolContext, passages: list[Passage]
) -> list[tuple[int, Passage]]:
    """Number passages in call order. Dedup by chunk_id. Answer-local."""
    index = {p.chunk_id: i for i, p in enumerate(ctx.citations)}
    numbered: list[tuple[int, Passage]] = []
    for passage in passages:
        position = index.get(passage.chunk_id)
        if position is None:
            position = len(ctx.citations)
            index[passage.chunk_id] = position
            ctx.citations.append(passage)
        numbered.append((position + 1, passage))
    return numbered


def render_result(result: ToolResult, numbered: list[tuple[int, Passage]]) -> str:
    if result.refused and not numbered:
        return result.error or result.text()
    if numbered and result.paged:
        body = "\n\n".join(
            f"[{number}] {passage.location()} (chunk {passage.chunk_idx})\n{passage.text}"
            for number, passage in numbered
        )
        return body + "\n\n" + result.text_parts[0]
    parts: list[str] = []
    if numbered:
        parts.append("\n\n".join(passage.as_context(n) for n, passage in numbered))
    parts.extend(part for part in result.text_parts if part)
    return "\n\n".join(parts) if parts else result.text()


TOOL_RESULT_MAX_TOKENS = 8192


def limit_tool_result(text: str) -> str:
    """Bound stored tool output while making truncation visible to the model."""
    if estimate_tokens(text) <= TOOL_RESULT_MAX_TOKENS:
        return text
    marker = "\n\n[Tool output truncated. Narrow the request or continue reading.]"
    room = max(0, TOOL_RESULT_MAX_TOKENS - estimate_tokens(marker))
    return clip_to_tokens(text, room) + marker


# keep the old name for tests that still import it during the rewrite
remember = assign_citations
