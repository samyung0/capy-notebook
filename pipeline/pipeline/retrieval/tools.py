"""Tools the chat agent may call, and their execution.

Tool definitions (name, description, argument schema, required resource
operations) come from the shared contract Go generates
(``retrieval/contract.py``); this module binds a local handler to each name.
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
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any

import requests

from .. import obs
from ..config import cfg
from ..generated import MATERIAL_TITLE_MAX
from ..prompts import curate as curate_prompts
from . import capture, contract, library, pending, store
from .chunking import clip_to_tokens, estimate_tokens
from .library_evidence import CurateEvidence
from .limits import TurnBudget
from .search import Passage, SearchStats, search

log = logging.getLogger("capy.retrieval.tools")


class TurnFailed(RuntimeError):
    """The turn must stop. Do not append a tool result."""


@dataclass
class ToolResult:
    text_parts: list[str] = field(default_factory=list)
    passages: list[Passage] = field(default_factory=list)
    # Durable resource effects (shared contract ResourceEffect shape).
    effects: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    error_code: str | None = None
    refused: bool = False
    failed: bool = False
    paged: bool = False

    @property
    def outcome(self) -> str:
        if self.failed:
            return "failed"
        if self.refused:
            return "refused"
        return "succeeded"

    def error_payload(self) -> dict[str, str] | None:
        if not self.error:
            return None
        return {"code": self.error_code or "invalid_input", "message": self.error}

    def text(self) -> str:
        if self.error:
            return self.error
        return "\n\n".join(part for part in self.text_parts if part)


# What a stored ledger keeps of a long conversation. The gateway refuses a
# ledger over 64 KiB, and the model pays for every rendered line on every call,
# so the tail is what a later turn can still act on.
STORED_MATERIALS = 50
STORED_REQUESTS = 5
STORED_TODOS = 10


@dataclass
class LedgerTodo:
    """One material or section the turn promised to produce.

    ``id`` comes from the conversation's own counter and never changes, so the
    number the model writes down in one message still names this todo in the
    next one. ``done`` and ``material_id`` live for the turn that completes it:
    a done todo leaves the ledger when it is stored.
    """

    id: int
    text: str
    done: bool = False
    material_id: str = ""


@dataclass
class LedgerMaterial:
    """A material created, or a section appended to one (``kind`` "edit")."""

    id: str
    kind: str
    title: str
    size: str
    todo: int | None = None


@dataclass
class LedgerRead:
    """One library excerpt this turn read, at one chunk position."""

    excerpt_id: str
    start: int
    section: str


def _stored_list(stored: dict[str, Any], key: str) -> list[Any]:
    """One array of a stored ledger. Raised into ``from_stored``'s log."""
    value = stored.get(key) or []
    if not isinstance(value, list):
        raise TypeError(f"{key} is {type(value).__name__}, not a list")
    return value


def _stored_objects(stored: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """One array of a stored ledger whose entries are objects."""
    entries = _stored_list(stored, key)
    for entry in entries:
        if not isinstance(entry, dict):
            raise TypeError(f"{key} holds a {type(entry).__name__}, not an object")
    return entries


@dataclass
class Ledger:
    """One curate conversation's progress ledger.

    It belongs to the conversation, not the turn: the requests the learner has
    made, the todos they were broken into and the materials produced all carry
    across turns through ``conversations.ledger``. A turn loads it, adds its own
    request and updates todos with ``create_ledger``, marks todos done as the writes
    land, and stores it again at turn end. Retained full library evidence can also satisfy reads.

    It rides right after the query on every call and is never part of the
    message history, so it is the one place the model sees what it has done.
    """

    requests: list[str] = field(default_factory=list)
    todos: list[LedgerTodo] = field(default_factory=list)
    materials: list[LedgerMaterial] = field(default_factory=list)
    # The conversation's todo counter: the next id ``add`` hands out. It is
    # stored, so an id is never reused after its todo leaves the ledger.
    next_todo_id: int = 0
    # This turn only, and never stored: what the model read to write with.
    reads: list[LedgerRead] = field(default_factory=list)
    # Only the first changed plan in a turn counts toward the stall guard.
    written: bool = False
    # Something this turn changed has to be written back at turn end.
    dirty: bool = False
    # Monotonic count of this turn's real progress: its create_ledger call, then
    # each completed todo. The stall guard compares it across a response, so a
    # repeated read leaves it alone.
    progress: int = 0

    @classmethod
    def from_stored(cls, stored: Any, conversation: str = "") -> Ledger:
        """The conversation's stored ledger, or an empty one.

        Total: the row is read again on every turn, so a shape this code does
        not understand would otherwise break the conversation for good. It is
        logged against the conversation and the turn starts from nothing. A
        shape that is not the one ``stored`` writes is malformed rather than
        something to coerce: a dict where a list belongs would otherwise read
        as its keys, and a todo id the counter has already handed out would
        let two todos answer to the same number.
        """
        if stored is None:
            return cls()
        try:
            if not isinstance(stored, dict):
                raise TypeError(f"ledger is {type(stored).__name__}, not an object")
            ledger = cls(
                requests=[str(request) for request in _stored_list(stored, "requests")],
                next_todo_id=int(stored.get("next_todo_id") or 0),
                todos=[
                    LedgerTodo(id=int(todo.get("id")), text=str(todo.get("text") or ""))
                    for todo in _stored_objects(stored, "todos")
                ],
                materials=[
                    LedgerMaterial(
                        id=str(material.get("id") or ""),
                        kind=str(material.get("kind") or ""),
                        title=str(material.get("title") or ""),
                        size=str(material.get("size") or ""),
                        todo=None
                        if material.get("todo") is None
                        else int(material["todo"]),
                    )
                    for material in _stored_objects(stored, "materials")
                ],
            )
            if any(todo.id >= ledger.next_todo_id for todo in ledger.todos):
                raise ValueError("next_todo_id is not past every stored todo id")
            return ledger
        except (AttributeError, TypeError, ValueError) as exc:
            log.error(
                "stored curate ledger is malformed (%s); starting this turn from "
                "an empty ledger. conversation=%s",
                exc,
                conversation or "unknown",
            )
            return cls()

    def stored(self) -> dict[str, Any]:
        """The ledger as the gateway persists it, bounded so a long conversation
        stays under the gateway's 64 KiB cap.

        Only what the next turn still needs: the newest ``STORED_TODOS`` open
        todos, the last ``STORED_MATERIALS`` materials and the last
        ``STORED_REQUESTS`` requests. Done todos drop because the material
        entry records what they produced, and it keeps the id of the todo it
        completed even when that todo has dropped. Ids never move, so nothing
        here is renumbered. Reads are this turn's only and are never stored.
        """
        return {
            "requests": self.requests[-STORED_REQUESTS:],
            "next_todo_id": self.next_todo_id,
            "todos": [
                {"id": todo.id, "text": todo.text}
                for todo in self.todos
                if not todo.done
            ][-STORED_TODOS:],
            "materials": [
                {
                    "id": material.id,
                    "kind": material.kind,
                    "title": material.title,
                    "size": material.size,
                    "todo": material.todo,
                }
                for material in self.materials[-STORED_MATERIALS:]
            ],
        }

    @property
    def exists(self) -> bool:
        return bool(self.requests)

    def add(self, request: str, todos: list[str]) -> list[LedgerTodo]:
        """Add this turn's request and its todos, each with a fresh id."""
        self.requests.append(request)
        added = [
            LedgerTodo(id=self.next_todo_id + n, text=text)
            for n, text in enumerate(todos)
        ]
        self.next_todo_id += len(added)
        self.todos.extend(added)
        self.written = True
        self.dirty = True
        self.progress += 1
        return added

    def open_todos(self) -> list[int]:
        """The ids the write tools accept right now."""
        return [todo.id for todo in self.todos if not todo.done]

    def todo(self, todo_id: int) -> LedgerTodo | None:
        return next((todo for todo in self.todos if todo.id == todo_id), None)

    def note_read(self, excerpt_id: str, start: int, section: str) -> bool:
        """Record one read. False when this exact position was already read."""
        if any(r.excerpt_id == excerpt_id and r.start == start for r in self.reads):
            return False
        self.reads.append(
            LedgerRead(excerpt_id=excerpt_id, start=start, section=section)
        )
        return True

    def read_ids(self) -> set[str]:
        return {read.excerpt_id for read in self.reads}

    def note_material(self, material: LedgerMaterial) -> None:
        self.materials.append(material)
        self.dirty = True
        todo = None if material.todo is None else self.todo(material.todo)
        if todo is None:
            return
        if not todo.done:
            todo.done = True
            self.progress += 1
        todo.material_id = material.id


@dataclass
class ToolContext:
    workspace_id: str
    user_id: str = ""
    # Curate mode: the library tools are offered, materials carry library
    # provenance, and the conversation keeps a progress ledger instead of
    # citations. The ledger is loaded from the chat request at turn start.
    curate: bool = False
    ledger: Ledger = field(default_factory=Ledger)
    library_evidence: CurateEvidence = field(default_factory=CurateEvidence)
    # The library's subjects that hold excerpts, fetched once per turn for the
    # browse_knowledge description, and the topics of each subject browsed
    # this turn, which is where search_knowledge topic ids come from.
    library_catalog: list[dict[str, Any]] | None = None
    subject_topics: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    # Resource operations the gateway granted this actor for the turn
    # (contract.OPERATIONS names). Tools whose required operations are not all
    # present are neither offered nor dispatched.
    operations: frozenset[str] = frozenset()
    # None is the unrestricted workspace scope. A list is a restricted scope,
    # and an empty list stays empty: trashing the last selected file must not
    # widen the scope to every file.
    file_ids: list[str] | None = None
    citations: list[Passage] = field(default_factory=list)
    evidence_notes: list[dict[str, Any]] = field(default_factory=list)
    evidence_passage_ids: set[str] = field(default_factory=set)
    assistant_message_id: str = ""
    budget: TurnBudget | None = None
    pending_sources: pending.PendingSources = field(
        default_factory=pending.PendingSources
    )
    # One entry per search_workspace call this turn, written to
    # rag_search_events when the turn ends (agent.run_agent fills `cited`).
    search_events: list[dict[str, Any]] = field(default_factory=list)
    # capture_page records for the activity blocks, and the JPEGs (by tool
    # call id) the next model request carries. Both live for this turn only.
    captures: list[dict[str, Any]] = field(default_factory=list)
    pending_images: dict[str, tuple[str, str]] = field(default_factory=dict)
    _scope_outline: dict[str, Any] | None = field(default=None, repr=False)


Handler = Callable[[dict[str, Any], ToolContext], Awaitable[ToolResult]]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    handler: Handler

    @property
    def definition(self) -> dict[str, Any]:
        return contract.DEFINITIONS[self.name]

    @property
    def mutates(self) -> bool:
        return bool(self.definition["mutates"])


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


async def _refuse_note_as_file(ctx: ToolContext, resource_id: str) -> ToolResult | None:
    """Notes share the search scope with files but are not source files: the
    file lifecycle and edit tools must not accept a note id under that kind."""
    outline = await _scope_outline(ctx)
    for item in outline.get("files") or []:
        if str(item["id"]) == resource_id and item.get("kind") == "material":
            return _refused(
                "That id is a note, not a source file; target it as kind material.",
                code="unavailable_target",
            )
    return None


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
    if ctx.file_ids is not None and any(
        file_id not in file_by_id for file_id in ctx.file_ids
    ):
        return _refused(_INVALID_SCOPE, code="unavailable_target")
    allowed = set(ctx.file_ids) if ctx.file_ids is not None else set(file_by_id)
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
        indexed=(
            any(int(file.get("chunks") or 0) > 0 for file in selected_files)
            or any(file["fileId"] in selected for file in ctx.pending_sources.files)
        ),
    )


