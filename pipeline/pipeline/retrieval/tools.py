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
import itertools
import json
import logging
import re
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
from ..generated.limits import QUESTION_DESCRIPTION_MAX, QUESTION_METADATA_MAX
from ..prompts import preferences
from ..prompts.sources import source_block
from . import capture, contract, deck, library, pending, questions, skills, store
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
    # What the model reads after the error, kept out of the error the chat
    # stores and shows: a missed target as it is now, carried skills or excerpts.
    detail: str = ""
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
            return "\n\n".join(part for part in (self.error, self.detail) if part)
        return "\n\n".join(part for part in self.text_parts if part)


@dataclass
class LibraryRead:
    """One library excerpt this turn read, at one chunk position."""

    excerpt_id: str
    start: int
    section: str
    # A write that landed already credited it, or it is retained from the
    # earlier turn whose write used it: a write naming no excerpts credits the
    # reads that are not.
    credited: bool = False
    # The read's result as the model was shown it, which a write naming no
    # excerpts is matched against (_matching).
    text: str = ""


@dataclass
class LibraryReads:
    """The library excerpts this turn has read, or still holds in full from an
    earlier turn's write: what a write may name in excerpt_ids, and what one
    naming none is credited with."""

    reads: list[LibraryRead] = field(default_factory=list)

    def note(
        self,
        excerpt_id: str,
        start: int,
        section: str,
        *,
        retained: bool = False,
        text: str = "",
    ) -> None:
        """Record one read with the text it showed. Reading a recorded position
        again makes it new for the next write; a retained excerpt comes in
        already credited."""
        for read in self.reads:
            if (read.excerpt_id, read.start) == (excerpt_id, start):
                read.credited = read.credited and retained
                read.text = text or read.text
                return
        self.reads.append(
            LibraryRead(excerpt_id, start, section, credited=retained, text=text)
        )

    def ids(self) -> set[str]:
        return {read.excerpt_id for read in self.reads}

    def uncredited(self) -> list[str]:
        """What a write naming no excerpts may be credited with: the excerpts
        read since the last write that landed, or every one when none are new
        (narrowed by _matching)."""
        fresh = [read for read in self.reads if not read.credited]
        return list(dict.fromkeys(read.excerpt_id for read in fresh or self.reads))

    def credit(self) -> None:
        """A write that took provenance landed: everything read so far is
        credited, so the next write naming none credits only later reads."""
        for read in self.reads:
            read.credited = True


@dataclass
class ToolContext:
    workspace_id: str
    user_id: str = ""
    # The Library switch: the knowledge library is a source this turn, so its
    # tools are offered and materials written from it carry its provenance.
    library: bool = False
    # The library excerpts this turn read, for the write guard and crediting.
    library_reads: LibraryReads = field(default_factory=LibraryReads)
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
    # The library's subjects that hold excerpts, fetched once per turn for
    # search_knowledge's description; its subject argument takes their ids.
    library_catalog: list[dict[str, Any]] | None = None
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
    # What this turn last saw of each material block (material id -> block id
    # -> text), from inspect_document and its own replace_text edits, so a
    # refused edit can say its target changed since.
    seen_blocks: dict[str, dict[str, str]] = field(default_factory=dict)
    # Embedded quiz blocks inspect_document showed as a quiz fence (material id
    # -> block id -> (shown, stored text)): an edit expecting the shown text
    # expects the stored one.
    shown_quizzes: dict[str, dict[str, tuple[str, str]]] = field(default_factory=dict)
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


def _refused(text: str, *, code: str = "invalid_input", detail: str = "") -> ToolResult:
    return ToolResult(
        text_parts=[text], error=text, error_code=code, detail=detail, refused=True
    )


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
        f"Captured {label} as capture {n}. The rendered image is attached to the next message; "
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


def _catalog_lines(catalog: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"- {json.dumps(subject['id'])} ({int(subject.get('excerpts') or 0)} excerpts)"
        for subject in catalog
    )


def _excerpt_link(excerpt_id: str, section_path: str | None, pages: list[int]) -> str:
    listed = ", ".join(str(p) for p in pages)
    return (
        f"[{excerpt_id}]"
        + (f" {section_path}" if section_path else "")
        + (f" (pages {listed})" if listed else "")
    )


def _excerpt_head(excerpt: library.Excerpt) -> str:
    """The excerpt with its book's title and id."""
    return _excerpt_link(
        excerpt.id,
        f"{excerpt.book_title} (book {excerpt.book_id}) — {excerpt.section_path}",
        excerpt.pages,
    )


def _excerpt_facets(excerpt: library.Excerpt) -> str:
    parts = [f"roles: {', '.join(excerpt.roles)}"]
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
    subject: str | None, roles: list[str], available: dict[str, int] | None
) -> str:
    """What an empty search means. Counts only say something under a subject.

    Without a subject the by-role numbers are the whole library's and carry no
    information about the query, so the model is pointed at the filter it did
    not use instead.
    """
    head = f"No verified excerpt matches roles {', '.join(roles) or 'any'}" + (
        f" in subject {subject}." if subject else "."
    )
    if not subject:
        return (
            f"{head} This search had no subject filter. Pass a subject from this "
            "tool's list to see what that subject holds by role."
        )
    held = ", ".join(f"{role} {count}" for role, count in (available or {}).items())
    if held:
        return f"{head} That subject holds: {held}."
    return f"{head} Search again with other words or roles."


