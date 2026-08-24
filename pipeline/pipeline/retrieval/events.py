"""Typed SSE events for one chat turn.

The browser and the Go relay share this shape. Activity blocks are persisted
in message metadata. They are not sent back as LLM history.
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


def tool_start(call_id: str, name: str, detail: str) -> dict[str, Any]:
    return {
        "type": "tool_start",
        "callId": call_id,
        "name": name,
        "detail": detail,
    }


def tool_end(call_id: str, status: str) -> dict[str, Any]:
    return {"type": "tool_end", "callId": call_id, "status": status}


def citations(items: list[dict[str, Any]], version: int) -> dict[str, Any]:
    return {"type": "citations", "citations": items, "version": version}


def checkpoint(payload: dict[str, Any]) -> dict[str, Any]:
    return {"type": "checkpoint", **payload}


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
