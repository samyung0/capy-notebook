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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import requests

from ..config import cfg
from ..generated import MATERIAL_TITLE_MAX
from . import contract, pending, store
from .chunking import clip_to_tokens, estimate_tokens
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


@dataclass
class ToolContext:
    workspace_id: str
    user_id: str = ""
    # Resource operations the gateway granted this actor for the turn
    # (contract.OPERATIONS names). Tools whose required operations are not all
    # present are neither offered nor dispatched.
    operations: frozenset[str] = frozenset()
    # None is the unrestricted workspace scope. A list is a restricted scope,
    # and an empty list stays empty: trashing the last selected file must not
    # widen the scope to every file.
    file_ids: list[str] | None = None
    citations: list[Passage] = field(default_factory=list)
    assistant_message_id: str = ""
    budget: TurnBudget | None = None
    pending_sources: pending.PendingSources = field(
        default_factory=pending.PendingSources
    )
    # One entry per search_workspace call this turn, written to
    # rag_search_events when the turn ends (agent.run_agent fills `cited`).
    search_events: list[dict[str, Any]] = field(default_factory=list)
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
    outline = await store.workspace_outline(ctx.workspace_id)
    allowed = None if ctx.file_ids is None else set(ctx.file_ids)
    lines: list[str] = []
    by_chapter: dict[str | None, list[dict[str, Any]]] = {}
    for file in outline["files"]:
        if allowed is not None and file["id"] not in allowed:
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
    resolved = await _resolve_scope(ctx, args.get("scope", _MISSING))
    if isinstance(resolved, ToolResult):
        return resolved
    if not resolved.indexed:
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

    await ctx.pending_sources.validate()
    return await _post_operation(
        "/api/internal/materials", payload, op_id, ctx, failure=f"create the {kind}"
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
            log.warning("operation POST attempt failed: %s", exc)
        except requests.RequestException as exc:
            last_exc = exc
            log.warning("operation POST attempt failed: %s", exc)
        if attempt < 3:
            await asyncio.sleep(0.25 * (2**attempt))
    if last_exc is not None:
        log.warning(
            "operation POST exhausted retries: %s status=%s", last_exc, last_status
        )

    recovered = await _recover_operation(op_id, ctx)
    if recovered is True:
        raise TurnFailed("mutation outcome is unknown")
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


async def _list_documents(args: dict[str, Any], ctx: ToolContext) -> ToolResult:
    if not _gateway_ready() or not ctx.user_id:
        return _refused(
            "Document tools are unavailable for this user.", code="lifecycle_rejected"
        )
    body = await _gateway_read(
        "/api/internal/documents/list",
        {
            "workspaceId": ctx.workspace_id,
            "userId": ctx.user_id,
            "kind": args.get("kind") or "",
            "query": args.get("query") or "",
        },
        "list the documents",
    )
    if isinstance(body, ToolResult):
        return body
    allowed = None if ctx.file_ids is None else set(ctx.file_ids)
    lines = []
    for item in body.get("items") or []:
        if (
            item.get("kind") == "source_file"
            and allowed is not None
            and item.get("id") not in allowed
        ):
            continue
        state = (
            "editable"
            if item.get("editable")
            else f"read-only: {item.get('reason') or ''}".rstrip(": ")
        )
        extra = f", {item.get('materialKind')}" if item.get("materialKind") else ""
        lines.append(
            f"- {item.get('title')} (kind={item.get('kind')}, id={item.get('id')}, "
            f"format={item.get('format')}{extra}, {state})"
        )
    if not lines:
        return _result("This workspace has no documents in scope.")
    return _result(
        "Documents (inspect_document takes kind and id):\n" + "\n".join(lines)
    )


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
    if kind == "source_file":
        resolved = await _resolve_scope(ctx, {"file_ids": [rid]})
        if isinstance(resolved, ToolResult):
            return resolved
        # Detect unrelated publications first; the acknowledged edit re-baselines after.
        await ctx.pending_sources.validate()
    result = await _post_operation(
        "/api/internal/documents/edit",
        {
            **_chat_context(ctx, call_id),
            "target": {"kind": kind, "id": rid},
            "commands": list(args.get("commands") or []),
        },
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
    return result


REGISTRY: dict[str, ToolSpec] = {}


def _register(name: str, handler: Handler) -> None:
    """Bind a local handler to a contract definition. Unknown names fail at import."""
    if name not in contract.DEFINITIONS:
        raise RuntimeError(f"tool {name} has no definition in the agent-tool contract")
    REGISTRY[name] = ToolSpec(name=name, handler=handler)


_register("search_workspace", _search_workspace)
_register("list_sources", _list_sources)
_register("describe_documents", _describe_documents)
_register("read_document", _read_document)
_register("create_material", _create_material)
_register("resolve_source_change", _resolve_source_change)
_register("list_documents", _list_documents)
_register("inspect_document", _inspect_document)
_register("edit_document", _edit_document)
_register("trash_file", _trash_file)
_register("list_trashed_files", _list_trashed_files)
_register("restore_file", _restore_file)


def _offered(spec: ToolSpec, ctx: ToolContext) -> bool:
    definition = spec.definition
    if not set(definition["requiredOperations"]) <= ctx.operations:
        return False
    if definition["mutates"] and not (_gateway_ready() and ctx.user_id):
        return False
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
    return [
        contract.model_schema(spec.name)
        for spec in REGISTRY.values()
        if _offered(spec, ctx)
    ]


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