async def resolve_current_scope(ctx: ToolContext) -> ResolvedScope | ToolResult:
    return await _resolve_scope(ctx, _MISSING)


def operation_id(assistant_message_id: str, tool_call_id: str) -> str:
    """The durable identity of one chat tool call.

    Go derives the same value (store.ChatOperationID) so a lost response can be
    reconciled through the receipt read; both sides are pinned by a fixture
    test against the same literal.
    """
    digest = hashlib.sha256(
        f"{assistant_message_id}\n{tool_call_id}".encode()
    ).hexdigest()
    return "op_" + digest[:24]


def _result(text: str, *, passages: list[Passage] | None = None) -> ToolResult:
    return ToolResult(text_parts=[text], passages=list(passages or []))


def _refused(text: str, *, code: str = "invalid_input") -> ToolResult:
    return ToolResult(text_parts=[text], error=text, error_code=code, refused=True)


def _failed(text: str, *, code: str = "unavailable_target") -> ToolResult:
    return ToolResult(text_parts=[text], error=text, error_code=code, failed=True)


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
    stats = SearchStats()
    await ctx.pending_sources.validate()
    passages = await search(
        workspace_id=ctx.workspace_id,
        query=query,
        file_ids=resolved.file_ids or None,
        stats=stats,
    )
    shown = {p.chunk_id for p in ctx.citations}
    overlap = sum(1 for p in passages if p.chunk_id in shown)
    ctx.search_events.append(
        _search_event(
            index=len(ctx.search_events) + 1,
            stats=stats,
            scope_files=len(resolved.file_ids),
            passages=passages,
            overlap=overlap,
        )
    )
    if not passages:
        return _result(
            "No passages matched. Try different wording, or list_sources first."
        )
    return ToolResult(
        passages=passages,
        text_parts=[_overlap_footer(overlap, len(passages))],
    )


def _search_event(
    *,
    index: int,
    stats: SearchStats,
    scope_files: int,
    passages: list[Passage],
    overlap: int,
) -> dict[str, Any]:
    return {
        "search_index": index,
        "hits_lang": stats.hits_lang,
        "query_terms": stats.query_terms,
        "cjk_runs": stats.cjk_runs,
        "scope_files": scope_files,
        "embed_ms": stats.embed_ms,
        "sql_ms": stats.sql_ms,
        "hits": len(passages),
        "prior_overlap": overlap,
        "chunk_ids": [p.chunk_id for p in passages],
        "file_ids": [p.file_id for p in passages],
        "chunk_langs": [p.lang for p in passages],
        "vec_ranks": [p.vec_rank for p in passages],
        "lex_ranks": [p.lex_rank for p in passages],
        "vec_dists": [p.vec_dist for p in passages],
        "tier_only": [p.tier_only for p in passages],
        "cited": [False] * len(passages),
    }


def _overlap_footer(overlap: int, hits: int) -> str:
    """Tell the model when a search mostly re-found what it already has.

    On the lab corpus a plausible-but-absent topic (Hardy-Weinberg in a
    workspace that never mentions it) drew three or four rewordings in one
    turn, each returning the same passages, before the model gave up. The
    index does not get closer with rewording; saying so is the stop signal.
    """
    if hits < 2 or overlap * 2 < hits:
        return ""
    return (
        f"{overlap} of these {hits} passages were already returned earlier in "
        "this turn. The workspace has nothing closer on this wording; if these "
        "do not answer the question, say what the workspace does not cover "
        "rather than searching again."
    )


