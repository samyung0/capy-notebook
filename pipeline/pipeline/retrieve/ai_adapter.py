"""Note ghost text adapter.

Turns the text around the caret into one short completion on the editor
slot's pin (Epo 2026-10-28). The prompt is server-owned; the browser sends only
the note title and the text before and after the caret.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .. import elitellm, registry
from ..prompts import editor as editor_prompts
from ..retrieval import accounting, limits, models
from ..retrieval.chunking import clip_to_tokens

log = logging.getLogger("capy.retrieve.ai")
router = APIRouter(prefix="/plate-ai", tags=["plate-ai"])

# The gateway already bounds these; a margin keeps Python from trusting it alone.
MAX_GHOST_CONTEXT_CHARS = 2_000
MAX_GHOST_TITLE_CHARS = 1_024

ThinkingLevel = Literal["instant", "low", "mid", "high", "max"]


class GhostTextReq(BaseModel):
    model_config = ConfigDict(extra="ignore")
    workspaceId: str = Field(min_length=1, max_length=128)
    title: str = Field(default="", max_length=MAX_GHOST_TITLE_CHARS)
    before: str = Field(min_length=1, max_length=MAX_GHOST_CONTEXT_CHARS)
    after: str = Field(default="", max_length=MAX_GHOST_CONTEXT_CHARS)
    providerSlug: str | None = None
    modelSlug: str | None = None
    configVersion: int | None = None
    thinking: ThinkingLevel
    spendSessionId: str = ""


class AIAdapterError(RuntimeError):
    def __init__(
        self, code: str, message: str, status: int = 502, retryable: bool = False
    ):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


def _busy_http_exception(exc: elitellm.ProviderBusy) -> HTTPException:
    seconds = models.busy_retry_after_s(exc)
    return HTTPException(
        status_code=503,
        detail={
            "code": models.BUSY_ERROR_CODE,
            "message": models.BUSY_ERROR,
            "retryable": True,
            "retryAfterSeconds": seconds,
        },
        headers={"Retry-After": str(seconds)},
    )


def _refuse_past_capacity() -> None:
    """Editor AI calls never wait (Q268) and are not turns (Q338): at the
    turns-in-progress ceiling or with every call slot taken they answer 503
    provider_busy before starting a response (Q339, Q359). The call still
    takes its own slot (``bind_call_slots``), answering busy if another call
    took the last one meanwhile."""
    if limits.TURN_SLOTS.full() or limits.CALL_SLOTS.full():
        raise _busy_http_exception(
            elitellm.ProviderBusy(
                models.CALL_LIMIT_BUSY, retry_after=accounting.BUSY_RETRY_AFTER_S
            )
        )


def _editor_spec(req: GhostTextReq):
    registry.bind_request_llm(req.thinking)
    return models.resolve_query_model(
        req.providerSlug,
        req.modelSlug,
        req.configVersion,
        slot=registry.Slot.EDITOR,
    )


def _ensure_provider(spec) -> None:
    try:
        key = registry.provider_api_key_for(spec)
    except registry.RegistryError as exc:
        raise AIAdapterError(
            "ai_unavailable",
            "AI provider is not configured",
            status=503,
            retryable=True,
        ) from exc
    if not key:
        raise AIAdapterError(
            "ai_unavailable",
            "AI provider is not configured",
            status=503,
            retryable=True,
        )


async def _wait_completion(
    request: Request,
    messages: list[dict[str, Any]],
    *,
    model: Any,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
):
    if messages:
        last = dict(messages[-1])
        last["content"] = clip_to_tokens(
            str(last.get("content") or ""), registry.input_budget(model)
        )
        messages = [*messages[:-1], last]
    task = asyncio.create_task(
        models.complete_response(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            reasoning=reasoning,
        )
    )
    try:
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                # complete_response may already hold a provider receipt. Await
                # its cancellation cleanup so accounting can settle that known
                # usage before this disconnected request exits.
                await task
                raise asyncio.CancelledError
            await asyncio.sleep(0.05)
        return await task
    finally:
        if not task.done():
            task.cancel()


def ghost_suggestion(before: str, text: str) -> str:
    """The reply as it goes at the caret: its first line only (a suggestion
    stays in the block), without leading whitespace when the text before the
    caret already ends in whitespace (Epo 2026-10-28)."""
    text = text.split("\n", 1)[0]
    if before[-1:].isspace():
        text = text.lstrip()
    return text.rstrip()


@router.post("/copilot")
async def plate_copilot(req: GhostTextReq, request: Request):
    _refuse_past_capacity()
    token = accounting.bind(req.spendSessionId) if req.spendSessionId else None
    slots = limits.bind_call_slots(limits.CallSlotPolicy(wait_s=0))
    try:
        spec = _editor_spec(req)
        _ensure_provider(spec)
        response = await _wait_completion(
            request,
            editor_prompts.ghost_text_messages(req.title, req.before, req.after),
            model=spec,
            max_tokens=editor_prompts.GHOST_MAX_TOKENS,
            temperature=editor_prompts.GHOST_TEMPERATURE,
            reasoning=False,
        )
    except asyncio.CancelledError as exc:
        raise HTTPException(
            status_code=408,
            detail={
                "code": "cancelled",
                "message": "request cancelled",
                "retryable": True,
            },
        ) from exc
    except AIAdapterError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": str(exc), "retryable": exc.retryable},
        ) from exc
    except elitellm.ProviderBusy as exc:
        raise _busy_http_exception(exc) from exc
    except Exception as exc:
        log.exception("Ghost text failed")
        raise HTTPException(
            status_code=502,
            detail={
                "code": "provider_error",
                "message": "AI provider request failed",
                "retryable": True,
            },
        ) from exc
    finally:
        limits.reset_call_slots(slots)
        if token is not None:
            accounting.reset(token)
    text = response.choices[0].message.content if response.choices else ""
    return {"text": ghost_suggestion(req.before, text or "")}
