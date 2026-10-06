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
import base64
import hashlib
import io
import json
import logging
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import requests

from .. import obs
from ..config import cfg
from ..generated import MATERIAL_TITLE_MAX
from . import bank, capture, contract, deck, library, pending, skills, store
from .chunking import clip_to_tokens, estimate_tokens, strip_carried
from .library_evidence import LibraryEvidence
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


# Open todos a ledger may hold. The gateway refuses a ledger over 64 KiB, and
# the model pays for every rendered line on every call.
STORED_TODOS = 10


@dataclass
class LedgerTodo:
    """One material or section the build promised to produce.

    ``id`` comes from the conversation's own counter and never changes, so the
    number the model writes down in one message still names this todo in the
    next one. ``done`` lives for the turn that completes it: a done todo leaves
    the ledger when it is stored.
    """

    id: int
    text: str
    done: bool = False


@dataclass
class LedgerRead:
    """One library excerpt this turn read, at one chunk position."""

    excerpt_id: str
    start: int
    section: str


def _stored_objects(stored: dict[str, Any], key: str) -> list[dict[str, Any]]:
    """One array of a stored ledger whose entries are objects."""
    entries = stored.get(key) or []
    if not isinstance(entries, list):
        raise TypeError(f"{key} is {type(entries).__name__}, not a list")
    for entry in entries:
        if not isinstance(entry, dict):
            raise TypeError(f"{key} holds a {type(entry).__name__}, not an object")
    return entries


@dataclass
class Ledger:
    """A conversation's todo list for multi-item builds.

    It belongs to the conversation, not the turn: open todos carry across
    turns through ``conversations.ledger``. A turn loads it, edits todos with
    ``create_ledger``, marks todos done as writes land, and stores it at turn
    end. It rides right after the query on every call and is never part of the
    message history.
    """

    todos: list[LedgerTodo] = field(default_factory=list)
    # The conversation's todo counter: the next id a new todo gets. It is
    # stored, so an id is never reused after its todo leaves the ledger.
    next_todo_id: int = 0
    # This turn only, and never stored: what the model read to write with.
    reads: list[LedgerRead] = field(default_factory=list)
    # Only the first changed plan in a turn counts toward the stall guard.
    written: bool = False
    # Something this turn changed has to be written back at turn end.
    dirty: bool = False
    # Monotonic count of this turn's real progress: its first plan write, then
    # each completed todo. The stall guard compares it across a response.
    progress: int = 0

    @classmethod
    def from_stored(cls, stored: Any, conversation: str = "") -> Ledger:
        """The conversation's stored ledger, or an empty one.

        Total: the row is read again on every turn, so a shape this code does
        not understand would otherwise break the conversation for good. It is
        logged against the conversation and the turn starts from nothing. A
        todo id the counter has already handed out would let two todos answer
        to the same number, so that is malformed too.
        """
        if stored is None:
            return cls()
        try:
            if not isinstance(stored, dict):
                raise TypeError(f"ledger is {type(stored).__name__}, not an object")
            ledger = cls(
                next_todo_id=int(stored.get("next_todo_id") or 0),
                todos=[
                    LedgerTodo(id=int(todo.get("id")), text=str(todo.get("text") or ""))
                    for todo in _stored_objects(stored, "todos")
                ],
            )
            if any(todo.id >= ledger.next_todo_id for todo in ledger.todos):
                raise ValueError("next_todo_id is not past every stored todo id")
            return ledger
        except (AttributeError, TypeError, ValueError) as exc:
            log.error(
                "stored ledger is malformed (%s); starting this turn from an "
                "empty ledger. conversation=%s",
                exc,
                conversation or "unknown",
            )
            return cls()

    def stored(self) -> dict[str, Any]:
        """The open todos and the counter, as the gateway persists them."""
        return {
            "next_todo_id": self.next_todo_id,
            "todos": [
                {"id": todo.id, "text": todo.text}
                for todo in self.todos
                if not todo.done
            ][-STORED_TODOS:],
        }

    @property
    def active(self) -> bool:
        """The turn builds on the ledger: it has todos, open or done."""
        return bool(self.todos)

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

    def complete(self, todo_id: int | None) -> None:
        """Mark the todo a successful write completed."""
        todo = None if todo_id is None else self.todo(todo_id)
        if todo is None or todo.done:
            return
        todo.done = True
        self.dirty = True
        self.progress += 1


