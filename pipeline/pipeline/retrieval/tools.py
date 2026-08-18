"""Tools the chat agent may call, and their execution.

Read tools go straight to Postgres. Anything with a side effect goes back
through the Go gateway so that authorization, storage quota and the materials
model stay in one place — the retrieval service holds database credentials, but
it deliberately does not hold the rules.

Tool results are returned as text, not JSON, because the consumer is a language
model: prose with an explicit location line survives truncation and confusion
far better than a nested object, and it makes citations legible in the
transcript.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

import requests

from ..config import cfg
from . import store
from .search import Passage, search

log = logging.getLogger("evo.retrieval.tools")


@dataclass
class ToolContext:
    workspace_id: str
    user_id: str = ""
    # Scope from the request (a chapter or file selection in the UI). Tools
    # intersect with it rather than replacing it, so the agent cannot widen a
    # scope the user narrowed.
    file_ids: list[str] = field(default_factory=list)
    citations: list[Passage] = field(default_factory=list)
    materials: list[dict[str, Any]] = field(default_factory=list)


def _scoped(ctx: ToolContext, requested: list[str] | None) -> list[str] | None:
    if not requested:
        return ctx.file_ids or None
    if not ctx.file_ids:
        return requested
    allowed = set(ctx.file_ids)
    narrowed = [fid for fid in requested if fid in allowed]
    return narrowed or ctx.file_ids


SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_workspace",
            "description": (
                "Search the user's sources for passages relevant to a query. Use "
                "one focused query per call; call again with a different query "
                "rather than concatenating several questions."
            ),
            "parameters": {
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
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_sources",
            "description": (
                "List the chapters and documents in this workspace with a short "
                "descriptor of each file. Use this first when the question is "
                "about what the workspace contains, or to decide which documents "
                "to search or describe."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "describe_documents",
            "description": (
                "Return the detailed summaries of up to eight documents. Call "
                "after list_sources when the short descriptors are not enough "
                "to decide, or when the question is about what a document covers "
                "as a whole."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Documents to describe. Omit to describe the current scope.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": (
                "Read a document in order from a given chunk index. Use after "
                "search when a passage needs its surrounding argument, or to walk "
                "a short document end to end."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file_id": {"type": "string"},
                    "start": {"type": "integer", "default": 0},
                    "count": {"type": "integer", "default": 4},
                },
                "required": ["file_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "related_concepts",
            "description": (
                "Find concepts discussed alongside a given concept, and which "
                "documents discuss them. Use for questions that span documents, "
                "such as comparing or connecting topics."
            ),
            "parameters": {
                "type": "object",
                "properties": {"concept": {"type": "string"}},
                "required": ["concept"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_material",
            "description": (
                "Create a study material in this workspace: a quiz, flashcard "
                "deck, mindmap or diagram. Only call this when the user asked for "
                "one. Ground the content in passages you already retrieved."
            ),
            "parameters": {
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
                },
                "required": ["kind"],
            },
        },
    },
]


def schemas_for(ctx: ToolContext) -> list[dict[str, Any]]:
    """Advertise only tools that can actually run in this context."""
    if _gateway_ready() and ctx.user_id:
        return SCHEMAS
    return [s for s in SCHEMAS if s["function"]["name"] != "generate_material"]


def _gateway_ready() -> bool:
    return bool(cfg.gateway_url and cfg.pipeline_secret)


async def run(name: str, args: dict[str, Any], ctx: ToolContext) -> str:
    handler = _HANDLERS.get(name)
    if handler is None:
        return f"No tool named {name}."
    try:
        return await handler(args, ctx)
    except Exception as exc:
        log.exception("tool %s failed", name)
        return f"The {name} tool failed: {exc}"


async def _search_workspace(args: dict[str, Any], ctx: ToolContext) -> str:
    query = str(args.get("query") or "").strip()
    if not query:
        return "search_workspace needs a query."
    passages = await search(
        workspace_id=ctx.workspace_id,
        query=query,
        file_ids=_scoped(ctx, args.get("file_ids")),
    )
    if not passages:
        return "No passages matched. Try different wording, or list_sources first."
    return "\n\n".join(
        passage.as_context(number) for number, passage in remember(ctx, passages)
    )


async def _list_sources(_args: dict[str, Any], ctx: ToolContext) -> str:
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
    return "\n".join(lines) if lines else "This workspace has no indexed documents."


_DESCRIBE_CAP = 8


async def _describe_documents(args: dict[str, Any], ctx: ToolContext) -> str:
    requested = args.get("file_ids")
    if not isinstance(requested, list):
        requested = []
    requested = [str(fid) for fid in requested if fid]
    scoped = _scoped(ctx, requested or None)
    if not scoped:
        return "No documents in the current scope."
    ids = scoped[:_DESCRIBE_CAP]
    rows = await store.file_summaries(ids)
    if not rows:
        return "No summaries for those documents."
    lines: list[str] = []
    for file in rows:
        head = f"### {file['name']} (file_id={file['id']})"
        body = file.get("summary") or file.get("descriptor") or "(no summary yet)"
        lines.append(f"{head}\n{body}")
    if len(scoped) > _DESCRIBE_CAP:
        lines.append(
            f"(showing {_DESCRIBE_CAP} of {len(scoped)}; call again for the rest.)"
        )
    return "\n\n".join(lines)


def _file_line(file: dict[str, Any]) -> str:
    head = f"- {file['name']} (file_id={file['id']}, {file['chunks']} passages)"
    if file.get("status") != "ready":
        head += f" [{file['status']}]"
    if file.get("descriptor"):
        head += f"\n  {file['descriptor']}"
    return head


async def _read_document(args: dict[str, Any], ctx: ToolContext) -> str:
    file_id = str(args.get("file_id") or "")
    if ctx.file_ids and file_id not in ctx.file_ids:
        return "That document is outside the current scope."
    start = max(0, int(args.get("start") or 0))
    count = min(12, max(1, int(args.get("count") or 4)))
    rows = await store.read_file_range(file_id=file_id, start=start, count=count)
    if not rows:
        return "No passages at that position."
    numbered = remember(ctx, [Passage.from_row(row) for row in rows])
    body = "\n\n".join(
        f"[{number}] {p.location()} (chunk {p.chunk_idx})\n{p.text}"
        for number, p in numbered
    )
    return body + f"\n\n(next start = {rows[-1]['chunk_idx'] + 1})"


async def _related_concepts(args: dict[str, Any], ctx: ToolContext) -> str:
    concept = str(args.get("concept") or "").strip()
    if not concept:
        return "related_concepts needs a concept."
    rows = await store.related_concepts(workspace_id=ctx.workspace_id, name=concept)
    if not rows:
        return f"'{concept}' is not indexed as a concept in this workspace."
    return "\n".join(
        f"- {row['name']} ({row['mentions']} passages; in {', '.join(row['files'][:4])})"
        for row in rows
    )


async def _generate_material(args: dict[str, Any], ctx: ToolContext) -> str:
    if not _gateway_ready() or not ctx.user_id:
        return "Material creation is unavailable in this deployment."
    kind = str(args.get("kind") or "").strip()
    payload = {
        "workspaceId": ctx.workspace_id,
        "userId": ctx.user_id,
        "kind": kind,
        "title": args.get("title") or "",
        "cards": args.get("cards") or [],
        "questions": args.get("questions") or [],
        "content": args.get("content") or "",
    }

    def _post() -> requests.Response:
        return requests.post(
            cfg.gateway_url.rstrip("/") + "/api/internal/materials",
            headers={
                "Content-Type": "application/json",
                "X-Pipeline-Secret": cfg.pipeline_secret,
            },
            data=json.dumps(payload),
            timeout=30,
        )

    resp = await asyncio.to_thread(_post)
    if resp.status_code >= 300:
        detail = ""
        try:
            detail = str(resp.json().get("message") or "")
        except ValueError:
            detail = resp.text[:200]
        # Surfaced verbatim so the model tells the user what actually happened
        # (over quota, no permission) instead of claiming success.
        return f"Could not create the {kind}: {detail or resp.status_code}"
    body = resp.json()
    ctx.materials.append(body)
    return (
        f"Created {body.get('kind')} '{body.get('title')}' "
        f"(id {body.get('materialId')}). It is now in the workspace."
    )


def remember(ctx: ToolContext, passages: list[Passage]) -> list[tuple[int, Passage]]:
    """Assign each passage its stable citation number for this turn.

    Numbering is per conversation turn and shared across tools, so [3] means the
    same passage whether it came from a search or from reading a document.
    """
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


_HANDLERS = {
    "search_workspace": _search_workspace,
    "list_sources": _list_sources,
    "describe_documents": _describe_documents,
    "read_document": _read_document,
    "related_concepts": _related_concepts,
    "generate_material": _generate_material,
}