async def _search_knowledge(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    query = str(args.get("query") or "").strip()
    if not query:
        return _refused("search_knowledge needs a query.")
    subject = str(args.get("subject") or "").strip() or None
    roles = [str(r) for r in (args.get("roles") or [])]
    if subject and subject not in {s["id"] for s in ctx.library_catalog or []}:
        return _refused(
            f"Unknown subject id {subject!r}: use one listed in this tool's "
            "description, or omit subject for a direct search."
        )
    if ctx.budget is not None:
        ctx.budget.embedding_calls += 1
    try:
        result = await library.search(query, subject=subject, roles=roles)
    except ValueError as exc:
        return _refused(f"search_knowledge: {exc}")
    if not result.excerpts:
        return _result(_no_excerpts(subject, roles, result.available_roles))
    blocks = []
    for excerpt in result.excerpts:
        blocks.append(
            source_block(
                "\n".join(
                    [
                        _excerpt_head(excerpt),
                        _excerpt_facets(excerpt),
                        _excerpt_scope(excerpt),
                        excerpt.hit_text,
                    ]
                )
            )
        )
    return _result(
        "\n\n".join(blocks)
        + "\n\nRead an excerpt in full with read_knowledge before writing from it."
    )


def _short_section(section_path: str) -> str:
    """The last one or two segments of a section path, for a turn context line."""
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
    if not excerpt_id:
        return _refused("read_knowledge takes an excerpt_id.")
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
            source_block(f"{head}\n\n{body}" + _excerpt_figures(read.figures)),
            _tail(read.chunks, n, read.next_start, end),
        )

    _, text = _fitting(page, len(read.chunks))
    ctx.library_reads.note(
        read.excerpt.id, start, _short_section(read.excerpt.section_path), text=text
    )
    return _result(text)


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
        f"Captured {label} as capture {n}. The rendered image is attached to the next "
        "message; read it directly."
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
        text = (
            f"Edited '{title}' (id {rid}).{pending_note}{_relocations(effect)}"
            f"{_block_ids(effect)} The user can undo this edit from the chat result."
        )
    elif operation == "edit_undone":
        text = f"Reversed the earlier edit of '{title}' (id {rid})."
    else:
        text = (
            f"Created {resource.get('materialKind')} '{title}' (id {rid}). "
            f"It is now in the workspace.{_block_ids(effect)}"
        )
    return ToolResult(text_parts=[text], effects=[effect])


def _block_ids(effect: dict[str, Any]) -> str:
    """The note blocks a create or edit wrote (Go's blockIds), so the next
    section can follow them without an inspect."""
    ids = [str(i) for i in effect.get("blockIds") or []]
    if not ids:
        return ""
    if len(ids) <= 3:
        return f" It wrote blocks {', '.join(ids)}."
    return f" It wrote {len(ids)} blocks, {ids[0]} to {ids[-1]}."


# after_block_id "end" appends after a note's last block: the collaboration
# server lands an insert whose anchor no block holds at the end (Epo 2026-10-09
# and 2026-10-14).
END_ANCHOR = "end"


def _relocations(effect: dict[str, Any]) -> str:
    """Where the edit's inserts whose anchor block was gone landed instead."""
    out = ""
    for moved in effect.get("relocated") or []:
        if moved.get("anchor") == END_ANCHOR:
            continue  # "end" lands at the end by design: no block holds that id
        after = moved.get("after")
        place = f"after block {after}" if after else "at the start"
        why = (
            "no longer existed, so the blocks meant to follow it were added at "
            "the end of the material"
            if moved.get("end")
            else "was removed earlier in this edit, so the blocks meant to follow "
            "it took its place"
        )
        out += f" Block {moved.get('anchor')} {why}, {place}."
    return out


def unknown_chapter(ctx: ToolContext, args: dict[str, Any]) -> ToolResult | None:
    """A chapter_id that names no chapter of the workspace, refused before
    anything is sent (Go refuses it too, after the write is built). Shared
    with the playground's local writes."""
    chapter = str(args.get("chapter_id") or "")
    if chapter and chapter not in {c["id"] for c in ctx.chapters}:
        return _refused(
            "chapter_id is not a chapter of this workspace; the turn context lists them."
        )
    return None


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
    if (unknown := unknown_chapter(ctx, args)) is not None:
        return unknown
    content = str(args.get("content") or "")
    fences = questions.Check(questions.FENCE)
    if kind == "note":
        [content], fences = questions.note_fences(
            [content], lambda _: "content", _new_ids(ctx, call_id)
        )
    figures = await note_figures(ctx, [content] if kind == "note" else [])
    if isinstance(figures, ToolResult):
        return _also(figures, fences)
    prepared = await write_sources(
        ctx, "create_material", args, figures=figures.excerpt_ids
    )
    if isinstance(prepared, ToolResult):
        return _also(prepared, fences)
    if fences.problems():
        summary, listing = questions.refusal(fences)
        return _refused(summary, detail=listing)
    books, credited = prepared
    resolved = await _material_scope(ctx, args, books)
    if isinstance(resolved, ToolResult):
        return resolved
    images = await figures.render()
    if isinstance(images, ToolResult):
        return images
    content = figures.markdown[0] if figures.markdown else content
    result = await _post_material(
        ctx,
        call_id,
        args,
        resolved,
        books,
        {"kind": kind, "cards": args.get("cards") or [], "content": content},
        images=images,
    )
    if result.effects:
        landed(ctx, credited)
    return with_repairs(figures.noted(result), fences)


async def _material_scope(
    ctx: ToolContext, args: dict[str, Any], books: list[dict[str, Any]]
) -> ResolvedScope | ToolResult:
    """The scope a new material is written from. A material written from the
    library is grounded in the library, so it needs no indexed workspace
    content."""
    resolved = await _resolve_scope(ctx, args.get("scope", _MISSING))
    if isinstance(resolved, ToolResult):
        return resolved
    if not resolved.indexed and not books:
        return _refused(
            "The requested scope has no indexed content.", code="unavailable_target"
        )
    return resolved