async def _list_sources(_args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id:
        return _refused(
            "Source listing is unavailable for this user.", code="lifecycle_rejected"
        )
    body = await _gateway_read(
        "/api/internal/documents/list",
        {"workspaceId": ctx.workspace_id, "userId": ctx.user_id},
        "list the sources",
    )
    if isinstance(body, ToolResult):
        return body
    outline = await store.workspace_outline(ctx.workspace_id)
    return _source_listing(outline, body["items"], ctx.file_ids)


def _source_listing(
    outline: dict[str, Any],
    documents: list[dict[str, Any]],
    file_ids: list[str] | None,
) -> ToolResult:
    sources = {item["id"]: item for item in documents if item["kind"] == "source_file"}
    allowed = None if file_ids is None else set(file_ids)
    lines: list[str] = []
    by_chapter: dict[str | None, list[dict[str, Any]]] = {}
    for file in outline["files"]:
        if file["id"] not in sources or (
            allowed is not None and file["id"] not in allowed
        ):
            continue
        by_chapter.setdefault(file["chapter_id"], []).append(file)
    for chapter in outline["chapters"]:
        files = by_chapter.pop(chapter["id"], [])
        if not files:
            continue
        lines.append(f"\n## {chapter['name']}")
        lines.extend(_file_line(f, sources[f["id"]]["editable"]) for f in files)
    unfiled = [f for files in by_chapter.values() for f in files]
    if unfiled:
        lines.append("\n## Unfiled")
        lines.extend(_file_line(f, sources[f["id"]]["editable"]) for f in unfiled)
    materials = [item for item in documents if item["kind"] == "material"]
    if materials:
        lines.append("\n## Study materials")
        lines.extend(_material_line(item) for item in materials)
    return _result(
        "\n".join(lines)
        if lines
        else "This workspace has no sources or materials in scope."
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
    outline = await _scope_outline(ctx)
    notes = {
        str(item["id"])
        for item in outline.get("files") or []
        if item.get("kind") == "material"
    }
    file_ids = [fid for fid in resolved.file_ids if fid not in notes]
    rows = await store.file_summaries(ctx.workspace_id, file_ids)
    lines: list[str] = []
    for file in rows:
        head = f"### {file['name']} (file_id={file['id']})"
        body = file.get("summary") or file.get("descriptor") or "(no summary yet)"
        lines.append(f"{head}\n{body}")
    for note_id in (fid for fid in resolved.file_ids if fid in notes):
        lines.append(await _describe_note(note_id, ctx.workspace_id))
    if not lines:
        return _result("No summaries for those documents.")
    return _result("\n\n".join(lines))


_NOTE_EXCERPT_WORDS = 250


async def _describe_note(note_id: str, workspace_id: str) -> str:
    """A note has no summary: its heading outline, or its first words when it
    has no headings."""
    try:
        resp = await asyncio.to_thread(
            _get_json,
            f"/api/internal/materials/{note_id}/index-text?workspaceId={workspace_id}",
        )
    except requests.RequestException as exc:
        return f"### (id={note_id})\nCould not read the note: {exc}"
    if resp.status_code != 200:
        return f"### (id={note_id})\nThe note is not available."
    body = resp.json() if isinstance(resp.json(), dict) else {}
    text = str(body.get("text") or "")
    head = f"### {body.get('title') or ''} (id={note_id}, kind=material)"
    headings = [
        line.strip() for line in text.splitlines() if line.lstrip().startswith("#")
    ]
    if headings:
        return head + "\n" + "\n".join(headings)
    words = text.split()
    excerpt = " ".join(words[:_NOTE_EXCERPT_WORDS])
    if len(words) > _NOTE_EXCERPT_WORDS:
        excerpt += " …"
    return head + "\n" + (excerpt or "(empty note)")


def _material_line(item: dict[str, Any]) -> str:
    line = (
        f"- {item['title']} (id={item['id']}, kind=material, "
        f"material_kind={item['materialKind']}, editable={str(item['editable']).lower()})"
    )
    if item["materialKind"] != "note":
        # Only notes are indexed and outlined; the other kinds read as blocks.
        line += "; inspect_document and edit_document take its id"
    return line


def _file_line(file: dict[str, Any], editable: bool) -> str:
    head = (
        f"- {file['name']} (file_id={file['id']}, kind=source_file, "
        f"editable={str(editable).lower()}, {file['chunks']} passages)"
    )
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


def _cites_page(passage: Passage, file_id: str, page: int) -> bool:
    if passage.file_id != file_id:
        return False
    if passage.page_start is None:
        # A page-less passage (an image's caption, a text file) cites page 1
        # only; render_file knows whether that file has a page to show.
        return page == 1
    return passage.page_start <= page <= (passage.page_end or passage.page_start)


async def _capture_page(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Render a cited page (or a box on it) and attach it to the next request.

    Only pages a shown passage cites can be captured, so the model cannot
    browse the document by pixels, and a capture adds no citation of its own:
    the tool result names the numbers already covering that page.
    """
    # No per-turn cap in curate mode: a capture is dropped when its exchange
    # folds into the turn note anyway, and a whole set of materials is one turn.
    if not ctx.curate and len(ctx.captures) >= cfg.captures_per_turn:
        return _refused(
            f"This turn already used its {cfg.captures_per_turn} capture_page calls. "
            "Answer from what you have seen.",
            code="limit_reached",
        )
    file_id, page, bbox = args["file_id"], args["page"], args.get("bbox")
    refused = await _refuse_note_as_file(ctx, file_id)
    if refused is not None:
        return refused
    resolved = await _resolve_scope(ctx, {"file_ids": [file_id]})
    if isinstance(resolved, ToolResult):
        return resolved
    existing = [
        i + 1
        for i, passage in enumerate(ctx.citations)
        if _cites_page(passage, file_id, page)
    ]
    if not existing:
        return _refused(
            "Retrieve a passage that shows this page first, then capture it."
        )
    started = time.perf_counter()
    try:
        jpeg, box, size = await capture.render_file(
            ctx.workspace_id, file_id, page, bbox, cfg.capture_max_edge
        )
    except capture.CaptureUnavailable as exc:
        return _refused(f"capture_page: {exc}", code=exc.code)
    except ValueError as exc:
        return _refused(f"capture_page: {exc}")
    call_id = str(args.get("_tool_call_id") or "")
    n = len(ctx.captures) + 1
    label = f"{resolved.file_names[0]} page {page}" + (
        f" region {[int(v) for v in box]}" if bbox else ""
    )
    ctx.captures.append(
        capture.record(
            call_id=call_id,
            file_id=file_id,
            page=page,
            box=box,
            jpeg=jpeg,
            size=size,
            started=started,
        )
    )
    ctx.pending_images[call_id] = (
        f"capture_page result {n}: {label}",
        capture.data_url(jpeg),
    )
    numbers = "".join(f"[{i}]" for i in existing)
    return _result(
        f"Captured {label}. The rendered image is attached to the next message; "
        "read it directly. This page is already in the evidence as "
        f"{numbers}; cite those numbers for what the capture shows."
    )


# ------------------------------------------------ knowledge library tools


async def load_library_catalog(ctx: ToolContext) -> None:
    """Read the library's subject list once, for the tool descriptions."""
    if not ctx.curate or ctx.library_catalog is not None or not library.enabled():
        return
    db = await library.pool()
    async with db.connection() as conn:
        ctx.library_catalog = await library.catalog(conn)


def _catalog_lines(catalog: list[dict[str, Any]]) -> str:
    lines = []
    for subject in catalog:
        aliases = ", ".join(str(a) for a in (subject.get("aliases") or []))
        lines.append(
            f"- {subject['id']}: {subject['label']}"
            + (f" (also: {aliases})" if aliases else "")
            + f" — {int(subject.get('excerpts') or 0)} excerpts"
        )
    return "\n".join(lines)


async def _unknown_topics(ctx: ToolContext, topics: list[str]) -> list[str]:
    """Topic ids the library does not hold.

    Ids seen in a subject browse this turn are known; the rest are checked
    against the library in one query, so a model that skips browsing still
    gets a refusal naming the ids rather than an empty search.
    """
    known = {str(t["id"]) for ts in ctx.subject_topics.values() for t in ts}
    unchecked = [topic for topic in topics if topic not in known]
    if not unchecked:
        return []
    held = await library.known_topics(unchecked)
    return [topic for topic in unchecked if topic not in held]


def _facets(args: dict[str, Any]) -> tuple[list[str], list[str]]:
    topics = [str(t) for t in (args.get("topics") or [])]
    roles = [str(r) for r in (args.get("roles") or [])]
    return topics, roles


def _excerpt_head(excerpt: library.Excerpt) -> str:
    pages = ", ".join(str(p) for p in excerpt.pages)
    return f"[{excerpt.id}] {excerpt.book_title} — {excerpt.section_path}" + (
        f" (pages {pages})" if pages else ""
    )


def _excerpt_facets(excerpt: library.Excerpt) -> str:
    parts = [
        f"roles: {', '.join(excerpt.roles)}",
        f"topics: {', '.join(excerpt.topic_ids)}",
    ]
    if excerpt.figure_ids:
        parts.append(f"figures: {', '.join(excerpt.figure_ids)}")
    return " | ".join(parts)


def _excerpt_scope(excerpt: library.Excerpt) -> str:
    if excerpt.retrieval is None:
        return "Scope not reviewed. Check the source's applicability before using it."
    metadata = excerpt.retrieval
    text = f"teaches: {metadata['summary']}\nscope: {metadata['scope']}"
    if metadata["context_excerpt_ids"]:
        text += "\nSource context (scope explains when needed): " + ", ".join(
            metadata["context_excerpt_ids"]
        )
    return text


def _no_excerpts(
    topics: list[str], roles: list[str], available: dict[str, int] | None
) -> str:
    """What an empty search means. Counts only say something under topics.

    Without a topic filter the by-role numbers are the whole library's and
    carry no information about the query, so the model is pointed at the
    filter it did not use instead.
    """
    head = (
        f"No verified excerpt matches roles {', '.join(roles) or 'any'} on topics "
        f"{', '.join(topics) or 'any'}."
    )
    if not topics:
        return (
            f"{head} This search had no topic filter. Browse a subject from the "
            "browse_knowledge description to get its topic ids, then pass "
            "topics to see what the library holds for them by role."
        )
    held = ", ".join(f"{role} {count}" for role, count in (available or {}).items())
    if held:
        return f"{head} Those topics hold: {held}."
    return f"{head} Browse one of those topics to see what it does hold."


async def _search_knowledge(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    query = str(args.get("query") or "").strip()
    if not query:
        return _refused("search_knowledge needs a query.")
    topics, roles = _facets(args)
    unknown = await _unknown_topics(ctx, topics)
    if unknown:
        return _refused(
            f"Unknown topic ids {unknown}. Topic ids come from browsing a subject "
            "listed in the browse_knowledge description."
        )
    if ctx.budget is not None:
        ctx.budget.embedding_calls += 1
    try:
        result = await library.search(query, topics=topics, roles=roles)
    except ValueError as exc:
        return _refused(f"search_knowledge: {exc}")
    if not result.excerpts:
        return _result(_no_excerpts(topics, roles, result.available_roles))
    blocks = []
    for excerpt in result.excerpts:
        blocks.append(
            "\n".join(
                [
                    _excerpt_head(excerpt),
                    _excerpt_facets(excerpt),
                    _excerpt_scope(excerpt),
                    excerpt.hit_text,
                ]
            )
        )
    return _result(
        "\n\n".join(blocks)
        + "\n\nRead an excerpt in full with read_knowledge before writing from it."
    )


def _subject_browse(result: dict[str, Any]) -> str:
    """One line per topic with its count; the topic ids are what search takes."""
    subject = result["subject"]
    topics = result["topics"]
    head = f"{subject['id']}: {subject['label']} — {len(topics)} topics"
    if not topics:
        return f"{head}. The library holds no topic for this subject yet."
    lines = [
        f"- {t['id']}: {t['label']}"
        + (f" — {t['scope']}" if t.get("scope") else "")
        + f" ({int(t.get('excerpts') or 0)} excerpts)"
        for t in topics
    ]
    return (
        head
        + "\n"
        + "\n".join(lines)
        + "\n\nBrowse a topic id next to see its excerpts by role and book, or "
        "pass topic ids to search_knowledge."
    )


async def _browse_knowledge(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    subject = str(args.get("subject") or "").strip()
    topic = str(args.get("topic") or "").strip()
    if bool(subject) == bool(topic):
        return _refused(
            "browse_knowledge takes exactly one of subject (a subject id from "
            "this tool's description) or topic (a topic id from a subject browse)."
        )
    # Dispatch on the argument given, never on which catalog holds the id: a
    # topic id may coincide with a subject id.
    try:
        if subject:
            listing = await library.browse_subject(subject)
            ctx.subject_topics[subject] = listing["topics"]
            return _result(_subject_browse(listing))
        result = await library.browse(topic, page=int(args.get("page") or 1))
    except ValueError as exc:
        return _refused(f"browse_knowledge: {exc}")
    by_role = ", ".join(f"{role} {count}" for role, count in result.by_role.items())
    by_book = ", ".join(f"{book} {count}" for book, count in result.by_book.items())
    counts = (
        f"{result.total} verified excerpts. By book: {by_book or 'none'}. "
        "Role assignments (an excerpt counts once per role it carries): "
        f"{by_role or 'none'}."
    )
    head = [
        f"{result.topic['id']}: {result.topic['label']} — {result.topic['scope']}",
        counts,
    ]
    items = [
        f"{_excerpt_head(excerpt)}\n{_excerpt_facets(excerpt)}\n{_excerpt_scope(excerpt)}"
        for excerpt in result.items
    ]
    tail = ""
    if result.page * result.page_size < result.total:
        tail = f"\n\n(next page = {result.page + 1})"
    return _result("\n".join(head) + "\n\n" + "\n\n".join(items) + tail)


def _short_section(section_path: str) -> str:
    """The last one or two segments of a section path, for a ledger line."""
    parts = [
        part.strip()
        for part in section_path.replace("›", ">").split(">")
        if part.strip()
    ]
    return " > ".join(parts[-2:])[:120] if parts else ""


async def _read_knowledge(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    excerpt_id = str(args.get("excerpt_id") or "").strip()
    start = max(0, int(args.get("start") or 0))
    try:
        read = await library.read_excerpt(excerpt_id, start=start)
    except ValueError as exc:
        return _refused(f"read_knowledge: {exc}")
    if not read.chunks:
        return _result(f"Excerpt {excerpt_id} has no text at chunk {start}.")
    body = "\n\n".join(
        f"(chunk {chunk['chunk_idx']}) {chunk['text']}" for chunk in read.chunks
    )
    tail = (
        f"\n\n(next start = {read.next_start})"
        if read.next_start is not None
        else "\n\n(end of excerpt)"
    )
    ctx.ledger.note_read(
        read.excerpt.id, start, _short_section(read.excerpt.section_path)
    )
    return _result(
        _excerpt_head(read.excerpt)
        + "\n"
        + _excerpt_facets(read.excerpt)
        + "\n"
        + _excerpt_scope(read.excerpt)
        + f"\nchunks {read.first}-{read.last} of this excerpt, from {start}"
        + (
            f"\n\nFull reviewed notes: {read.excerpt.synopsis}"
            if start <= read.first
            else ""
        )
        + "\n\n"
        + body
        + tail
    )


async def _create_ledger(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Apply ledger edits atomically, preserving work and stable todo IDs."""
    ledger = ctx.ledger
    body = args.get("body")
    if not ledger.exists and body is None:
        return _refused(
            "Supply body to create the first ledger; null only keeps an existing body."
        )
    todos = {todo.id: replace(todo) for todo in ledger.todos}
    next_id = ledger.next_todo_id
    for item in args.get("todos", []):
        text = (item if isinstance(item, str) else item["todo"]).strip()
        if not text:
            return _refused("Each todo needs non-empty text.")
        if isinstance(item, str):
            todos[next_id] = LedgerTodo(id=next_id, text=text)
            next_id += 1
        else:
            todo_id = item["id"]
            if todo_id not in todos:
                if todo_id < ledger.next_todo_id:
                    return _refused(
                        f"Todo {todo_id} was already used. Add a new todo with a fresh ID or a string."
                    )
                todos[todo_id] = LedgerTodo(id=todo_id, text=text)
                next_id = max(next_id, todo_id + 1)
            else:
                todos[todo_id].text = text
    if sum(not todo.done for todo in todos.values()) > STORED_TODOS:
        return _refused(
            "The ledger can hold at most 10 unfinished todos; this update changed nothing."
        )
    requests = ledger.requests if body is None else [body]
    updated = list(todos.values())
    if updated == ledger.todos and requests == ledger.requests:
        return _result("Ledger unchanged.")
    ledger.requests, ledger.todos, ledger.next_todo_id = requests, updated, next_id
    # Only the first plan write in a turn counts as progress, as in production.
    if not ledger.written:
        ledger.progress += 1
    ledger.written = ledger.dirty = True
    listing = "\n".join(f"[ ] {t.id}. {t.text}" for t in ledger.todos if not t.done)
    return _result(
        f"Ledger updated.\nBody: {ledger.requests[-1]}\n\nOpen todos:\n{listing or '(none)'}"
    )


async def _capture_knowledge_page(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Render a page of the book behind a library excerpt.

    The excerpt is the unit the model works in, so only its own pages and the
    pages of its figures can be captured. Like ``capture_page`` it adds no
    citation: a curate turn has none, and the attribution lives on the material.
    Curate mode has no per-turn capture cap.
    """
    excerpt_id, page, bbox = args["excerpt_id"], args["page"], args.get("bbox")
    try:
        target = await library.capture_target(excerpt_id)
    except ValueError as exc:
        return _refused(f"capture_knowledge_page: {exc}")
    if page not in target.pages:
        pages = ", ".join(str(p) for p in target.pages) or "none"
        return _refused(
            f"Excerpt {excerpt_id} covers pages {pages}; capture one of those."
        )
    started = time.perf_counter()
    try:
        jpeg, box, size = await capture.render_knowledge(
            target.object_key, target.bytes, page, bbox, cfg.capture_max_edge
        )
    except capture.CaptureUnavailable as exc:
        return _refused(f"capture_knowledge_page: {exc}", code=exc.code)
    except ValueError as exc:
        return _refused(f"capture_knowledge_page: {exc}")
    call_id = str(args.get("_tool_call_id") or "")
    n = len(ctx.captures) + 1
    label = f"{target.book_title} page {page}" + (
        f" region {[int(v) for v in box]}" if bbox else ""
    )
    ctx.captures.append(
        capture.record(
            call_id=call_id,
            file_id=target.excerpt_id,
            page=page,
            box=box,
            jpeg=jpeg,
            size=size,
            started=started,
        )
    )
    ctx.pending_images[call_id] = (
        f"capture_knowledge_page result {n}: {label}",
        capture.data_url(jpeg),
    )
    return _result(
        f"Captured {label}. The rendered image is attached to the next message; "
        "read it directly."
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


def _receipt_result(body: dict[str, Any]) -> ToolResult:
    """Turn a recorded agent operation (Go receipt) into the tool result."""
    effect = body.get("effect")
    if not isinstance(effect, dict) or body.get("outcome") != "succeeded":
        error = body.get("error") if isinstance(body.get("error"), dict) else {}
        return _failed(
            str(error.get("message") or "The recorded operation did not succeed."),
            code=str(error.get("code") or "outcome_unknown"),
        )
    resource = effect.get("resource") or {}
    title, rid = resource.get("title"), resource.get("id")
    operation = effect.get("operation")
    if operation == "trashed":
        text = (
            f"Moved '{title}' (id {rid}) to the trash. Passages retrieved from it "
            "earlier in this turn are no longer current evidence; do not cite them. "
            "The workspace owner can restore it from Files › Trash within 30 days."
        )
    elif operation == "restored":
        text = f"Restored '{title}' (id {rid}). It is active in the workspace again."
    elif operation == "edited":
        pending_note = (
            " Indexing of the change is pending."
            if effect.get("projectionPending")
            else ""
        )
        text = f"Edited '{title}' (id {rid}).{pending_note} The user can undo this edit from the chat result."
    elif operation == "edit_undone":
        text = f"Reversed the earlier edit of '{title}' (id {rid})."
    else:
        text = (
            f"Created {resource.get('materialKind')} '{title}' (id {rid}). "
            "It is now in the workspace."
        )
    return ToolResult(text_parts=[text], effects=[effect])


async def _create_material(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id:
        return _refused(
            "Material creation is unavailable for this user.",
            code="lifecycle_rejected",
        )
    if not ctx.assistant_message_id:
        return _refused("Material creation needs the assistant message id.")
    kind = str(args["kind"])
    call_id = str(args.get("_tool_call_id") or "")
    if not call_id:
        return _refused("create_material is missing its tool-call id.")
    prepared = await curate_write(ctx, "create_material", args)
    if isinstance(prepared, ToolResult):
        return prepared
    books, todo = prepared
    resolved = await _resolve_scope(ctx, args.get("scope", _MISSING))
    if isinstance(resolved, ToolResult):
        return resolved
    # A material written from the library is grounded in the library, so it
    # does not need indexed workspace content.
    if not resolved.indexed and not books:
        return _refused(
            "The requested scope has no indexed content.", code="unavailable_target"
        )
    op_id = operation_id(ctx.assistant_message_id, call_id)
    payload = {
        "workspaceId": ctx.workspace_id,
        "userId": ctx.user_id,
        "assistantMessageId": ctx.assistant_message_id,
        "toolCallId": call_id,
        "kind": kind,
        # Model output must fit the materials.title column; the API disambiguates
        # duplicates and only reserves room for its own suffix.
        "title": str(args.get("title") or "").strip()[:MATERIAL_TITLE_MAX].strip(),
        "cards": args.get("cards") or [],
        "questions": args.get("questions") or [],
        "content": args.get("content") or "",
        "fileIds": resolved.file_ids,
        "chapterIds": resolved.chapter_ids,
    }
    if books:
        # Go validates the shape and computes the material's own licence.
        payload["provenance"] = {"books": books}

    await ctx.pending_sources.validate()
    result = await _post_operation(
        "/api/internal/materials", payload, op_id, ctx, failure=f"create the {kind}"
    )
    if ctx.curate and result.effects:
        note_created(ctx, result.effects[0], kind, args, todo)
    return result


def _material_size(kind: str, args: dict[str, Any]) -> str:
    if kind == "quiz":
        return f"{len(args.get('questions') or [])} questions"
    if kind == "flashcards":
        return f"{len(args.get('cards') or [])} cards"
    return f"{estimate_tokens(str(args.get('content') or ''))} tokens"


# ------------------------------------------------------- curate-mode writes


def _next_move(ledger: Ledger) -> str:
    """Explain how to complete open work or extend the plan."""
    listing = ", ".join(str(todo_id) for todo_id in ledger.open_todos())
    if not listing:
        return (
            "Every todo on the ledger is done. Finish this turn by replying with "
            "the list of materials you created, or add a todo if the learner requested "
            "more work that is not covered yet."
        )
    return f"Open todos: {listing}."


async def curate_write(
    ctx: ToolContext,
    tool: str,
    args: dict[str, Any],
    *,
    material: bool = True,
) -> tuple[list[dict[str, Any]], int | None] | ToolResult:
    """Check a curate write and resolve its provenance, or refuse it.

    Returns the provenance books (one entry per source book) and the ledger
    todo this write completes. Shared with the playground's local write stubs,
    so the rules have one implementation. ``material`` is false for an edit of
    the user's own source file, which carries no provenance and no todo.
    """
    excerpt_ids = [str(e) for e in (args.get("excerpt_ids") or [])]
    if not ctx.curate:
        if excerpt_ids:
            return _refused("excerpt_ids are only available in curate mode.")
        return [], None
    if not material:
        # Provenance is what a work was written from; a workspace source file is
        # the user's own text, so the ledger rules do not reach it. Both are
        # refused rather than ignored: a silently dropped todo would leave the
        # model believing it closed one.
        if excerpt_ids:
            return _refused(
                "excerpt_ids belong to a study material written from the "
                "library; a source file carries no provenance."
            )
        if args.get("todo") is not None:
            return _refused(
                "Editing one of the user's own source files completes no ledger "
                "todo, so it takes no todo. Call it again without one."
            )
        return [], None
    if not ctx.ledger.exists:
        return _refused(
            f"There is no ledger yet. Call create_ledger with the plan before {tool}."
        )
    raw_todo = args.get("todo")
    if raw_todo is None:
        return _refused(
            f"{tool} needs todo, the id of the ledger todo it completes. "
            f"{_next_move(ctx.ledger)}"
        )
    todo = int(raw_todo)
    entry = ctx.ledger.todo(todo)
    if entry is None:
        return _refused(f"todo {todo} is not on the ledger. {_next_move(ctx.ledger)}")
    if entry.done:
        return _refused(f"todo {todo} is already done. {_next_move(ctx.ledger)}")
    read = ctx.ledger.read_ids()
    if read and not excerpt_ids:
        return _refused(
            f"{tool} needs excerpt_ids naming the library excerpts this content "
            "was written from."
        )
    unread = [e for e in excerpt_ids if e not in read]
    if unread:
        return _refused(
            f"Excerpts {unread} have no read or retained full text in this turn. read_knowledge each "
            "of them before writing from it."
        )
    if not excerpt_ids:
        return [], todo
    try:
        return await library.provenance(excerpt_ids), todo
    except ValueError as exc:
        return _refused(f"{tool}: {exc}")


def note_created(
    ctx: ToolContext,
    effect: dict[str, Any],
    kind: str,
    args: dict[str, Any],
    todo: int | None,
) -> None:
    """Record a created material on the ledger and mark the todo it completes."""
    resource = effect.get("resource") or {}
    ctx.ledger.note_material(
        LedgerMaterial(
            id=str(resource.get("id") or ""),
            kind=kind,
            title=str(resource.get("title") or ""),
            size=_material_size(kind, args),
            todo=todo,
        )
    )


def note_appended(ctx: ToolContext, rid: str, commands: int, todo: int | None) -> None:
    """Record an appended section on the ledger and mark the todo it completes."""
    ctx.ledger.note_material(
        LedgerMaterial(
            id=rid,
            kind="edit",
            title="",
            size=f"{commands} edits",
            todo=todo,
        )
    )


async def store_ledger(ctx: ToolContext) -> None:
    """Write the conversation ledger back through the gateway at turn end.

    The ledger is the conversation's memory of what is still open, so it is
    stored whenever this turn changed it, including when the turn ended on the
    stall guard or an error. A failed write loses the turn's ledger changes,
    not the turn: the materials themselves are already durable.
    """
    if not ctx.curate or not ctx.ledger.dirty:
        return
    if not _gateway_ready() or not ctx.user_id or not ctx.assistant_message_id:
        log.warning("curate ledger not stored: no gateway route for this turn")
        return
    payload = {
        "workspaceId": ctx.workspace_id,
        "userId": ctx.user_id,
        "assistantMessageId": ctx.assistant_message_id,
        "ledger": ctx.ledger.stored(),
    }

    def _post() -> requests.Response:
        return requests.post(
            _material_url("/api/internal/conversations/ledger"),
            headers=_material_headers(),
            data=json.dumps(payload),
            timeout=10,
        )

    try:
        resp = await asyncio.to_thread(_post)
    except requests.RequestException as exc:
        log.warning("curate ledger write failed: %s", exc)
        return
    if resp.status_code >= 300:
        log.warning(
            "curate ledger write failed: %s %s",
            resp.status_code,
            _response_detail(resp),
        )


async def _post_operation(
    path: str,
    payload: dict[str, Any],
    op_id: str,
    ctx: ToolContext,
    *,
    failure: str,
) -> ToolResult:
    """POST a receipt-backed mutation to the gateway.

    Transient failures retry the same operation id (Go makes it idempotent);
    a lost response is reconciled through the durable receipt read. A confirmed
    absence is a normal tool failure; an unknown outcome fails the turn.
    """
    last_exc: BaseException | None = None
    last_status = 0
    last_event_id = None
    for attempt in range(4):
        try:

            def _post() -> requests.Response:
                return requests.post(
                    _material_url(path),
                    headers=_material_headers(),
                    data=json.dumps(payload),
                    timeout=10,
                )

            resp = await asyncio.to_thread(_post)
            last_status = resp.status_code
            if resp.status_code < 300:
                return _receipt_result(resp.json())
            last_event_id = resp.headers.get(obs.ERROR_EVENT_HEADER)
            if resp.status_code in (400, 401, 403, 404, 409, 422) or not _is_transient(
                None, resp.status_code
            ):
                detail = _response_detail(resp)
                return _refused(
                    f"Could not {failure}: {detail or resp.status_code}",
                    code=_gateway_error_code(resp),
                )
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_exc = exc
            last_event_id = None
            log.warning("operation POST attempt failed: %s", exc)
        except requests.RequestException as exc:
            last_exc = exc
            last_event_id = None
            log.warning("operation POST attempt failed: %s", exc)
        if attempt < 3:
            await asyncio.sleep(0.25 * (2**attempt))
    if last_exc is not None:
        log.warning(
            "operation POST exhausted retries: %s status=%s", last_exc, last_status
        )

    recovered = await _recover_operation(op_id, ctx)
    if recovered is True:
        raise obs.with_event_id(
            TurnFailed("mutation outcome is unknown"), last_event_id
        ) from last_exc
    if recovered is None:
        return _failed(f"Could not {failure}: not found after retries.")
    return _receipt_result(recovered)


async def _recover_operation(
    op_id: str, ctx: ToolContext
) -> dict[str, Any] | None | bool:
    """Read the durable receipt for a lost response. True means still unknown."""
    try:

        def _get() -> requests.Response:
            return requests.get(
                _material_url(f"/api/internal/agent-operations/{op_id}"),
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


_GATEWAY_CODES = {
    "storage_quota_exceeded": "quota_rejected",
    "account_over_quota": "lifecycle_rejected",
    "invalid_scope": "unavailable_target",
    "scope_has_no_indexed_content": "unavailable_target",
}


def _gateway_error_code(resp: requests.Response) -> str:
    try:
        code = str(resp.json().get("code") or "")
    except ValueError:
        code = ""
    if code in contract.ERROR_CODES:
        return code
    if code in _GATEWAY_CODES:
        return _GATEWAY_CODES[code]
    if resp.status_code in (401, 403, 404):
        return "unavailable_target"
    return "invalid_input"


async def _resolve_source_change(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    file_id, change_id, checkpoint = (
        args.get("file_id"),
        args.get("change_id"),
        args.get("checkpoint"),
    )
    if (
        not isinstance(file_id, str)
        or not isinstance(change_id, str)
        or not isinstance(checkpoint, int)
    ):
        return _refused("A file id, change id and integer checkpoint are required.")
    await pending.resolve(
        sources=ctx.pending_sources,
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        file_id=file_id,
        change_id=change_id,
        checkpoint=checkpoint,
    )
    return _result(
        "Resolved source image. Its full caption is in the protected pending-source context."
    )


def _target(args: dict[str, Any]) -> tuple[str, str]:
    target = args["target"]
    return str(target["kind"]), str(target["id"])


async def _after_lifecycle_change(
    ctx: ToolContext, kind: str, rid: str, trashed: bool
) -> None:
    """Refresh this turn's own view of the workspace after a trash/restore.

    Cached outlines are dropped, a restricted scope loses the trashed file (an
    empty list stays a restricted empty scope) and the pending-source baseline
    is re-read so the acknowledged change does not read as `source_changed`.
    Unrelated publications were already validated before the mutation.
    """
    ctx._scope_outline = None
    if trashed and kind == "source_file" and ctx.file_ids is not None:
        ctx.file_ids = [fid for fid in ctx.file_ids if fid != rid]
    ctx.pending_sources = await pending.load(ctx.workspace_id, ctx.file_ids)


def _chat_context(ctx: ToolContext, call_id: str) -> dict[str, Any]:
    return {
        "workspaceId": ctx.workspace_id,
        "userId": ctx.user_id,
        "assistantMessageId": ctx.assistant_message_id,
        "toolCallId": call_id,
    }


async def _trash_file(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id or not ctx.assistant_message_id:
        return _refused(
            "Trash is unavailable for this user.", code="lifecycle_rejected"
        )
    call_id = str(args.get("_tool_call_id") or "")
    kind, rid = _target(args)
    if kind == "source_file":
        refused = await _refuse_note_as_file(ctx, rid)
        if refused is not None:
            return refused
        resolved = await _resolve_scope(ctx, {"file_ids": [rid]})
        if isinstance(resolved, ToolResult):
            return resolved
    # Detect unrelated publications first; the acknowledged change re-baselines after.
    await ctx.pending_sources.validate()
    result = await _post_operation(
        "/api/internal/trash",
        {**_chat_context(ctx, call_id), "target": {"kind": kind, "id": rid}},
        operation_id(ctx.assistant_message_id, call_id),
        ctx,
        failure=f"trash the {kind.replace('_', ' ')}",
    )
    if result.effects:
        await _after_lifecycle_change(ctx, kind, rid, trashed=True)
    return result


async def _list_trashed_files(_args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id:
        return _refused(
            "Trash is unavailable for this user.", code="lifecycle_rejected"
        )

    def _get() -> requests.Response:
        return requests.get(
            _material_url("/api/internal/trash"),
            headers=_material_headers(),
            params={"workspaceId": ctx.workspace_id, "userId": ctx.user_id},
            timeout=10,
        )

    try:
        resp = await asyncio.to_thread(_get)
    except requests.RequestException as exc:
        return _failed(f"Could not list the trash: {exc}")
    if resp.status_code != 200:
        return _refused(
            f"Could not list the trash: {_response_detail(resp) or resp.status_code}",
            code=_gateway_error_code(resp),
        )
    items = list((resp.json() or {}).get("items") or [])
    if not items:
        return _result("The trash of this workspace is empty.")
    lines = [
        (
            f"- {item.get('title')} (kind={item.get('kind')}, id={item.get('id')}, "
            f"{item.get('materialKind') or item.get('fileKind') or ''}, "
            f"trashed {item.get('trashedAt')}, expires {item.get('purgeAfter')})"
        )
        for item in items
    ]
    return _result(
        "Trashed items (use restore_file with kind and id):\n" + "\n".join(lines)
    )


async def _restore_file(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id or not ctx.assistant_message_id:
        return _refused(
            "Restore is unavailable for this user.", code="lifecycle_rejected"
        )
    call_id = str(args.get("_tool_call_id") or "")
    kind, rid = _target(args)
    await ctx.pending_sources.validate()
    result = await _post_operation(
        "/api/internal/trash/restore",
        {**_chat_context(ctx, call_id), "target": {"kind": kind, "id": rid}},
        operation_id(ctx.assistant_message_id, call_id),
        ctx,
        failure=f"restore the {kind.replace('_', ' ')}",
    )
    if result.effects:
        await _after_lifecycle_change(ctx, kind, rid, trashed=False)
    return result


def _get_json(path: str) -> requests.Response:
    return requests.get(_material_url(path), headers=_material_headers(), timeout=15)


def _post_json(path: str, payload: dict[str, Any]) -> requests.Response:
    return requests.post(
        _material_url(path),
        headers=_material_headers(),
        data=json.dumps(payload),
        timeout=15,
    )


async def _gateway_read(
    path: str, payload: dict[str, Any], failure: str
) -> dict[str, Any] | ToolResult:
    """One gateway read for a tool; refusals map to typed tool errors."""
    try:
        resp = await asyncio.to_thread(_post_json, path, payload)
    except requests.RequestException as exc:
        return _failed(f"Could not {failure}: {exc}")
    if resp.status_code != 200:
        return _refused(
            f"Could not {failure}: {_response_detail(resp) or resp.status_code}",
            code=_gateway_error_code(resp),
        )
    body = resp.json()
    return body if isinstance(body, dict) else {}


def _render_inspection(body: dict[str, Any]) -> str:
    head = [
        f"{body.get('title') or ''} format={body.get('format')}",
        "supported: " + ", ".join(body.get("supportedOperations") or []),
    ]
    lines: list[str] = []
    for block in body.get("blocks") or []:
        props = block.get("properties") or {}
        flags = " [media]" if props.get("media") else ""
        lines.append(
            f"[{block.get('id')}] ({block.get('type')}){flags} {block.get('text') or ''}"
        )
        for child in block.get("children") or []:
            lines.append(
                f"    [{child.get('id')}] ({child.get('type')}) {child.get('text') or ''}"
            )
        if props.get("source") is not None:
            lines.append(f"    source: {props['source']}")
        if props.get("refKind"):
            if props.get("materialId"):
                lines.append(
                    f"    embedded {props['refKind']} material id={props['materialId']}: "
                    "inspect it as kind material"
                )
            else:
                lines.append(
                    f"    embedded {props['refKind']} reference, not yet created"
                )
    for line in body.get("lines") or []:
        lines.append(f"{line.get('start')}: {line.get('text')}")
    for entry in body.get("entries") or []:
        lines.append(f"[{entry.get('id')}] {entry.get('label')}: {entry.get('value')}")
    if body.get("nextStart") is not None:
        lines.append(f"(next start = {body['nextStart']} of {body.get('total')})")
    return "\n".join(head + lines)


async def _inspect_document(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id:
        return _refused(
            "Document tools are unavailable for this user.", code="lifecycle_rejected"
        )
    kind, rid = _target(args)
    if kind == "source_file":
        refused = await _refuse_note_as_file(ctx, rid)
        if refused is not None:
            return refused
        resolved = await _resolve_scope(ctx, {"file_ids": [rid]})
        if isinstance(resolved, ToolResult):
            return resolved
    body = await _gateway_read(
        "/api/internal/documents/inspect",
        {
            "workspaceId": ctx.workspace_id,
            "userId": ctx.user_id,
            "target": {"kind": kind, "id": rid},
            "start": int(args.get("start") or 0),
            "count": int(args.get("count") or 60),
        },
        "inspect the document",
    )
    if isinstance(body, ToolResult):
        return body
    return _result(_render_inspection(body))


async def _edit_document(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id or not ctx.assistant_message_id:
        return _refused(
            "Document editing is unavailable for this user.", code="lifecycle_rejected"
        )
    call_id = str(args.get("_tool_call_id") or "")
    kind, rid = _target(args)
    prepared = await curate_write(
        ctx, "edit_document", args, material=kind == "material"
    )
    if isinstance(prepared, ToolResult):
        return prepared
    books, todo = prepared
    if kind == "source_file":
        refused = await _refuse_note_as_file(ctx, rid)
        if refused is not None:
            return refused
        resolved = await _resolve_scope(ctx, {"file_ids": [rid]})
        if isinstance(resolved, ToolResult):
            return resolved
        # Detect unrelated publications first; the acknowledged edit re-baselines after.
        await ctx.pending_sources.validate()
    commands = list(args.get("commands") or [])
    payload = {
        **_chat_context(ctx, call_id),
        "target": {"kind": kind, "id": rid},
        "commands": commands,
    }
    if books:
        # Go merges these books into the target's existing provenance by id.
        payload["provenance"] = {"books": books}
    result = await _post_operation(
        "/api/internal/documents/edit",
        payload,
        operation_id(ctx.assistant_message_id, call_id),
        ctx,
        failure="edit the document",
    )
    if result.effects:
        # This turn's own view: drop cached outlines and re-read the exact
        # pending evidence so the next source-dependent call sees the edit.
        ctx._scope_outline = None
        if kind == "source_file":
            ctx.pending_sources = await pending.load(ctx.workspace_id, ctx.file_ids)
        elif ctx.curate:
            note_appended(ctx, rid, len(commands), todo)
    return result


REGISTRY: dict[str, ToolSpec] = {}


def _register(name: str, handler: Handler) -> None:
    """Bind a local handler to a contract definition. Unknown names fail at import."""
    if name not in contract.DEFINITIONS:
        raise RuntimeError(f"tool {name} has no definition in the agent-tool contract")
    REGISTRY[name] = ToolSpec(name=name, handler=handler)


_register("search_workspace", _search_workspace)
_register("search_knowledge", _search_knowledge)
_register("browse_knowledge", _browse_knowledge)
_register("read_knowledge", _read_knowledge)
_register("create_ledger", _create_ledger)
_register("capture_knowledge_page", _capture_knowledge_page)
_register("list_sources", _list_sources)
_register("describe_documents", _describe_documents)
_register("read_document", _read_document)
_register("capture_page", _capture_page)
_register("create_material", _create_material)
_register("resolve_source_change", _resolve_source_change)
_register("inspect_document", _inspect_document)
_register("edit_document", _edit_document)
_register("trash_file", _trash_file)
_register("list_trashed_files", _list_trashed_files)
_register("restore_file", _restore_file)


# Offered only in a curate turn against a configured library. create_ledger is
# here too: the ledger only exists in curate mode.
KNOWLEDGE_TOOLS = (
    "search_knowledge",
    "browse_knowledge",
    "read_knowledge",
    "create_ledger",
)
KNOWLEDGE_CAPTURE = "capture_knowledge_page"


def _offered(spec: ToolSpec, ctx: ToolContext) -> bool:
    definition = spec.definition
    if not set(definition["requiredOperations"]) <= ctx.operations:
        return False
    # The ledger changes in memory and is flushed separately at turn end.
    if (
        spec.name != "create_ledger"
        and definition["mutates"]
        and not (_gateway_ready() and ctx.user_id)
    ):
        return False
    if spec.name == KNOWLEDGE_CAPTURE:
        # Without the knowledge-base bucket there is nothing to render.
        return ctx.curate and library.enabled() and bool(cfg.knowledge_base_b2_bucket)
    if spec.name in KNOWLEDGE_TOOLS:
        return ctx.curate and library.enabled()
    if spec.name != "resolve_source_change":
        return True
    return bool(
        ctx.user_id
        and _gateway_ready()
        and any(
            change.get("assetRef")
            for file in ctx.pending_sources.files
            for change in file["changes"]
        )
    )


def schemas_for(ctx: ToolContext) -> list[dict[str, Any]]:
    schemas = [
        contract.model_schema(spec.name)
        for spec in REGISTRY.values()
        if _offered(spec, ctx)
    ]
    if not ctx.curate:
        return schemas
    # Curate changes what several tools mean, so the prompt package owns their
    # descriptions here; the shared contract text stays the ordinary-chat one.
    for schema in schemas:
        override = curate_prompts.TOOL_DESCRIPTIONS.get(schema["function"]["name"])
        if override:
            schema["function"]["description"] = override
    if not ctx.library_catalog:
        return schemas
    # The model maps the learner's words onto a subject, browses it for topic
    # ids, and searches with those. The list rides on browse_knowledge only.
    catalog = (
        "\n\nSubjects this library holds (browse one for its topic ids):\n"
        + _catalog_lines(ctx.library_catalog)
    )
    for schema in schemas:
        if schema["function"]["name"] == "browse_knowledge":
            schema["function"]["description"] += catalog
    return schemas


def spec_for(name: str) -> ToolSpec | None:
    return REGISTRY.get(name)


def mutates(name: str) -> bool:
    spec = REGISTRY.get(name)
    return bool(spec and spec.mutates)


async def run(name: str, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    spec = REGISTRY.get(name)
    if spec is None:
        return _refused(f"No tool named {name}.", code="unsupported_operation")
    # Dispatch rechecks what admission offered: a tool the model names without
    # holding its operations is refused, whatever the prompt said.
    if not _offered(spec, ctx):
        return _refused(
            f"{name} is unavailable for this user.", code="lifecycle_rejected"
        )
    problem = contract.validate_args(
        name, {k: v for k, v in args.items() if not k.startswith("_")}
    )
    if problem:
        return _refused(problem)
    try:
        return await spec.handler(args, ctx)
    except (TurnFailed, pending.SourceChanged):
        raise
    except Exception as exc:
        log.exception("tool %s failed", name)
        return _failed(f"The {name} tool failed: {exc}")


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
    parts: list[str] = []
    if numbered and result.paged:
        body = "\n\n".join(
            f"[{number}] {passage.location()} (chunk {passage.chunk_idx})\n{passage.text}"
            for number, passage in numbered
        )
        parts.extend([body, result.text_parts[0]])
    else:
        if numbered:
            parts.append("\n\n".join(passage.as_context(n) for n, passage in numbered))
        parts.extend(part for part in result.text_parts if part)
    text = "\n\n".join(parts) if parts else result.text()
    if numbered:
        locations = "\n".join(
            f"[{number}] file_id={passage.file_id}, start={passage.chunk_idx}"
            for number, passage in numbered
        )
        text += "\n\nLocations for read_document:\n" + locations
    return text


TOOL_RESULT_MAX_TOKENS = 8192


def limit_tool_result(text: str) -> str:
    """Bound stored tool output while making truncation visible to the model."""
    if estimate_tokens(text) <= TOOL_RESULT_MAX_TOKENS:
        return text
    marker = "\n\n[Tool output truncated. Narrow the request or continue reading.]"
    room = max(0, TOOL_RESULT_MAX_TOKENS - estimate_tokens(marker))
    return clip_to_tokens(text, room) + marker