@dataclass
class ToolContext:
    workspace_id: str
    user_id: str = ""
    # The Library switch: the knowledge library is a source this turn, so its
    # tools are offered and materials written from it carry its provenance.
    library: bool = False
    # The conversation's todo list for multi-item builds, loaded from the chat
    # request at turn start.
    ledger: Ledger = field(default_factory=Ledger)
    # What the turn message tells the model about the learner: the file or
    # material they have open, and their saved study preferences.
    open_resource: dict[str, Any] = field(default_factory=dict)
    study_preferences: dict[str, Any] = field(default_factory=dict)
    # The workspace's chapters in order ({id, name}), loaded at turn start so
    # "chapter 2" resolves without a tool call; at most 20 (the server's cap).
    chapters: list[dict[str, Any]] = field(default_factory=list)
    # Skills whose read_skill result is still in the request; the writes they
    # cover are refused until it is (skills.retained recomputes it per call).
    skills_read: set[str] = field(default_factory=set)
    # The requester's study progress is on in this workspace, so the agent may
    # read it.
    study_progress: bool = False
    library_evidence: LibraryEvidence = field(default_factory=LibraryEvidence)
    # The library's subjects that hold excerpts, fetched once per turn for the
    # browse_knowledge description, and the topics of each subject browsed
    # this turn, which is where search_knowledge topic ids come from.
    library_catalog: list[dict[str, Any]] | None = None
    # With CAPY_LIBRARY_SECTION_TOOLS and no subject to list, the current
    # books ({id, title, pages}), which keep the library on and give
    # browse_knowledge.book its ids.
    library_books: list[dict[str, Any]] | None = None
    bank_catalog: list[dict[str, Any]] | None = None
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
    # Decks this turn outlined (deck.py records, by deck id) and the working
    # directory their figures and exports go to; the agent removes it at turn end.
    decks: dict[str, dict[str, Any]] = field(default_factory=dict)
    deck_dir: str = ""
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
    # Materials sit under the chapter they are filed in, so the model sees
    # which chapters already have their practice.
    materials: dict[str | None, list[dict[str, Any]]] = {}
    for item in documents:
        if item["kind"] == "material":
            materials.setdefault(item.get("chapterId"), []).append(item)
    for chapter in outline["chapters"]:
        files = by_chapter.pop(chapter["id"], [])
        filed = materials.pop(chapter["id"], [])
        if not files and not filed:
            continue
        lines.append(f"\n## {chapter['name']} (chapter_id={chapter['id']})")
        lines.extend(_file_line(f, sources[f["id"]]["editable"]) for f in files)
        lines.extend(_material_line(item) for item in filed)
    unfiled = [f for files in by_chapter.values() for f in files]
    if unfiled:
        lines.append("\n## Unfiled")
        lines.extend(_file_line(f, sources[f["id"]]["editable"]) for f in unfiled)
    loose = [item for items in materials.values() for item in items]
    if loose:
        lines.append("\n## Unfiled study materials")
        lines.extend(_material_line(item) for item in loose)
    return _result(
        "\n".join(lines)
        if lines
        else "This workspace has no sources or materials in scope."
    )


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
    # No per-turn cap: a capture is dropped when its exchange folds into the
    # turn note anyway, and a whole set of materials can be one turn.
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
    if not ctx.library or ctx.library_catalog is not None or not library.enabled():
        return
    db = await library.pool()
    async with db.connection() as conn:
        ctx.library_catalog = await library.catalog(conn)
        # Only an untagged library (no subject to list) needs its books named.
        if cfg.library_section_tools and not ctx.library_catalog:
            ctx.library_books = await library.books(conn)


async def load_bank_catalog(ctx: ToolContext) -> None:
    """Read the question bank's exams and subjects once, for list_question_bank's
    description. A bank the gateway does not have leaves it empty, and the bank
    tools unoffered."""
    if not ctx.library or ctx.bank_catalog is not None:
        return
    if not _gateway_ready() or not ctx.user_id:
        ctx.bank_catalog = []
        return
    body = await _gateway_read(
        "/api/internal/bank/list", {"userId": ctx.user_id}, "list the question bank"
    )
    ctx.bank_catalog = [] if isinstance(body, ToolResult) else body["subjects"]


def _catalog_lines(catalog: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"- browse_knowledge({json.dumps({'subject': subject['id']})})"
        f" ({int(subject.get('excerpts') or 0)} excerpts)"
        for subject in catalog
    )


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


def _excerpt_link(excerpt_id: str, section_path: str | None, pages: list[int]) -> str:
    listed = ", ".join(str(p) for p in pages)
    return (
        f"[{excerpt_id}]"
        + (f" {section_path}" if section_path else "")
        + (f" (pages {listed})" if listed else "")
    )


def _excerpt_head(excerpt: library.Excerpt) -> str:
    """The excerpt with its book's title and id, which search_knowledge.book takes."""
    return _excerpt_link(
        excerpt.id,
        f"{excerpt.book_title} (book {excerpt.book_id}) — {excerpt.section_path}",
        excerpt.pages,
    )


def _excerpt_facets(excerpt: library.Excerpt) -> str:
    parts = [
        f"roles: {', '.join(excerpt.roles)}",
        f"topics: {', '.join(excerpt.topic_ids)}",
    ]
    if excerpt.figure_ids:
        parts.append(f"figures: {', '.join(excerpt.figure_ids)}")
    return " | ".join(parts)


def _excerpt_figures(figures: list[dict[str, Any]]) -> str:
    """One line per figure a model may pick; the id alone until it is labelled."""
    lines = []
    for figure in figures:
        note = " — ".join(p for p in (figure["label"], figure["description"]) if p)
        credit = f" (credit: {figure['credit']})" if figure["credit"] else ""
        lines.append(f"- {figure['id']}" + (f": {note}" if note else "") + credit)
    return "\n\nFigures:\n" + "\n".join(lines) if lines else ""


def _excerpt_scope(excerpt: library.Excerpt) -> str:
    if excerpt.retrieval is None:
        return "Scope not reviewed. Check the source's applicability before using it."
    metadata = excerpt.retrieval
    text = f"teaches: {metadata['summary']}\nscope: {metadata['scope']}"
    if excerpt.links:
        text += "\nSource context (scope explains when needed):\n" + "\n".join(
            "- " + _excerpt_link(link["id"], link["section_path"], link["pages"] or [])
            for link in excerpt.links
        )
    return text