async def _post_material(
    ctx: ToolContext,
    call_id: str,
    args: dict[str, Any],
    resolved: ResolvedScope,
    books: list[dict[str, Any]],
    content: dict[str, Any],
    *,
    images: dict[str, bytes] | None = None,
) -> ToolResult:
    """Create a material through the gateway: its kind and content, with the
    call's title, chapter, scope and provenance."""
    payload = {
        "workspaceId": ctx.workspace_id,
        "userId": ctx.user_id,
        "assistantMessageId": ctx.assistant_message_id,
        "toolCallId": call_id,
        # Model output must fit the materials.title column; the API disambiguates
        # duplicates and only reserves room for its own suffix.
        "title": str(args.get("title") or "").strip()[:MATERIAL_TITLE_MAX].strip(),
        **content,
        "fileIds": resolved.file_ids,
        "chapterIds": resolved.chapter_ids,
        "chapterId": str(args.get("chapter_id") or ""),
    }
    if books:
        # Go validates the shape and computes the material's own licence.
        payload["provenance"] = {"books": books}
    if images:
        payload["figures"] = _figure_images(images)
    await ctx.pending_sources.validate()
    return await _post_operation(
        "/api/internal/materials",
        payload,
        operation_id(ctx.assistant_message_id, call_id),
        ctx,
        failure=f"create the {content['kind']}",
        # Go stores each figure in the bucket before the note.
        timeout=60 if images else 10,
    )


def _new_ids(ctx: ToolContext, call_id: str) -> Callable[[], str]:
    """The ids of a call's new questions, in order, derived from the call."""
    counter = itertools.count()
    return lambda: questions.question_id(
        ctx.assistant_message_id, call_id, next(counter)
    )


def _also(result: ToolResult, found: questions.Check) -> ToolResult:
    """A refusal that also names the write's question problems, so the resent
    write fixes everything at once."""
    if not found.problems():
        return result
    listing = "Also fix these before sending it again:\n" + found.listing()
    return replace(result, detail="\n\n".join(p for p in (listing, result.detail) if p))


def with_repairs(result: ToolResult, found: questions.Check) -> ToolResult:
    """A landed note write names the fence slips the pipeline repaired, one
    line each, so the model stops repeating them."""
    if found.notes and result.effects:
        result.text_parts.extend(found.notes)
    return result


# ------------------------------------------------------------ note figures

# A library figure placed in note markdown. The note stores the rendered
# figure as its own image (Go agent_figures.go); the import keeps the
# reference until then (src/features/notes/markdownConvert.ts).
FIGURE_IMAGE = re.compile(
    r"!\[((?:[^\]\\]|\\.)*)\]\(\s*<?figure:([\w-]+)>?(?:\s+\"[^\"]*\")?\s*\)"
)
# Any other image, which the import turns into a link to its URL.
OTHER_IMAGE = re.compile(r"!\[(?:[^\]\\]|\\.)*\]\(\s*<?(?!figure:)[^)\s]")


@dataclass
class NoteFigures:
    """The library figures one note write places, as ``![caption](figure:<id>)``.

    ``markdown`` is the write's markdown with each figure's caption carrying
    its printed credit, ``excerpt_ids`` an excerpt this turn read that lists
    each figure, credited with the write (``write_sources``), and ``links`` the
    images with other URLs, which the import turns into links.
    """

    markdown: list[str]
    figures: dict[str, library.Figure] = field(default_factory=dict)
    excerpt_ids: list[str] = field(default_factory=list)
    links: int = 0

    async def render(self) -> dict[str, bytes] | ToolResult:
        images: dict[str, bytes] = {}
        for figure in self.figures.values():
            rendered = await render_figure(figure)
            if isinstance(rendered, ToolResult):
                return rendered
            images[figure.id] = rendered[0]
        return images

    def noted(self, result: ToolResult) -> ToolResult:
        if self.links and result.effects:
            result.text_parts.append(
                f"{self.links} image(s) with a web URL became links: a note shows "
                "only library figures, as ![caption](figure:<figure id>)."
            )
        return result


async def render_figure(
    figure: library.Figure,
) -> tuple[bytes, tuple[int, int]] | ToolResult:
    """A figure's box on its page as a JPEG with its size, as
    capture_knowledge_page renders it: deterministic, so a retried write sends
    the same bytes."""
    try:
        image, _, size = await capture.render_knowledge(
            figure.object_key,
            figure.bytes,
            figure.page,
            figure.bbox,
            cfg.capture_max_edge,
        )
    except capture.CaptureUnavailable as exc:
        return _refused(f"figure {figure.id}: {exc}", code=exc.code)
    except ValueError as exc:
        return _refused(f"figure {figure.id}: {exc}")
    return image, size


def figure_caption(text: str, figure: library.Figure) -> str:
    """The caption a figure is shown with: the model's text, else the printed
    label, then the printed credit."""
    text = " ".join(text.split()) or " ".join(figure.label.split())
    credit = " ".join(figure.credit.split())
    if credit and credit not in text:
        text = f"{text} ({credit})" if text else credit
    return text


def _figure_caption(alt: str, figure: library.Figure) -> str:
    """A note figure's caption, escaped for the image's alt text."""
    text = figure_caption(re.sub(r"\\(.)", r"\1", alt), figure)
    return re.sub(r"([\\\[\]])", r"\\\1", text)


async def note_figures(
    ctx: ToolContext, markdown: list[str]
) -> NoteFigures | ToolResult:
    """Check the library figures a note write places and credit them, or
    refuse (library_figures). Shared with the playground's local writes."""
    links = sum(len(OTHER_IMAGE.findall(text)) for text in markdown)
    refs = list(
        dict.fromkeys(
            m.group(2) for text in markdown for m in FIGURE_IMAGE.finditer(text)
        )
    )
    if not refs:
        return NoteFigures(markdown=markdown, links=links)
    checked = await library_figures(ctx, refs)
    if isinstance(checked, ToolResult):
        return checked
    found, excerpts = checked

    def caption(match: re.Match[str]) -> str:
        figure = found[match.group(2)]
        return f"![{_figure_caption(match.group(1), figure)}](figure:{figure.id})"

    return NoteFigures(
        markdown=[FIGURE_IMAGE.sub(caption, text) for text in markdown],
        figures=found,
        excerpt_ids=excerpts,
        links=links,
    )


