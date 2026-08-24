"""Per-provider-call accounting for a chat spend session.

The Go gateway owns credit policy and concurrent turn admission. Chat binds the
gateway's spend-session id here so every provider call can settle measured usage
before the agent chooses the next call.
"""

from __future__ import annotations

import asyncio
import contextvars
import secrets
from dataclasses import dataclass
from typing import Any

import requests

from .. import obs
from ..config import cfg
from ..registry import ModelConfig
from .usage_extract import NormalizedUsage

KIND_LLM = "llm"
KIND_EMBEDDING = "embedding"

PURPOSE_AGENT = "agent"
PURPOSE_TERMINAL = "terminal"
PURPOSE_LIVE_COMPACTION = "live_compaction"
PURPOSE_CHECKPOINT = "checkpoint"

_SETTLE_ATTEMPTS = 4
_SETTLE_TIMEOUT_S = 10


class AccountingError(RuntimeError):
    pass


@dataclass
class RequestAccounting:
    session_id: str
    credits_exhausted: bool = False
    terminal_call_allowed: bool = False
    settled_calls: int = 0


_accounting: contextvars.ContextVar[RequestAccounting | None] = contextvars.ContextVar(
    "chat_request_accounting", default=None
)


def bind(session_id: str) -> contextvars.Token[RequestAccounting | None]:
    if not session_id:
        raise AccountingError("chat spend session is required")
    if not cfg.gateway_url or not cfg.pipeline_secret:
        raise AccountingError("chat accounting callback is unavailable")
    return _accounting.set(RequestAccounting(session_id=session_id))


def reset(token: contextvars.Token[RequestAccounting | None]) -> None:
    _accounting.reset(token)


def current() -> RequestAccounting | None:
    return _accounting.get()


def new_call_id() -> str:
    return "pc_" + secrets.token_hex(10)


async def settle(
    *,
    call_id: str,
    kind: str,
    purpose: str,
    spec: ModelConfig,
    usage: NormalizedUsage,
) -> RequestAccounting | None:
    state = current()
    if state is None:
        return None
    payload = {
        "sessionId": state.session_id,
        "callId": call_id,
        "kind": kind,
        "purpose": purpose,
        "provider": spec.provider_slug,
        "model": spec.provider_model_id,
        **usage.as_dict(),
    }
    response = await _post_settlement(payload)
    state.credits_exhausted = bool(response.get("creditsExhausted"))
    state.terminal_call_allowed = bool(response.get("terminalCallAllowed"))
    state.settled_calls += 1
    return state


async def _post_settlement(payload: dict[str, Any]) -> dict[str, Any]:
    url = cfg.gateway_url.rstrip("/") + "/api/internal/provider-calls"
    headers = {
        "Content-Type": "application/json",
        "X-Pipeline-Secret": cfg.pipeline_secret,
        **obs.outbound_headers(),
    }
    last_error = ""
    for attempt in range(_SETTLE_ATTEMPTS):
        try:

            def _post() -> requests.Response:
                return requests.post(
                    url,
                    headers=headers,
                    json=payload,
                    timeout=_SETTLE_TIMEOUT_S,
                )

            response = await asyncio.to_thread(_post)
            if response.status_code < 300:
                try:
                    body = response.json()
                except ValueError as exc:
                    raise AccountingError(
                        "chat accounting returned invalid JSON"
                    ) from exc
                if not isinstance(body, dict):
                    raise AccountingError("chat accounting returned an invalid body")
                return body
            last_error = _response_detail(response) or str(response.status_code)
            if response.status_code < 500 and response.status_code != 429:
                break
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_error = str(exc)
        except requests.RequestException as exc:
            last_error = str(exc)
            break
        if attempt < _SETTLE_ATTEMPTS - 1:
            await asyncio.sleep(0.25 * (2**attempt))
    raise AccountingError(f"chat accounting failed: {last_error or 'unavailable'}")


def _response_detail(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    if not isinstance(body, dict):
        return ""
    return str(body.get("message") or body.get("code") or "")