def _no_excerpts(
    topics: list[str],
    roles: list[str],
    available: dict[str, int] | None,
    where: str = "",
) -> str:
    """What an empty search means. Counts only say something under topics.

    Without a topic filter the by-role numbers are the whole library's and
    carry no information about the query, so the model is pointed at the
    filter it did not use instead.
    """
    head = (
        f"No verified excerpt matches roles {', '.join(roles) or 'any'} on topics "
        f"{', '.join(topics) or 'any'}{where}."
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
            f"Unknown topic ids {unknown}. Use a subject browse call listed in "
            "browse_knowledge and pass the returned topic_id values, not the "
            "subject ID or label. Or omit topics for a direct search."
        )
    book = str(args.get("book") or "").strip()
    section = str(args.get("section") or "").strip()
    if ctx.budget is not None:
        ctx.budget.embedding_calls += 1
    try:
        result = await library.search(
            query,
            topics=topics,
            roles=roles,
            book=book or None,
            section=section or None,
        )
    except ValueError as exc:
        return _refused(f"search_knowledge: {exc}")
    if not result.excerpts:
        where = (f" in book {book}" if book else "") + (
            f" under section {json.dumps(section, ensure_ascii=False)}"
            if section
            else ""
        )
        return _result(_no_excerpts(topics, roles, result.available_roles, where))
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
    head = f"Subject {subject['id']!r}: {len(topics)} topics"
    if not topics:
        return f"{head}. The library holds no topic for this subject yet."
    lines = [
        f"- topic_id={json.dumps(t['id'])}: {t['label']}"
        + (f" — {t['scope']}" if t.get("scope") else "")
        + f" ({int(t.get('excerpts') or 0)} excerpts)"
        for t in topics
    ]
    return (
        head
        + "\n"
        + "\n".join(lines)
        + "\n\nUse these topic_id values in search_knowledge.topics to filter a "
        "search, or in browse_knowledge.topic to see excerpts by role and book."
    )


# Outline lines per browse_knowledge(book) page: a book whose parser made
# every callout a heading has hundreds of two-level paths.
OUTLINE_LINES = 120