async def library_figures(
    ctx: ToolContext, refs: list[str]
) -> tuple[dict[str, library.Figure], list[str]] | ToolResult:
    """The library figures a write places, by id, with an excerpt this turn
    read that lists each (credited with the write), or a refusal naming every
    figure it cannot show.

    A figure must be one the library shows (not decorative, excluded or on a
    withheld page), boxed apart from its page, and listed by an excerpt this
    turn read, the rule excerpt_ids follow. Shared by notes, quiz questions
    and the playground's local writes.
    """
    if not ctx.library:
        return _refused(
            f"figure:{refs[0]} names a library figure, and the library is not a "
            "source this turn."
        )
    found = await library.figures(refs)
    read = ctx.library_reads.ids()
    problems, excerpts = [], []
    for ref in refs:
        figure = found.get(ref)
        if figure is None:
            problems.append(f"{ref} is not a library figure")
        elif figure.decorative or figure.excluded:
            problems.append(f"{ref} is not shown by the library")
        elif figure.withheld:
            problems.append(f"{ref} is on a page the library withholds")
        elif figure.bbox == deck.WHOLE_PAGE:
            # The builder found the caption but not the drawing: the record is
            # the whole printed page, text and all.
            problems.append(
                f"{ref} has no box of its own (its record is all of page "
                f"{figure.page}); place another figure or describe it in words"
            )
        elif not figure.excerpt_ids:
            problems.append(f"{ref} is listed by no excerpt")
        elif not (used := [e for e in figure.excerpt_ids if e in read]):
            problems.append(
                f"{ref} is listed by excerpt {', '.join(figure.excerpt_ids)}, which "
                "this turn has not read: read_knowledge it first"
            )
        else:
            excerpts.append(used[0])
    if problems:
        return _refused("Not applied: figure " + "; ".join(problems) + ".")
    return {ref: found[ref] for ref in refs}, list(dict.fromkeys(excerpts))


def _figure_images(images: dict[str, bytes]) -> list[dict[str, str]]:
    return [
        {"id": ref, "image": base64.b64encode(image).decode()}
        for ref, image in images.items()
    ]


# ------------------------------------------------------------ material writes


async def write_sources(
    ctx: ToolContext,
    tool: str,
    args: dict[str, Any],
    *,
    material: bool = True,
    figures: list[str] | None = None,
) -> tuple[list[dict[str, Any]], list[str]] | ToolResult:
    """Check a write's library excerpts and resolve its provenance, or refuse.

    Returns the provenance books (one entry per source book) and the excerpts
    they come from. Named excerpts are credited, read or not (Epo 2026-10-14);
    a write naming none is credited with the excerpts read since the
    last write that landed (every one read when none are new), narrowed to the
    books its text matches when any does (_matching), and a turn with no
    library reads credits nothing. ``figures`` are the excerpts listing
    the note figures the write places, credited with it. Shared with the
    playground's local write stubs, so the rules have one implementation.
    ``material`` is false for an edit of the user's own source file, which
    carries no provenance.
    """
    excerpt_ids = [str(e) for e in (args.get("excerpt_ids") or [])]
    if not material:
        # Provenance is what a work was written from; a workspace source file is
        # the user's own text.
        if excerpt_ids:
            return _refused(
                "excerpt_ids belong to a study material written from the "
                "library; a source file carries no provenance."
            )
        return [], []
    if excerpt_ids and not ctx.library:
        return _refused(
            "excerpt_ids name library excerpts, and the library is not a source this "
            "turn; workspace passages need none. Call it again without excerpt_ids."
        )
    candidates = [] if excerpt_ids else ctx.library_reads.uncredited()
    wanted = list(dict.fromkeys([*(excerpt_ids or candidates), *(figures or [])]))
    if not wanted:
        return [], []
    try:
        books = await library.provenance(wanted)
    except ValueError as exc:
        return _refused(f"{tool}: {exc}")
    if not candidates:
        return books, wanted
    kept = {*_matching(ctx, books, candidates, args), *(figures or [])}
    books = [
        {**book, "excerptIds": [e for e in book["excerptIds"] if e in kept]}
        for book in books
    ]
    return [b for b in books if b["excerptIds"]], [e for e in wanted if e in kept]


# What ties a write to a book it read (Epo 2026-10-13, measured on that day's
# runs): a shared word 4-gram or example number. Lines and prefixes the read
# tools add (an excerpt's head: title, roles, teaches, scope; chunk ranges,
# links, page markers, page and run tails) are the library's, not the book's.
_WORD = re.compile(r"[a-z0-9][a-z0-9.\-/]*")
_NUMBER = re.compile(r"(?<![\w.])(\d+\.\d+|\d{2,}(?:,\d{3})*)(?![\w])")
_READ_LINE = re.compile(
    r"^(\[exc_|- \[exc_|roles:|teaches:|scope:|chunks \d+-\d+ of this excerpt"
    r"|(Previous|Next) in this book:|Source context|Excerpts on this page:"
    r"|\[p\. \d+(-\d+)?\]$|\((next start|page cut|end of)\b|.* \(book \S+, version \d+\), section "
    r"|</?source>$)"
)
_READ_PREFIX = re.compile(r"\(chunk \d+\) |Full reviewed notes: ")
# A slide's SVG counts by its text: no tags, attributes, styles or scripts.
_SVG_CODE = re.compile(r"<(style|script)\b.*?</\1>|<[^>]*>", re.DOTALL)


def _marks(text: str) -> set[str]:
    """A text's word 4-grams and its numbers with a decimal point or two or
    more digits."""
    words = _WORD.findall(text.lower())
    grams = {" ".join(words[i : i + 4]) for i in range(len(words) - 3)}
    return grams | set(_NUMBER.findall(text))


