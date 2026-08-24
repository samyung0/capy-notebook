"""Provider-neutral stream assembly for one model response.

Adapters own wire formats. The agent loop consumes AssembledResponse.
Reasoning deltas stay here for telemetry. They never become visible text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .usage_extract import NormalizedUsage, extract_usage


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str


@dataclass
class StreamEvent:
    kind: str
    text: str = ""
    phase: str = ""
    usage: NormalizedUsage | None = None
    status: str = ""
    message: str = ""


@dataclass
class AssembledResponse:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    usage: NormalizedUsage = field(default_factory=NormalizedUsage)
    output_items: list[dict[str, Any]] = field(default_factory=list)
    status: str = "complete"
    error: str = ""


def _get(obj: Any, *names: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        for name in names:
            if name in obj and obj[name] is not None:
                return obj[name]
        return default
    for name in names:
        if hasattr(obj, name):
            value = getattr(obj, name)
            if value is not None:
                return value
    return default


class ChatCompletionsAssembler:
    """Assemble indexed delta.tool_calls fragments and terminal usage."""

    def __init__(self, provider: str) -> None:
        self.provider = provider
        self.text_parts: list[str] = []
        self._calls: dict[int, dict[str, str]] = {}
        self.usage = NormalizedUsage()
        self.status = "complete"
        self.error = ""

    def push(self, chunk: Any) -> list[StreamEvent]:
        events: list[StreamEvent] = []
        usage = _get(chunk, "usage")
        if usage is not None:
            self.usage = extract_usage(usage, provider=self.provider)
            events.append(StreamEvent(kind="usage", usage=self.usage))
        choices = _get(chunk, "choices") or []
        if not choices:
            return events
        choice = choices[0]
        finish = _get(choice, "finish_reason", "finishReason")
        if finish == "length":
            self.status = "incomplete"
        delta = _get(choice, "delta") or {}
        text = _get(delta, "content") or ""
        if text:
            self.text_parts.append(text)
            events.append(StreamEvent(kind="text", text=text))
        for raw in _get(delta, "tool_calls", "toolCalls") or []:
            index = int(_get(raw, "index") or 0)
            slot = self._calls.setdefault(
                index, {"id": "", "name": "", "arguments": ""}
            )
            call_id = _get(raw, "id") or ""
            if call_id:
                slot["id"] = call_id
            fn = _get(raw, "function") or {}
            name = _get(fn, "name") or ""
            if name:
                slot["name"] = name
            args = _get(fn, "arguments") or ""
            if args:
                slot["arguments"] += args
            events.append(StreamEvent(kind="tool_delta"))
        return events

    def finish(self) -> AssembledResponse:
        calls = [
            ToolCall(
                id=slot["id"] or f"call_{index}",
                name=slot["name"],
                arguments=slot["arguments"],
            )
            for index, slot in sorted(self._calls.items())
        ]
        return AssembledResponse(
            text="".join(self.text_parts),
            tool_calls=calls,
            usage=self.usage,
            status=self.status,
            error=self.error,
        )


class OpenAIResponsesAssembler:
    """Assemble Responses semantic events and replayable output items."""

    def __init__(self) -> None:
        self.text_parts: list[str] = []
        self._calls: dict[str, dict[str, str]] = {}
        self._order: list[str] = []
        self.output_items: list[dict[str, Any]] = []
        self._item_ids: set[str] = set()
        self.usage = NormalizedUsage()
        self.status = "complete"
        self.error = ""
        self._item_phase: dict[str, str] = {}

    def push(self, event: Any) -> list[StreamEvent]:
        etype = str(_get(event, "type") or "")
        events: list[StreamEvent] = []
        if etype in ("response.output_text.delta", "response.text.delta"):
            text = str(_get(event, "delta") or "")
            if text:
                self.text_parts.append(text)
                events.append(StreamEvent(kind="text", text=text))
            return events
        if etype == "response.reasoning_text.delta":
            events.append(StreamEvent(kind="reasoning"))
            return events
        if etype == "response.output_item.added":
            item = _as_dict(_get(event, "item"))
            if item:
                self._note_item(item)
                phase = str(item.get("phase") or "")
                if phase:
                    events.append(StreamEvent(kind="status", phase=phase))
            return events
        if etype == "response.output_item.done":
            item = _as_dict(_get(event, "item"))
            if item:
                self._store_item(item)
            return events
        if etype == "response.function_call_arguments.delta":
            item_id = str(_get(event, "item_id", "itemId") or "")
            delta = str(_get(event, "delta") or "")
            slot = self._slot(item_id)
            slot["arguments"] += delta
            events.append(StreamEvent(kind="tool_delta"))
            return events
        if etype == "response.completed":
            resp = _get(event, "response")
            self.usage = extract_usage(_get(resp, "usage"), provider="openai")
            for item in _get(resp, "output") or []:
                self._store_item(_as_dict(item))
            events.append(StreamEvent(kind="usage", usage=self.usage))
            return events
        if etype == "response.incomplete":
            self.status = "incomplete"
            resp = _get(event, "response")
            if resp is not None:
                self.usage = extract_usage(_get(resp, "usage"), provider="openai")
            return events
        if etype == "response.failed":
            self.status = "error"
            resp = _get(event, "response")
            err = _get(resp, "error") if resp is not None else None
            self.error = str(_get(err, "message") or "response failed")
            events.append(
                StreamEvent(kind="status", status="error", message=self.error)
            )
        return events

    def _slot(self, item_id: str) -> dict[str, str]:
        if item_id not in self._calls:
            self._calls[item_id] = {"id": "", "name": "", "arguments": ""}
            self._order.append(item_id)
        return self._calls[item_id]

    def _note_item(self, item: dict[str, Any]) -> None:
        kind = str(item.get("type") or "")
        item_id = str(item.get("id") or item.get("call_id") or "")
        if kind == "function_call":
            slot = self._slot(item_id)
            slot["id"] = str(item.get("call_id") or item.get("id") or item_id)
            slot["name"] = str(item.get("name") or "")
            if item.get("arguments"):
                slot["arguments"] = str(item.get("arguments") or "")
        phase = str(item.get("phase") or "")
        if phase and item_id:
            self._item_phase[item_id] = phase

    def _store_item(self, item: dict[str, Any]) -> None:
        if not item:
            return
        self._note_item(item)
        kind = str(item.get("type") or "")
        if kind not in ("reasoning", "function_call", "message", "output_text"):
            return
        item_id = str(item.get("id") or item.get("call_id") or "")
        if item_id:
            if item_id in self._item_ids:
                return
            self._item_ids.add(item_id)
        elif item in self.output_items:
            return
        self.output_items.append(item)

    def finish(self) -> AssembledResponse:
        calls = [
            ToolCall(
                id=self._calls[key]["id"] or key,
                name=self._calls[key]["name"],
                arguments=self._calls[key]["arguments"],
            )
            for key in self._order
            if self._calls[key]["name"]
        ]
        return AssembledResponse(
            text="".join(self.text_parts),
            tool_calls=calls,
            usage=self.usage,
            output_items=list(self.output_items),
            status=self.status,
            error=self.error,
        )


def _as_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return dump()
    out: dict[str, Any] = {}
    for key in (
        "id",
        "type",
        "status",
        "role",
        "name",
        "arguments",
        "call_id",
        "encrypted_content",
        "phase",
        "content",
        "summary",
    ):
        if hasattr(value, key):
            out[key] = getattr(value, key)
    return out