def _book_outline(outline: library.BookOutline, page: int) -> str:
    """One line per section path (``library.outline_line``), ``OUTLINE_LINES``
    to a page."""
    lines = [library.outline_line(s) for s in outline.sections]
    pages = max(1, -(-len(lines) // OUTLINE_LINES))
    if not 1 <= page <= pages:
        raise ValueError(
            f"book {outline.book_id}'s outline has {pages} "
            + ("page" if pages == 1 else "pages")
        )
    shown = lines[(page - 1) * OUTLINE_LINES : page * OUTLINE_LINES]
    return (
        f"Book {outline.book_id}: {outline.title}, version {outline.version}, "
        f"{outline.pages} pages. Outline page {page} of {pages}: sections in "
        "reading order, two heading levels (deeper ones count in their parent); "
        "read one with read_knowledge book and section:\n"
        + "\n".join(shown)
        + (f"\n\n(next page = {page + 1})" if page < pages else "")
    )


async def _browse_knowledge(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    subject = str(args.get("subject") or "").strip()
    topic = str(args.get("topic") or "").strip()
    book = str(args.get("book") or "").strip()
    sections = cfg.library_section_tools
    if [bool(subject), bool(topic), bool(book)].count(True) != 1 or (
        book and not sections
    ):
        return _refused(
            "browse_knowledge takes exactly one of subject (a subject id from "
            "this tool's description) or topic (a topic id from a subject browse)"
            + (" or book (a book id, for its outline)." if sections else ".")
        )
    # Dispatch on the argument given, never on which catalog holds the id: a
    # topic id may coincide with a subject id.
    try:
        if book:
            outline = await library.outline(book)
            return _result(_book_outline(outline, int(args.get("page") or 1)))
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


def _fitting(page: Callable[[int], tuple[str, str]], total: int) -> tuple[int, str]:
    """How many leading chunks a page can show within the tool-output limit
    (at least one), and its text: ``page(n)`` gives the body and the tail, so
    the next start names the first chunk the model did not see rather than
    one the output clip dropped. When one chunk still overflows, the tail
    goes first, ahead of the clip."""
    n = total
    while n > 1 and estimate_tokens("".join(page(n))) > TOOL_RESULT_MAX_TOKENS:
        n -= 1
    body, tail = page(n)
    if estimate_tokens(body + tail) > TOOL_RESULT_MAX_TOKENS:
        return n, tail.lstrip("\n") + "\n\n" + body
    return n, body + tail


def _tail(
    chunks: list[dict[str, Any]], n: int, next_start: int | None, end: str
) -> str:
    if n < len(chunks):
        return (
            "\n\n(page cut at the tool output limit; "
            f"next start = {chunks[n]['chunk_idx']})"
        )
    if next_start is not None:
        return f"\n\n(next start = {next_start})"
    return f"\n\n{end}"


def _without_repeats(chunks: list[dict[str, Any]]) -> list[str]:
    """Each chunk's text less what it repeats from the chunk shown before it."""
    texts = []
    for i, chunk in enumerate(chunks):
        before = chunks[i - 1] if i else None
        consecutive = (
            before is not None and before["chunk_idx"] + 1 == chunk["chunk_idx"]
        )
        texts.append(
            strip_carried(before["text"], chunk["text"])
            if consecutive
            else chunk["text"]
        )
    return texts


async def _read_knowledge(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    excerpt_id = str(args.get("excerpt_id") or "").strip()
    book = str(args.get("book") or "").strip()
    section = str(args.get("section") or "").strip()
    if cfg.library_section_tools and not excerpt_id and book and section:
        return await _read_section(book, section, args, ctx)
    if not excerpt_id or book or section:
        return _refused(
            "read_knowledge takes an excerpt_id"
            + (
                ", or a book and a section together."
                if cfg.library_section_tools
                else "."
            )
        )
    start = max(0, int(args.get("start") or 0))
    try:
        read = await library.read_excerpt(
            excerpt_id, start=start, count=int(args.get("count") or library.READ_CHUNKS)
        )
    except ValueError as exc:
        return _refused(f"read_knowledge: {exc}")
    if not read.chunks:
        return _result(f"Excerpt {excerpt_id} has no text at chunk {start}.")
    head = (
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
    )
    texts = _without_repeats(read.chunks)
    end = "(end of excerpt)" + "".join(
        f"\n{label} in this book: "
        + _excerpt_link(excerpt.id, excerpt.section_path, excerpt.pages)
        for label, excerpt in (("Previous", read.previous), ("Next", read.following))
        if excerpt is not None
    )

    def page(n: int) -> tuple[str, str]:
        body = "\n\n".join(
            f"(chunk {chunk['chunk_idx']}) {text}"
            for chunk, text in zip(read.chunks[:n], texts, strict=False)
        )
        return (
            f"{head}\n\n{body}" + _excerpt_figures(read.figures),
            _tail(read.chunks, n, read.next_start, end),
        )

    _, text = _fitting(page, len(read.chunks))
    ctx.ledger.note_read(
        read.excerpt.id, start, _short_section(read.excerpt.section_path)
    )
    return _result(text)


def _section_text(
    section: str, chunks: list[dict[str, Any]], scopes: dict[str, str]
) -> str:
    """A section page as continuous text: the path where it moves to another
    (sub)section, a [p. N] marker where the page changes, an excerpt's
    reviewed scope (``scopes``, by excerpt id) where it begins on the page, and
    no text a chunk repeats from the one before it."""
    parts: list[str] = []
    path, page = section, None
    begun: set[str] = set()
    for chunk, text in zip(chunks, _without_repeats(chunks), strict=True):
        if chunk["section_path"] != path:
            path = chunk["section_path"]
            parts.append(f"## {path}")
        first = chunk["page_start"]
        if first is not None:
            last = chunk["page_end"] or first
            if not first == last == page:
                parts.append(
                    f"[p. {first}]" if first == last else f"[p. {first}-{last}]"
                )
                page = last
        excerpt_id = chunk["excerpt_id"]
        if excerpt_id not in begun:
            begun.add(excerpt_id)
            if excerpt_id in scopes:
                parts.append(scopes[excerpt_id])
        if text:
            parts.append(text)
    return "\n\n".join(parts)


async def _read_section(
    book: str, section: str, args: dict[str, Any], ctx: ToolContext
) -> ToolResult:
    """read_knowledge(book, section): one run of a section in order. Every
    excerpt the page shows counts as read, so a write may name it in
    excerpt_ids."""
    start = args.get("start")
    try:
        read = await library.read_section(
            book,
            section,
            start=None if start is None else int(start),
            count=int(args.get("count") or library.SECTION_CHUNKS),
        )
    except ValueError as exc:
        return _refused(f"read_knowledge: {exc}")
    following = f"the next run starts at chunk {read.next_run}" if read.next_run else ""
    head = (
        f"{read.title} (book {read.book_id}, version {read.version}), section "
        f"{json.dumps(section, ensure_ascii=False)}: run {read.run} of {read.runs}"
        + (f" ({following})" if following else "")
        + f", {library.page_span(read.page_first, read.page_last)}, "
        f"chunks {read.first}-{read.last}, from {read.start}"
    )
    end = (
        f"(end of run {read.run} of {read.runs}; {following})"
        if following
        else "(end of section)"
    )
    # Reviewed scope (printed errors included) in the excerpt read's form;
    # an excerpt without reviewed metadata adds nothing.
    scopes = {
        excerpt_id: f"[{excerpt_id}] {_excerpt_scope(excerpt)}"
        for excerpt_id, excerpt in read.excerpts.items()
        if excerpt.retrieval is not None
    }

    def page(n: int) -> tuple[str, str]:
        shown = read.chunks[:n]
        pages = {
            p
            for c in shown
            if c["page_start"] is not None
            for p in range(c["page_start"], (c["page_end"] or c["page_start"]) + 1)
        }
        excerpts = dict.fromkeys(c["excerpt_id"] for c in shown)
        return (
            f"{head}\n\n{_section_text(section, shown, scopes)}"
            + _excerpt_figures([f for f in read.figures if f["page"] in pages])
            + "\n\nExcerpts on this page: "
            + ", ".join(excerpts),
            _tail(read.chunks, n, read.next_start, end),
        )

    n, text = _fitting(page, len(read.chunks))
    # Each excerpt's read starts at its first chunk on this page.
    firsts: dict[str, dict[str, Any]] = {}
    for chunk in read.chunks[:n]:
        firsts.setdefault(chunk["excerpt_id"], chunk)
    for excerpt_id, chunk in firsts.items():
        ctx.ledger.note_read(
            excerpt_id, chunk["chunk_idx"], _short_section(chunk["section_path"])
        )
    return _result(text)


async def _create_ledger(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Apply todo edits atomically, preserving work and stable todo IDs."""
    ledger = ctx.ledger
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
            f"The ledger can hold at most {STORED_TODOS} unfinished todos; this update changed nothing."
        )
    updated = list(todos.values())
    if updated == ledger.todos:
        return _result("Ledger unchanged.")
    ledger.todos, ledger.next_todo_id = updated, next_id
    # Only the first plan write in a turn counts as progress.
    if not ledger.written:
        ledger.progress += 1
    ledger.written = ledger.dirty = True
    listing = "\n".join(f"[ ] {t.id}. {t.text}" for t in ledger.todos if not t.done)
    return _result(f"Ledger updated.\n\nOpen todos:\n{listing or '(none)'}")


async def _capture_knowledge_page(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Render a page of the book behind a library excerpt.

    The excerpt is the unit the model works in, so only its own pages and the
    pages of its figures can be captured, never a page the book withholds (a
    reprinted text the library does not reproduce). Like ``capture_page`` it adds no
    citation: the attribution lives on the material.
    """
    excerpt_id, page, bbox = args["excerpt_id"], args["page"], args.get("bbox")
    try:
        target = await library.capture_target(excerpt_id)
    except ValueError as exc:
        return _refused(f"capture_knowledge_page: {exc}")
    if page in target.withheld_pages:
        return _refused(
            f"Page {page} of {target.book_title} is withheld from the library; "
            "it cannot be captured."
        )
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
        # A deck slide embedding this crop credits the excerpt's book.
        | {"excerptId": target.excerpt_id}
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
    prepared = await ledger_write(ctx, "create_material", args)
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
        "chapterId": str(args.get("chapter_id") or ""),
    }
    if books:
        # Go validates the shape and computes the material's own licence.
        payload["provenance"] = {"books": books}

    await ctx.pending_sources.validate()
    result = await _post_operation(
        "/api/internal/materials", payload, op_id, ctx, failure=f"create the {kind}"
    )
    if result.effects:
        ctx.ledger.complete(todo)
    return result


# ------------------------------------------------------------ material writes


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


async def ledger_write(
    ctx: ToolContext,
    tool: str,
    args: dict[str, Any],
    *,
    material: bool = True,
    excerpts: bool = True,
) -> tuple[list[dict[str, Any]], int | None] | ToolResult:
    """Check a material write and resolve its provenance, or refuse it.

    Returns the provenance books (one entry per source book) and the ledger
    todo this write completes. Shared with the playground's local write stubs,
    so the rules have one implementation. ``material`` is false for an edit of
    the user's own source file, which carries no provenance and no todo.
    ``excerpts`` is false for a write whose content comes from somewhere other
    than the library (a copied bank question carries the bank's sources), so
    the excerpt rules do not apply.
    """
    excerpt_ids = [str(e) for e in (args.get("excerpt_ids") or [])]
    if not material:
        # Provenance is what a work was written from; a workspace source file is
        # the user's own text. Both are refused rather than ignored: a silently
        # dropped todo would leave the model believing it closed one.
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
    todo: int | None = None
    raw_todo = args.get("todo")
    if raw_todo is not None:
        todo = int(raw_todo)
        entry = ctx.ledger.todo(todo)
        if entry is None:
            return _refused(
                f"todo {todo} is not on the ledger. {_next_move(ctx.ledger)}"
            )
        if entry.done:
            return _refused(f"todo {todo} is already done. {_next_move(ctx.ledger)}")
    read = ctx.ledger.read_ids()
    # Name every missing field at once: a write resent per field costs a round
    # trip of the whole content each time.
    missing = []
    if raw_todo is None and ctx.ledger.open_todos():
        missing.append("todo, the id of the ledger todo it completes")
    if excerpts and read and not excerpt_ids:
        missing.append(
            "excerpt_ids naming the library excerpts this content was written from"
        )
    if missing:
        hint = (
            f" {_next_move(ctx.ledger)}"
            if raw_todo is None and ctx.ledger.open_todos()
            else ""
        )
        return _refused(f"{tool} needs {'; and '.join(missing)}.{hint}")
    if excerpt_ids and not ctx.library:
        return _refused(
            "excerpt_ids name library excerpts, and the library is not a source this "
            "turn; workspace passages need none. Call it again without excerpt_ids."
        )
    unread = [e for e in excerpt_ids if e not in read]
    if unread:
        return _refused(
            f"Excerpts {unread} have no read or retained full text in this turn. read_knowledge each "
            "of them before writing from it; workspace passages need no excerpt_ids."
        )
    if not excerpt_ids:
        return [], todo
    try:
        return await library.provenance(excerpt_ids), todo
    except ValueError as exc:
        return _refused(f"{tool}: {exc}")


async def store_ledger(ctx: ToolContext) -> None:
    """Write the conversation ledger back through the gateway at turn end.

    The ledger is the conversation's memory of what is still open, so it is
    stored whenever this turn changed it, including when the turn ended on the
    stall guard or an error. A failed write loses the turn's ledger changes,
    not the turn: the materials themselves are already durable.
    """
    if not ctx.ledger.dirty:
        return
    if not _gateway_ready() or not ctx.user_id or not ctx.assistant_message_id:
        log.warning("ledger not stored: no gateway route for this turn")
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
        log.warning("ledger write failed: %s", exc)
        return
    if resp.status_code >= 300:
        log.warning(
            "ledger write failed: %s %s",
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
    timeout: float = 10,
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
                    timeout=timeout,
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
    """Attach a pending source image to the next request, as capture_page does."""
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
    started = time.perf_counter()
    try:
        raw = await pending.resolve(
            sources=ctx.pending_sources,
            workspace_id=ctx.workspace_id,
            user_id=ctx.user_id,
            file_id=file_id,
            change_id=change_id,
            checkpoint=checkpoint,
        )
        jpeg, box, size = await asyncio.to_thread(
            capture.image_jpeg, io.BytesIO(raw), None, cfg.capture_max_edge
        )
    except capture.CaptureUnavailable as exc:
        return _refused(f"resolve_source_change: {exc}", code=exc.code)
    except ValueError as exc:
        return _refused(f"resolve_source_change: {exc}")
    call_id = str(args.get("_tool_call_id") or "")
    ctx.captures.append(
        capture.record(
            call_id=call_id,
            file_id=file_id,
            page=1,
            box=box,
            jpeg=jpeg,
            size=size,
            started=started,
        )
    )
    ctx.pending_images[call_id] = (
        f"resolve_source_change result: change {change_id} of file {file_id}",
        capture.data_url(jpeg),
    )
    return _result(
        "The pending source image is attached to the next message; read it directly."
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
    prepared = await ledger_write(
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
        else:
            ctx.ledger.complete(todo)
    return result


async def _read_skill(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    name = str(args["name"]).strip()
    skill = skills.SKILLS.get(name)
    if skill is None:
        return _refused(
            f"No skill named {name}. Skills: {', '.join(skills.SKILLS)}.",
            code="unavailable_target",
        )
    return _result(skills.render(name, skill.text(ctx.library)))


async def _list_question_bank(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """The bank's table of contents: a subject's topics, or a page of a topic's
    questions, optionally only those with a part of one answer type. The exams and subjects ride in
    the tool description."""
    # A topic id is unique on its own, so a subject passed with it is ignored.
    topic, subject = args.get("topic"), args.get("subject")
    atype = str(args.get("answer_type") or "")
    if not (topic or subject):
        return _refused(
            "list_question_bank takes subject (a bank subject from its description, "
            "not a library subject) or topic (from a subject's list)."
        )
    if atype and not topic:
        return _refused(
            "answer_type filters a topic's questions; pass a topic from the "
            "subject's list with it."
        )
    if topic:
        offset = int(args.get("offset") or 0)
        payload = {"userId": ctx.user_id, "topicId": str(topic), "offset": offset}
        if atype:
            payload["answerType"] = atype
        body = await _gateway_read(
            "/api/internal/bank/list", payload, f"list bank topic {topic}"
        )
        if isinstance(body, ToolResult):
            return body
        total, rows = body["total"], body["questions"]
        if not rows:
            hint = (
                f"No questions with {atype} parts under topic {topic} from offset "
                f"{offset}; list the topic without answer_type to see the answer "
                "types its cards carry."
                if atype
                else f"No bank questions under topic {topic} from offset {offset}; "
                "list the subject's topics for their ids and counts."
            )
            return _refused(hint, code="unavailable_target")
        of = f" {atype}" if atype else ""
        head = f"Topic {topic}:{of} questions {offset + 1}-{offset + len(rows)} of {total}."
        more = offset + len(rows)
        tail = f"\nNext page: offset {more}." if more < total else ""
        return _result(head + "\n\n" + "\n\n".join(bank.card(r) for r in rows) + tail)
    body = await _gateway_read(
        "/api/internal/bank/list",
        {"userId": ctx.user_id, "subjectId": str(subject)},
        f"list bank subject {subject}; the bank's subjects are in the "
        "list_question_bank description",
    )
    if isinstance(body, ToolResult):
        return body
    rows = body["topics"]
    return _result(
        f"Topics of {subject}:\n"
        + "\n".join(
            f"- {r['id']}: {r['label']} · {r['questions']} questions" for r in rows
        )
    )


async def _read_question(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    body = await _gateway_read(
        "/api/internal/bank/read",
        {"userId": ctx.user_id, "questionId": str(args["question_id"])},
        f"read bank question {args['question_id']}",
    )
    if isinstance(body, ToolResult):
        return body
    return _result(bank.full(body))


async def _copy_questions(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Copy bank questions into a quiz through the gateway, which reads them
    from the bank itself and credits each one: the model writes none of it."""
    if not ctx.assistant_message_id:
        return _refused("copy_questions needs the assistant message id.")
    call_id = str(args.get("_tool_call_id") or "")
    if not call_id:
        return _refused("copy_questions is missing its tool-call id.")
    title, quiz_id = str(args.get("title") or "").strip(), args.get("quiz_id")
    if bool(title) == bool(quiz_id):
        return _refused(
            "copy_questions takes exactly one destination: title for a new quiz, "
            "or quiz_id for a quiz in this workspace."
        )
    if args.get("chapter_id") and quiz_id:
        return _refused("chapter_id files a new quiz; it goes with title.")
    # Copied questions carry the bank's credits, so no excerpts are asked.
    prepared = await ledger_write(ctx, "copy_questions", args, excerpts=False)
    if isinstance(prepared, ToolResult):
        return prepared
    _, todo = prepared
    payload = {
        "workspaceId": ctx.workspace_id,
        "userId": ctx.user_id,
        "assistantMessageId": ctx.assistant_message_id,
        "toolCallId": call_id,
        "questionIds": [str(q) for q in args["question_ids"]],
        "title": title[:MATERIAL_TITLE_MAX].strip(),
        "chapterId": str(args.get("chapter_id") or ""),
        "quizId": str(quiz_id or ""),
    }
    result = await _post_operation(
        "/api/internal/bank/copy",
        payload,
        operation_id(ctx.assistant_message_id, call_id),
        ctx,
        failure="copy the questions",
    )
    if result.effects:
        ctx.ledger.complete(todo)
    return result


# ------------------------------------------------------------------ decks


async def _create_deck(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Outline a deck for this turn. Nothing is stored until every slide is
    written (retrieval/deck.py)."""
    call_id = str(args.get("_tool_call_id") or "")
    if not call_id or not ctx.assistant_message_id:
        return _refused("create_deck needs its tool-call and assistant message ids.")
    chapter = str(args.get("chapter_id") or "")
    if chapter and chapter not in {c["id"] for c in ctx.chapters}:
        return _refused(
            "chapter_id is not a chapter of this workspace; the turn context lists them."
        )
    prepared = await ledger_write(ctx, "create_deck", args)
    if isinstance(prepared, ToolResult):
        return prepared
    books, todo = prepared
    record = deck.create(args, deck.deck_id(ctx.assistant_message_id, call_id))
    deck.add_books(record, books)
    ctx.decks[record["id"]] = record
    ctx.ledger.complete(todo)
    return _result(deck.created_text(record))


async def _write_slide(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Check one slide alone with ppt-master's checker and keep it. Once every
    slide is written, close the deck with its Sources slide, export it and
    store the PPTX as a workspace file (Go /api/internal/files)."""
    rid = str(args["deck_id"])
    record = ctx.decks.get(rid)
    if record is None:
        return _refused(
            f"write_slide: {rid} is not a deck this turn outlined; a deck is written "
            "within the turn that creates it.",
            code="unavailable_target",
        )
    if record.get("file"):
        return _refused(
            f"Deck {rid} is stored as file {record['file']}, which is now the document: "
            "change its text with edit_document replace_text, or make a new deck.",
            code="unavailable_target",
        )
    prepared = await ledger_write(ctx, "write_slide", args)
    if isinstance(prepared, ToolResult):
        return prepared
    books, todo = prepared
    problems, figures, excerpts = deck.turn_figures(ctx.captures, ctx.pending_images)
    # A library crop on the slide credits its book, named in excerpt_ids or not.
    cropped = sorted(
        {excerpts[p] for p in deck.figure_pages(args["svg"]) if p in excerpts}
    )
    if cropped:
        books = [*books, *await library.provenance(cropped)]
    if not ctx.deck_dir:
        ctx.deck_dir = tempfile.mkdtemp(prefix="capy-deck-")
    project = Path(ctx.deck_dir) / rid
    problem = await asyncio.to_thread(
        deck.write, record, args, problems, figures, project
    )
    if problem:
        return _refused(f"write_slide: {problem}")
    deck.add_books(record, books)
    ctx.ledger.complete(todo)
    outline = deck.outline_text(record)
    if not deck.complete(record):
        return _result(outline)
    pptx = project / "deck.pptx"
    problem = await asyncio.to_thread(deck.save, record, project, pptx)
    if problem:
        return _result(
            f"{outline}\n\nThe export failed; rewrite the slide it names: {problem}"
        )
    call_id = str(args.get("_tool_call_id") or "")
    payload = {
        **_chat_context(ctx, call_id),
        "name": deck.file_name(record),
        "chapterId": record["chapter_id"],
        "content": base64.b64encode(pptx.read_bytes()).decode(),
    }
    if record["provenance"]:
        payload["provenance"] = record["provenance"]
    result = await _post_operation(
        "/api/internal/files",
        payload,
        operation_id(ctx.assistant_message_id, call_id),
        ctx,
        failure="store the deck",
        timeout=60,
    )
    if not result.effects:
        return replace(
            result,
            error=f"{result.error} Every slide is written; writing one again retries "
            "the export and the store.",
        )
    record["file"] = result.effects[0]["resource"]["id"]
    result.text_parts = [
        (
            f"{outline}\n\nEvery slide is written. The deck is stored as "
            f"'{payload['name']}' (file id {record['file']}) and is parsed in the "
            "background; from now on that PPTX is the document."
        )
    ]
    return result


def render_progress(progress: dict[str, Any]) -> str:
    """The learner's progress as the model reads it."""
    lines: list[str] = []
    for state in ("done", "started", "removed"):
        items = [i for i in progress.get("items") or [] if i.get("state") == state]
        if items:
            lines.append(f"{state.capitalize()}:")
            lines.extend(f"- {i['title']} ({i['kind']} {i['id']})" for i in items)
    attempts = progress.get("recentAttempts") or []
    if attempts:
        lines.append("Recent quizzes:")
        lines.extend(
            f"- {a['quizName']}: {a['pct']}% on {str(a['takenAt'])[:10]}"
            + (f" ({', '.join(a['chapters'])})" if a.get("chapters") else "")
            for a in attempts
        )
    weak = progress.get("weakChapters") or []
    if weak:
        lines.append("Least retained chapters:")
        lines.extend(
            f"- {w['chapter'] or 'Unfiled'}: {round(100 * w['retention'])}% retained "
            f"across {w['items']} rated questions and cards"
            for w in weak
        )
    return "\n".join(lines) or "No study progress recorded in this workspace yet."


async def _read_study_progress(_args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id:
        return _refused(
            "Study progress is unavailable for this user.", code="lifecycle_rejected"
        )

    def _post() -> requests.Response:
        return requests.post(
            _material_url("/api/internal/study-progress"),
            headers=_material_headers(),
            data=json.dumps({"workspaceId": ctx.workspace_id, "userId": ctx.user_id}),
            timeout=10,
        )

    resp = await asyncio.to_thread(_post)
    if resp.status_code >= 300:
        return _refused(
            f"Study progress could not be read: {_response_detail(resp)}",
            code="unavailable_target",
        )
    return _result(render_progress(resp.json()))


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
_register("read_skill", _read_skill)
_register("read_study_progress", _read_study_progress)
_register("list_question_bank", _list_question_bank)
_register("read_question", _read_question)
_register("copy_questions", _copy_questions)
_register("capture_knowledge_page", _capture_knowledge_page)
_register("list_sources", _list_sources)
_register("read_document", _read_document)
_register("capture_page", _capture_page)
_register("create_material", _create_material)
_register("resolve_source_change", _resolve_source_change)
_register("inspect_document", _inspect_document)
_register("edit_document", _edit_document)
_register("trash_file", _trash_file)
_register("list_trashed_files", _list_trashed_files)
_register("restore_file", _restore_file)
_register("create_deck", _create_deck)
_register("write_slide", _write_slide)


# Offered only with the Library switch on and a configured library.
KNOWLEDGE_TOOLS = (
    "search_knowledge",
    "browse_knowledge",
    "read_knowledge",
)
KNOWLEDGE_CAPTURE = "capture_knowledge_page"
BANK_TOOLS = ("list_question_bank", "read_question", "copy_questions")
# Offered with ppt-master installed (the retrieval image has it).
DECK_TOOLS = ("create_deck", "write_slide")


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
    if spec.name == "read_study_progress":
        return ctx.study_progress
    if spec.name in BANK_TOOLS:
        # Part of the Library switch; a bank that is down or empty is not offered.
        return ctx.library and bool(ctx.bank_catalog)
    if spec.name == KNOWLEDGE_CAPTURE:
        # Without the knowledge-base bucket there is nothing to render.
        return ctx.library and library.enabled() and bool(cfg.knowledge_base_b2_bucket)
    if spec.name in DECK_TOOLS:
        return deck.available()
    if spec.name in KNOWLEDGE_TOOLS:
        return ctx.library and library.enabled()
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
    # The model maps the learner's words onto a subject from these lists, then
    # browses or lists it for topic ids.
    # The deck skill is listed only where its tools can run.
    extra = {
        "read_skill": skills.catalog(
            n for n in skills.SKILLS if n != skills.DECK or deck.available()
        )
    }
    if ctx.library_catalog:
        extra["browse_knowledge"] = (
            "\n\nSubjects this library holds (browse one for its topic ids):\n"
            + _catalog_lines(ctx.library_catalog)
        )
    if ctx.library_books:
        extra["browse_knowledge"] = extra.get("browse_knowledge", "") + (
            "\n\nBooks this library holds (browse one for its section outline):\n"
            + "\n".join(
                f"- browse_knowledge({json.dumps({'book': b['id']})}): "
                f"{b['title']} ({b['pages']} pages)"
                for b in ctx.library_books
            )
        )
    if ctx.bank_catalog:
        extra["list_question_bank"] = (
            "\n\nExams and subjects this bank holds (list one for its topics):\n"
            + "\n".join(
                f"- list_question_bank({json.dumps({'subject': s['id']})}): "
                f"{s['examLabel']} {s['label']} ({s['questions']} questions)"
                for s in ctx.bank_catalog
            )
        )
    for schema in schemas:
        name = schema["function"]["name"]
        if name in extra:
            schema["function"]["description"] += extra[name]
    if not cfg.library_section_tools:
        schemas = [without_sections(s) for s in schemas]
    return schemas if ctx.library else [without_excerpts(s) for s in schemas]


def without_sections(schema: dict[str, Any]) -> dict[str, Any]:
    """browse_knowledge and read_knowledge as production offers them: the
    contract's book and section arguments are the CAPY_LIBRARY_SECTION_TOOLS
    experiment's, and an excerpt read pages at most 12 chunks."""
    function = schema["function"]
    if function["name"] not in ("browse_knowledge", "read_knowledge"):
        return schema
    parameters = function["parameters"]
    properties = {
        k: v
        for k, v in parameters["properties"].items()
        if k not in ("book", "section")
    }
    if function["name"] == "read_knowledge":
        properties["count"] = {
            "type": "integer",
            "minimum": 1,
            "maximum": library.READ_CHUNKS,
            "default": library.READ_CHUNKS,
            "description": "Chunks per page, at most 12.",
        }
        parameters = {**parameters, "required": ["excerpt_id"]}
    return {
        **schema,
        "function": {
            **function,
            "parameters": {**parameters, "properties": properties},
        },
    }


def without_excerpts(schema: dict[str, Any]) -> dict[str, Any]:
    """A write tool without excerpt_ids, for a turn the library is not a
    source of: the model otherwise fills it with workspace passage ids."""
    parameters = schema["function"]["parameters"]
    if "excerpt_ids" not in parameters.get("properties", {}):
        return schema
    properties = {
        k: v for k, v in parameters["properties"].items() if k != "excerpt_ids"
    }
    return {
        **schema,
        "function": {
            **schema["function"],
            "parameters": {**parameters, "properties": properties},
        },
    }


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
    needs = skills.missing(name, args, ctx.skills_read)
    if needs:
        return _refused(skills.refusal(needs))
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