def _strings(value: Any) -> list[str]:
    """Every string a write sends, internal arguments left out."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [
            s
            for k, v in value.items()
            if not str(k).startswith("_")
            for s in _strings(v)
        ]
    if isinstance(value, list):
        return [s for v in value for s in _strings(v)]
    return []


def _book_text(text: str) -> str:
    """A read result less the lines and prefixes the read tools add."""
    return "\n".join(
        _READ_PREFIX.sub("", line)
        for line in text.splitlines()
        if not _READ_LINE.match(line)
    )


def _matching(
    ctx: ToolContext,
    books: list[dict[str, Any]],
    candidates: list[str],
    args: dict[str, Any],
) -> list[str]:
    """What a write naming no excerpts is credited with: of the candidates (the
    excerpts read since the last write, LibraryReads.uncredited), those of
    each book whose read text shares with the write a mark (``_marks``) that
    no other candidate book's read text holds, and every candidate when no
    book does, so a write is never credited less than before (Epo
    2026-10-13: only 68% of the books the whole read set credited were
    used)."""
    by_book = {
        book["id"]: [e for e in book["excerptIds"] if e in candidates] for book in books
    }
    marks = {
        book: _marks(
            "\n".join(
                _book_text(read.text)
                for read in ctx.library_reads.reads
                if read.excerpt_id in ids
            )
        )
        for book, ids in by_book.items()
    }
    if isinstance(args.get("svg"), str):
        args = {**args, "svg": _SVG_CODE.sub(" ", args["svg"])}
    written = _marks("\n".join(_strings(args)))
    matched = [
        excerpt_id
        for book, ids in by_book.items()
        if (marks[book] - set().union(*(m for b, m in marks.items() if b != book)))
        & written
        for excerpt_id in ids
    ]
    return matched or candidates


def landed(ctx: ToolContext, excerpt_ids: list[str]) -> None:
    """A material write landed crediting these excerpts: the next write naming
    none credits only later reads, and their full text is retained for later
    turns (library_evidence.py)."""
    ctx.library_reads.credit()
    ctx.library_evidence.wrote(excerpt_ids)


async def _post_operation(
    path: str,
    payload: dict[str, Any],
    op_id: str,
    ctx: ToolContext,
    *,
    failure: str,
    timeout: float = 10,
    explain: Callable[[dict[str, Any]], str] | None = None,
) -> ToolResult:
    """POST a receipt-backed mutation to the gateway.

    Transient failures retry the same operation id (Go makes it idempotent);
    a lost response is reconciled through the durable receipt read. A confirmed
    absence is a normal tool failure; an unknown outcome fails the turn.
    ``explain`` turns a refusal's ``details`` into the result's detail.
    """
    last_exc: BaseException | None = None
    last_status = 0
    last_detail = ""
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
            last_detail = _response_detail(resp)
            if resp.status_code in (400, 401, 403, 404, 409, 422) or not _is_transient(
                None, resp.status_code
            ):
                detail = _response_detail(resp)
                details = _response_details(resp)
                return _refused(
                    f"Could not {failure}: {detail or resp.status_code}",
                    code=_gateway_error_code(resp),
                    detail=explain(details) if explain and details else "",
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
        # Nothing was saved; say what the service last answered, so the model
        # can tell a passing outage from a write it should change.
        why = (
            f"the service answered {last_status}"
            + (f" ({last_detail})" if last_detail else "")
            if last_status
            else "the service could not be reached"
        )
        return _failed(f"Could not {failure}: {why} on 4 tries; nothing was saved.")
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


def _response_details(resp: requests.Response) -> dict[str, Any]:
    """A refusal's structured details (collaboration EditDetails), if any."""
    try:
        details = resp.json().get("details")
    except ValueError:
        return {}
    return details if isinstance(details, dict) else {}


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


def _render_inspection(
    body: dict[str, Any], shown: dict[str, tuple[str, str]] | None = None
) -> str:
    """An inspection as the model reads it; an embedded quiz block shows as the
    quiz fence an edit writes, recorded in ``shown``."""
    supported = list(body.get("supportedOperations") or [])
    if body.get("materialKind") == "quiz":
        supported.append("(add or replace questions with add_questions)")
    head = [
        f"{body.get('title') or ''} format={body.get('format')}",
        "supported: " + ", ".join(supported),
    ]
    lines: list[str] = []
    for block in body.get("blocks") or []:
        props = block.get("properties") or {}
        flags = " [media]" if props.get("media") else ""
        text = str(block.get("text") or "")
        view = questions.quiz_fence_view(text) if block.get("type") == "quiz" else None
        if view is not None and shown is not None:
            shown[str(block.get("id"))] = (view, text)
            text = view
        lines.append(f"[{block.get('id')}] ({block.get('type')}){flags} {text}")
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
    shown = None
    if kind == "material":
        seen = ctx.seen_blocks.setdefault(rid, {})
        for block in body.get("blocks") or []:
            seen[str(block.get("id"))] = str(block.get("text") or "")
        shown = ctx.shown_quizzes.setdefault(rid, {})
    text = _render_inspection(body, shown)
    return _result(source_block(text) if kind == "source_file" else text)


# How much of a missed block's current text a refused edit shows.
SHOWN_BLOCK_CHARS = 2000


def _missed_target(details: dict[str, Any], seen: dict[str, str]) -> str:
    """A refused edit's target as it is now, so the retry needs no
    inspect_document: the block's current text, saying when it changed since
    this turn last saw it, or the material's blocks for an id that is gone."""
    block = details.get("block")
    if isinstance(block, dict):
        bid, text = str(block.get("id") or ""), str(block.get("text") or "")
        shown = text[:SHOWN_BLOCK_CHARS]
        if len(text) > SHOWN_BLOCK_CHARS:
            more = len(text) - SHOWN_BLOCK_CHARS
            shown += f" … ({more} more characters; inspect_document shows them)"
        changed = seen.get(bid, text) != text
        return (
            f"Block {bid} ({block.get('type')})"
            + (" changed since you last saw it. It" if changed else "")
            + f" now reads:\n{shown}"
        )
    blocks = details.get("blocks")
    if isinstance(blocks, list):
        lines = [
            f"[{b.get('id')}] ({b.get('type')}) {b.get('text')}"
            for b in blocks
            if isinstance(b, dict)
        ]
        more = int(details.get("total") or len(lines)) - len(lines)
        tail = f"\n… {more} more; inspect_document pages through them" if more else ""
        return (
            "The material's blocks now, with the start of each:\n"
            + "\n".join(lines)
            + tail
        )
    return ""


