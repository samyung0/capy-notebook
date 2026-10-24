"""Typed SSE events for one chat turn.

The browser and the Go relay share this shape. Activity blocks are persisted
in message metadata. They are not sent back as LLM history. Tool results use
the shared agent-tool contract: ``outcome`` is terminal, ``error`` is the safe
typed error, ``effects`` are the durable resource effects the call committed.
"""

from __future__ import annotations

from typing import Any


def phase(name: str) -> dict[str, Any]:
    return {"type": "phase", "phase": name}


def block_start(block_id: str) -> dict[str, Any]:
    return {"type": "block_start", "blockId": block_id}


def block_delta(block_id: str, text: str) -> dict[str, Any]:
    return {"type": "block_delta", "blockId": block_id, "text": text}


def block_end(block_id: str, kind: str) -> dict[str, Any]:
    return {"type": "block_end", "blockId": block_id, "kind": kind}


def tool_start(
    call_id: str, name: str, detail: str, *, started_at: str
) -> dict[str, Any]:
    """``detail`` is the row's human label; ``started_at`` RFC 3339 UTC."""
    return {
        "type": "tool_start",
        "callId": call_id,
        "name": name,
        "detail": detail,
        "startedAt": started_at,
    }


def tool_progress(call_id: str, applied: int, total: int) -> dict[str, Any]:
    """How many of a running call's commands are applied, out of how many: a
    call sends any number of these between its tool_start and tool_end. An
    Office edit the engine cut at a per-call limit sends one and stays open
    (Epo 2026-10-23, Q171)."""
    return {
        "type": "tool_progress",
        "callId": call_id,
        "applied": applied,
        "total": total,
    }


def tool_end(
    call_id: str,
    outcome: str,
    *,
    error: dict[str, str] | None = None,
    effects: list[dict[str, Any]] | None = None,
    ended_at: str,
    applied: int | None = None,
    total: int | None = None,
) -> dict[str, Any]:
    """``applied`` of ``total`` only for a call that ended with commands
    unapplied."""
    event: dict[str, Any] = {
        "type": "tool_end",
        "callId": call_id,
        "outcome": outcome,
        "endedAt": ended_at,
    }
    if error:
        event["error"] = error
    if effects:
        event["effects"] = effects
    if applied is not None and total is not None:
        event["applied"], event["total"] = applied, total
    return event


def citations(
    items: list[dict[str, Any]], version: int, *, final: bool = False
) -> dict[str, Any]:
    """``final`` marks the answer's own list: only the passages it used, in
    first-appearance order, which is what Go persists."""
    event: dict[str, Any] = {
        "type": "citations",
        "citations": items,
        "version": version,
    }
    if final:
        event["final"] = True
    return event


def checkpoint(payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": "checkpoint", **payload}


def turn_checkpoint(
    activity: list[dict[str, Any]],
    tool_evidence: dict[str, Any],
    *,
    stopped: bool = False,
) -> dict[str, Any]:
    """The turn so far, after each tool batch: Go saves it on the streaming
    row, so a turn that never reaches ``done`` keeps its finished calls. The
    last event of a stopped turn is one marked ``stopped``."""
    event: dict[str, Any] = {
        "type": "turn_checkpoint",
        "activity": activity,
        "toolEvidence": tool_evidence,
    }
    if stopped:
        event["stopped"] = True
    return event


def done(
    usage: dict[str, Any] | None,
    token_count: int,
    telemetry: dict[str, Any],
    activity: list[dict[str, Any]],
    answer: str,
) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "done",
        "tokenCount": token_count,
        "telemetry": telemetry,
        "activity": activity,
        "answer": answer,
    }
    if usage:
        event["usage"] = usage
    return event


def error(message: str, code: str | None = None) -> dict[str, Any]:
    event: dict[str, Any] = {"type": "error", "message": message}
    if code:
        event["code"] = code
    return event