def _saw_edit(seen: dict[str, str], commands: list[dict[str, Any]]) -> None:
    """Carry this turn's view of a material through its own edit: a replaced
    span is replaced in the seen text as the authority replaced it, and a
    removed or replaced block is gone."""
    for command in commands:
        kind = command.get("type")
        if kind == "replace_text":
            bid = str(command.get("target_id") or "")
            before = seen.get(bid)
            expected = str(command.get("expected_text") or "")
            if before is not None and expected and before.count(expected) == 1:
                seen[bid] = before.replace(expected, str(command.get("text") or ""))
            else:
                seen.pop(bid, None)
        elif kind in ("remove_block", "replace_block"):
            seen.pop(str(command.get("block_id") or ""), None)


def _stored_expectation(
    command: dict[str, Any], shown: dict[str, tuple[str, str]]
) -> dict[str, Any]:
    """A command expecting an embedded quiz block's text as inspect_document
    showed it (_render_inspection) expects the block's stored text."""
    view = shown.get(str(command.get("block_id") or ""))
    if view and str(command.get("expected_text") or "").strip() == view[0].strip():
        return {**command, "expected_text": view[1]}
    return command


async def _edit_document(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id or not ctx.assistant_message_id:
        return _refused(
            "Document editing is unavailable for this user.", code="lifecycle_rejected"
        )
    call_id = str(args.get("_tool_call_id") or "")
    kind, rid = _target(args)
    commands = [
        _stored_expectation(c, ctx.shown_quizzes.get(rid, {}))
        for c in args.get("commands") or []
    ]
    # Note markdown may hold quiz fences and place library figures; a source
    # file takes neither.
    placing = [
        i
        for i, c in enumerate(commands)
        if kind == "material" and c.get("type") in ("insert_markdown", "replace_block")
    ]
    texts, fences = questions.note_fences(
        [str(commands[i].get("markdown") or "") for i in placing],
        lambda n: f"commands[{placing[n]}].markdown",
        _new_ids(ctx, call_id),
    )
    figures = await note_figures(ctx, texts)
    if isinstance(figures, ToolResult):
        return _also(figures, fences)
    prepared = await write_sources(
        ctx,
        "edit_document",
        args,
        material=kind == "material",
        figures=figures.excerpt_ids,
    )
    if isinstance(prepared, ToolResult):
        return _also(prepared, fences)
    if fences.problems():
        summary, listing = questions.refusal(fences)
        return _refused(summary, detail=listing)
    books, credited = prepared
    images = await figures.render()
    if isinstance(images, ToolResult):
        return images
    for i, markdown in zip(placing, figures.markdown, strict=True):
        commands[i] = {**commands[i], "markdown": markdown}
    if kind == "source_file":
        refused = await _refuse_note_as_file(ctx, rid)
        if refused is not None:
            return refused
        resolved = await _resolve_scope(ctx, {"file_ids": [rid]})
        if isinstance(resolved, ToolResult):
            return resolved
        # Detect unrelated publications first; the acknowledged edit re-baselines after.
        await ctx.pending_sources.validate()
    payload = {
        **_chat_context(ctx, call_id),
        "target": {"kind": kind, "id": rid},
        "commands": commands,
    }
    if books:
        # Go merges these books into the target's existing provenance by id.
        payload["provenance"] = {"books": books}
    if images:
        payload["figures"] = _figure_images(images)
    result = await _post_operation(
        "/api/internal/documents/edit",
        payload,
        operation_id(ctx.assistant_message_id, call_id),
        ctx,
        failure="edit the document",
        timeout=60 if images else 10,
        explain=lambda details: _missed_target(details, ctx.seen_blocks.get(rid, {})),
    )
    if result.effects:
        # This turn's own view: drop cached outlines and re-read the exact
        # pending evidence so the next source-dependent call sees the edit.
        ctx._scope_outline = None
        if kind == "source_file":
            ctx.pending_sources = await pending.load(ctx.workspace_id, ctx.file_ids)
        else:
            landed(ctx, credited)
            _saw_edit(ctx.seen_blocks.get(rid, {}), commands)
    return with_repairs(figures.noted(result), fences)


async def _read_skill(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    name = str(args["name"]).strip()
    skill = skills.SKILLS.get(name)
    if skill is None:
        return _refused(
            f"No skill named {name}. Skills: {', '.join(skills.SKILLS)}.",
            code="unavailable_target",
        )
    return _result(skills.render(name, skill.text(ctx.library)))


# --------------------------------------------------------------- questions


@dataclass
class QuizStore:
    """Where the question tools read and write quizzes: the gateway here, the
    run's files in the playground (lab/playground/scripts/playground.py)."""

    # A quiz's title and questions by id, or a refusal.
    load: Callable[[str], Awaitable[tuple[str, list[dict[str, Any]]] | ToolResult]]
    # Create a quiz from the call's arguments, its questions and its books.
    create: Callable[
        [dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]],
        Awaitable[ToolResult],
    ]
    # Edit a quiz by id with edit commands, adding the books to its record and
    # storing the rendered library figures (by id) the commands place.
    edit: Callable[
        [str, list[dict[str, Any]], list[dict[str, Any]], dict[str, bytes]],
        Awaitable[ToolResult],
    ]


def quiz_questions(
    quiz_id: str, body: dict[str, Any]
) -> tuple[str, list[dict[str, Any]]] | ToolResult:
    """A quiz's title and questions from its inspect_document body."""
    if body.get("materialKind") != "quiz":
        return _refused(
            f"quiz_id: {quiz_id} is a {body.get('materialKind') or 'document'}, not a quiz.",
            code="unavailable_target",
        )
    found = [
        json.loads(child["text"])
        for block in body.get("blocks") or []
        for child in block.get("children") or []
        if child.get("type") == "quiz_question"
    ]
    return str(body.get("title") or ""), found


def _gateway_quizzes(ctx: ToolContext, call_id: str) -> QuizStore:
    async def load(quiz_id: str):
        body = await _gateway_read(
            "/api/internal/documents/inspect",
            {
                "workspaceId": ctx.workspace_id,
                "userId": ctx.user_id,
                "target": {"kind": "material", "id": quiz_id},
                "start": 0,
                "count": 200,
            },
            f"read quiz {quiz_id}",
        )
        return body if isinstance(body, ToolResult) else quiz_questions(quiz_id, body)

    async def create(args, written, books):
        resolved = await _material_scope(ctx, args, books)
        if isinstance(resolved, ToolResult):
            return resolved
        return await _post_material(
            ctx, call_id, args, resolved, books, {"kind": "quiz", "questions": written}
        )

    async def edit(quiz_id, commands, books, images):
        payload = {
            **_chat_context(ctx, call_id),
            "target": {"kind": "material", "id": quiz_id},
            "commands": commands,
        }
        if books:
            payload["provenance"] = {"books": books}
        if images:
            payload["figures"] = _figure_images(images)
        return await _post_operation(
            "/api/internal/documents/edit",
            payload,
            operation_id(ctx.assistant_message_id, call_id),
            ctx,
            failure="edit the quiz",
            # Go stores each figure in the bucket before the edit.
            timeout=60 if images else 10,
        )

    return QuizStore(load, create, edit)


async def write_questions(
    args: dict[str, Any], ctx: ToolContext, quizzes: QuizStore
) -> ToolResult:
    """add_questions: check every argument at once, save the valid questions
    in a new quiz or an existing one, and name the ones left out with how to
    resend them (retrieval/questions.py)."""
    call_id = str(args.get("_tool_call_id") or "")
    if not call_id or not ctx.assistant_message_id:
        return _refused("add_questions needs its tool-call and assistant message ids.")
    clean = questions.drop_blanks(
        "add_questions", {k: v for k, v in args.items() if not k.startswith("_")}
    )
    found = questions.check(clean)
    if clean.get("title") and unknown_chapter(ctx, clean) is not None:
        found.call.append(
            "chapter_id: not a chapter of this workspace; the turn context lists them; "
            f"sent {json.dumps(clean.get('chapter_id'))}"
        )
    quiz_id = clean.get("quiz_id")
    quiz: list[dict[str, Any]] | None = None
    if isinstance(quiz_id, str) and quiz_id and not clean.get("title"):
        loaded = await quizzes.load(quiz_id)
        if isinstance(loaded, ToolResult):
            return _also(loaded, found)
        quiz = loaded[1]
        questions.check_ids(found, clean, quiz)
    prepared = await write_sources(ctx, "add_questions", clean)
    if isinstance(prepared, ToolResult):
        return _also(prepared, found)
    if found.call or not found.valid:
        summary, listing = questions.refusal(found)
        return _refused(summary, detail=listing)
    books, credited = prepared
    built = questions.build(
        found, quiz, clean.get("after_question_id"), _new_ids(ctx, call_id)
    )
    if quiz is None:
        result = await quizzes.create(clean, built.questions, books)
    else:
        result = await quizzes.edit(str(quiz_id), built.commands, books, {})
    if not result.effects:
        return result
    landed(ctx, credited)
    resource = result.effects[0].get("resource") or {}
    result.text_parts = [questions.result_text(found, built, resource, quiz is None)]
    return result


async def write_media(
    args: dict[str, Any], ctx: ToolContext, quizzes: QuizStore
) -> ToolResult:
    """add_question_media: the chart, plot or library figure goes after the
    question's text, and the question is written back whole (replace_question).
    A figure is checked and credited as a note's is (library_figures)."""
    call_id = str(args.get("_tool_call_id") or "")
    if not call_id or not ctx.assistant_message_id:
        return _refused(
            "add_question_media needs its tool-call and assistant message ids."
        )
    clean = questions.drop_blanks(
        "add_question_media", {k: v for k, v in args.items() if not k.startswith("_")}
    )
    found = questions.media_check(clean)
    quiz_id, qid = clean.get("quiz_id"), clean.get("question_id")
    question = None
    if isinstance(quiz_id, str) and isinstance(qid, str):
        loaded = await quizzes.load(quiz_id)
        if isinstance(loaded, ToolResult):
            return _also(loaded, found)
        question = questions.find(found, loaded[1], qid)
        if question is not None and not questions.editable(question):
            return _refused(
                f"Quiz {quiz_id} is read-only for this user.", code="unavailable_target"
            )
    media = clean.get("media")
    figure, shown, caption = None, [], ""
    is_figure = isinstance(media, dict) and media.get("type") == "figure"
    figure_id = media.get("id") if is_figure else None
    if isinstance(figure_id, str) and figure_id.strip():
        checked = await library_figures(ctx, [figure_id])
        if isinstance(checked, ToolResult):
            return _also(checked, found)
        [figure], shown = list(checked[0].values()), checked[1]
        caption = " ".join(str(media.get("caption") or "").split())
        shown_with = figure_caption(caption, figure)
        # The image's description (alt text, what grading reads) is the
        # caption, else the printed label; Go caps it outside the bank.
        described = len(caption or " ".join(figure.label.split()))
        if not (caption or figure.label.strip()):
            found.call.append(
                f"media.caption: figure {figure.id} has no printed label; say in a "
                "few words what it shows"
            )
        elif described > QUESTION_DESCRIPTION_MAX:
            found.call.append(
                f"media.caption: expected at most {QUESTION_DESCRIPTION_MAX} "
                f"characters; sent {described}"
                if caption
                else f"media.caption: figure {figure.id}'s printed label is "
                f"{described} characters, over {QUESTION_DESCRIPTION_MAX}; send a "
                "shorter caption"
            )
        elif len(shown_with) > QUESTION_METADATA_MAX:
            found.call.append(
                f"media.caption: expected at most {QUESTION_METADATA_MAX} characters "
                f"with the printed credit; sent {len(shown_with)}"
            )
    prepared = await write_sources(ctx, "add_question_media", clean, figures=shown)
    if isinstance(prepared, ToolResult):
        return _also(prepared, found)
    if found.call or question is None:
        summary, listing = questions.refusal(found)
        return _refused(summary, detail=listing)
    books, credited = prepared
    images: dict[str, bytes] = {}
    if figure is not None:
        rendered = await render_figure(figure)
        if isinstance(rendered, ToolResult):
            return rendered
        images[figure.id], size = rendered
        media = questions.figure_block(
            figure.id,
            size,
            " ".join((caption or figure.label).split()),
            figure_caption(caption, figure),
        )
    command = {
        "type": "replace_question",
        "question_id": qid,
        "question": questions.with_media(question, media),
    }
    result = await quizzes.edit(str(quiz_id), [command], books, images)
    if result.effects:
        landed(ctx, credited)
        resource = result.effects[0].get("resource") or {}
        result.text_parts = [
            (
                f"Added the {clean['media']['type']} to question {qid} of quiz "
                f"'{resource.get('title')}' (id {resource.get('id')}), after its text. "
                "The user can undo this from the chat result."
            ),
            *found.notes,
        ]
    return result


async def _add_questions(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    quizzes = _gateway_quizzes(ctx, str(args.get("_tool_call_id") or ""))
    return await write_questions(args, ctx, quizzes)


async def _add_question_media(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    quizzes = _gateway_quizzes(ctx, str(args.get("_tool_call_id") or ""))
    return await write_media(args, ctx, quizzes)


# ------------------------------------------------------------------ decks


async def _create_deck(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    """Outline a deck for this turn. Nothing is stored until every slide is
    written (retrieval/deck.py)."""
    call_id = str(args.get("_tool_call_id") or "")
    if not call_id or not ctx.assistant_message_id:
        return _refused("create_deck needs its tool-call and assistant message ids.")
    if (unknown := unknown_chapter(ctx, args)) is not None:
        return unknown
    prepared = await write_sources(ctx, "create_deck", args)
    if isinstance(prepared, ToolResult):
        return prepared
    books, _ = prepared
    record = deck.create(args, deck.deck_id(ctx.assistant_message_id, call_id))
    deck.add_books(record, books)
    ctx.decks[record["id"]] = record
    # A deck is a file, so its excerpts are credited but not retained.
    ctx.library_reads.credit()
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
    prepared = await write_sources(ctx, "write_slide", args)
    if isinstance(prepared, ToolResult):
        return prepared
    books, _ = prepared
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
    ctx.library_reads.credit()
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
_register("read_knowledge", _read_knowledge)
_register("read_skill", _read_skill)
_register("read_study_progress", _read_study_progress)
_register("capture_knowledge_page", _capture_knowledge_page)
_register("list_sources", _list_sources)
_register("read_document", _read_document)
_register("capture_page", _capture_page)
_register("create_material", _create_material)
_register("add_questions", _add_questions)
_register("add_question_media", _add_question_media)
_register("resolve_source_change", _resolve_source_change)
_register("inspect_document", _inspect_document)
_register("edit_document", _edit_document)
_register("trash_file", _trash_file)
_register("list_trashed_files", _list_trashed_files)
_register("restore_file", _restore_file)
_register("create_deck", _create_deck)
_register("write_slide", _write_slide)


# Offered only with the Library switch on and a configured library.
KNOWLEDGE_TOOLS = ("search_knowledge", "read_knowledge")
KNOWLEDGE_CAPTURE = "capture_knowledge_page"
# Offered with ppt-master installed (the retrieval image has it).
DECK_TOOLS = ("create_deck", "write_slide")


def _offered(spec: ToolSpec, ctx: ToolContext) -> bool:
    definition = spec.definition
    if not set(definition["requiredOperations"]) <= ctx.operations:
        return False
    if definition["mutates"] and not (_gateway_ready() and ctx.user_id):
        return False
    if spec.name == "read_study_progress":
        return ctx.study_progress
    if spec.name == KNOWLEDGE_CAPTURE:
        # Without the knowledge-base bucket there is nothing to render.
        return ctx.library and library.enabled() and bool(cfg.knowledge_base_b2_bucket)
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
    # The model maps the learner's words onto a subject from this list.
    extra = {
        "read_skill": skills.catalog(
            preferences.merged(ctx.study_preferences)["mainFormat"]
        )
    }
    if ctx.library_catalog:
        extra["search_knowledge"] = (
            "\n\nSubjects this library holds:\n" + _catalog_lines(ctx.library_catalog)
        )
    for schema in schemas:
        name = schema["function"]["name"]
        if name in extra:
            schema["function"]["description"] += extra[name]
    return schemas if ctx.library else [without_excerpts(s) for s in schemas]


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


def without_blanks(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """The call with its blank optional arguments left out (contract.drop_blanks;
    Epo 2026-10-13: blank means absent). The question tools leave out blanks
    per question kind in their handlers (questions.drop_blanks)."""
    definition = contract.definition(name)
    if definition is None or name in contract.HANDLER_CHECKED:
        return args
    own = {k: v for k, v in args.items() if not k.startswith("_")}
    return {
        **contract.drop_blanks(definition["inputSchema"], own),
        **{k: v for k, v in args.items() if k.startswith("_")},
    }


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
    args = without_blanks(name, args)
    problem = contract.validate_args(
        name, {k: v for k, v in args.items() if not k.startswith("_")}
    )
    if problem:
        return _refused(problem)
    needs = skills.missing(name, args, ctx.skills_read)
    if needs:
        return _refused(
            skills.refusal(needs),
            detail=skills.carried(needs, lambda n: skills.SKILLS[n].text(ctx.library)),
        )
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
        return result.text()
    parts: list[str] = []
    if numbered and result.paged:
        body = "\n\n".join(
            source_block(
                f"[{number}] {passage.location()} (chunk {passage.chunk_idx})\n{passage.text}"
            )
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
