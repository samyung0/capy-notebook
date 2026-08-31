"""Per-provider-call accounting for a spend session.

The Go gateway owns credit policy and concurrent turn admission. A request
binds the gateway's spend-session id here so every provider call can open a
pending row, then settle measured usage, before the next call is chosen.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import secrets
from dataclasses import dataclass
from typing import Any

import requests

from .. import elitellm, obs
from ..config import cfg
from ..registry import ModelConfig
from .usage_extract import NormalizedUsage

log = logging.getLogger("evo.accounting")

KIND_LLM = "llm"
KIND_EMBEDDING = "embedding"
KIND_AUDIO = "audio"

PURPOSE_AGENT = "agent"
PURPOSE_TERMINAL = "terminal"
PURPOSE_LIVE_COMPACTION = "live_compaction"
PURPOSE_CHECKPOINT = "checkpoint"

_SETTLE_ATTEMPTS = 4
_SETTLE_TIMEOUT_S = 10
CONTEXT_COUNTING_METHOD = "provider_shape_cjk_chars_latin_chars_div3"
CONTEXT_COUNTING_VERSION = 2


class AccountingError(RuntimeError):
    pass


@dataclass(frozen=True)
class ContextComposition:
    system_tokens: int = 0
    tool_tokens: int = 0
    conversation_tokens: int = 0
    window_tokens: int = 0
    counting_method: str = CONTEXT_COUNTING_METHOD
    counting_version: int = CONTEXT_COUNTING_VERSION

    @property
    def total_tokens(self) -> int:
        return self.system_tokens + self.tool_tokens + self.conversation_tokens


def measure_context(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
    window_tokens: int = 0,
) -> ContextComposition:
    """Estimate the three operator-visible parts of one provider request.

    The provider supplies only the final total input count. These values are
    numeric telemetry, calculated immediately before the outbound call. No
    prompt or schema content is retained.
    """
    system = 0
    conversation = 0
    for message in messages:
        count = estimate_context_value(message)
        if message.get("role") == "system":
            system += count
        else:
            conversation += count
    schemas: list[Any] = list(tools or [])
    if response_format:
        schemas.append(response_format)
    tool_tokens = estimate_context_value(schemas) if schemas else 0
    return ContextComposition(
        system_tokens=system,
        tool_tokens=tool_tokens,
        conversation_tokens=conversation,
        window_tokens=max(0, int(window_tokens)),
    )


def estimate_context_value(value: Any) -> int:
    """Conservatively count one provider-shaped JSON value.

    JSON keys, ids, and punctuation tokenize worse than document prose. Latin
    content therefore uses three characters per token here while CJK remains
    one token per character.
    """
    serialized = (
        value
        if isinstance(value, str)
        else json.dumps(
            value,
            ensure_ascii=False,
            default=str,
            separators=(",", ":"),
        )
    )
    if not serialized:
        return 0
    from .chunking import _is_cjk

    cjk = sum(1 for char in serialized if _is_cjk(char))
    latin = len(serialized) - cjk
    return cjk + (latin + 2) // 3


def measure_components(
    system: Any,
    conversation: Any,
    tools: Any,
    *,
    window_tokens: int = 0,
) -> ContextComposition:
    """Measure fields after the provider-specific request transformation."""
    return ContextComposition(
        system_tokens=estimate_context_value(system),
        tool_tokens=estimate_context_value(tools),
        conversation_tokens=estimate_context_value(conversation),
        window_tokens=max(0, int(window_tokens)),
    )


@dataclass
class RequestAccounting:
    session_id: str
    settlement_mode: str = "gateway"
    credits_exhausted: bool = False
    terminal_call_allowed: bool = False
    settled_calls: int = 0
    resource_rates: dict[str, dict[str, Any]] | None = None
    job_attempt_id: int | None = None
    job_stage: str = ""


_accounting: contextvars.ContextVar[RequestAccounting | None] = contextvars.ContextVar(
    "chat_request_accounting", default=None
)


def bind(session_id: str) -> contextvars.Token[RequestAccounting | None]:
    if not session_id:
        raise AccountingError("spend session is required")
    if not cfg.gateway_url or not cfg.pipeline_secret:
        raise AccountingError("accounting callback is unavailable")
    return _accounting.set(RequestAccounting(session_id=session_id))


def bind_ingest(
    session_id: str,
    resource_rates: dict[str, dict[str, Any]],
    *,
    job_attempt_id: int | None = None,
    job_stage: str = "",
) -> contextvars.Token[RequestAccounting | None]:
    """Bind a post-paid ingest reservation for per-call local settlement."""
    if not session_id:
        raise AccountingError("ingest spend session is required")
    if not cfg.dsn:
        raise AccountingError("ingest provider accounting requires a database")
    return _accounting.set(
        RequestAccounting(
            session_id=session_id,
            settlement_mode="ingest",
            resource_rates=resource_rates,
            job_attempt_id=job_attempt_id,
            job_stage=job_stage,
        )
    )


def reset(token: contextvars.Token[RequestAccounting | None]) -> None:
    _accounting.reset(token)


def current() -> RequestAccounting | None:
    return _accounting.get()


def set_job_stage(stage: str) -> None:
    state = current()
    if state is not None and state.settlement_mode == "ingest":
        state.job_stage = stage[:80]


def new_call_id() -> str:
    return "pc_" + secrets.token_hex(10)


async def open_call(
    call_id: str,
    *,
    kind: str,
    purpose: str,
    thinking: str = "",
    context: ContextComposition | None = None,
) -> None:
    """Insert the pending row before the provider HTTP call.

    Unbound requests (ingest, offline tests) are a no-op. A bound request
    without a database cannot prove the stub exists, so it must not call the
    provider.
    """
    state = current()
    if state is None:
        return
    if not call_id:
        raise AccountingError("provider call id is required")
    if not cfg.dsn:
        raise AccountingError("provider call open requires a database")
    call_context = context or ContextComposition()
    arguments: tuple[Any, ...] = (
        state.session_id,
        call_id,
        kind,
        purpose,
        thinking,
        call_context,
    )
    if state.job_attempt_id is not None or state.job_stage:
        arguments += (state.job_attempt_id, state.job_stage)
    await asyncio.to_thread(_open_call_sync, *arguments)


async def abandon_call(call_id: str, exc: BaseException | None = None) -> None:
    """Mark an open stub that never produced usage. Best-effort."""
    state = current()
    if state is None or not call_id or not cfg.dsn:
        return
    try:
        await asyncio.to_thread(_abandon_call_sync, call_id, exc)
    except Exception:
        log.exception("failed to abandon provider call %s", call_id)


def _open_call_sync(
    session_id: str,
    call_id: str,
    kind: str,
    purpose: str,
    thinking: str,
    context: ContextComposition,
    job_attempt_id: int | None = None,
    job_stage: str = "",
) -> None:
    from ..store import db

    with db.connect() as conn:
        with conn.cursor() as cur:
            db.open_provider_call(
                cur,
                session_id,
                call_id,
                kind,
                purpose,
                thinking,
                job_attempt_id=job_attempt_id,
                job_stage=job_stage,
                context_system_tokens=context.system_tokens,
                context_tool_tokens=context.tool_tokens,
                context_conversation_tokens=context.conversation_tokens,
                context_total_tokens=context.total_tokens,
                context_window_tokens=context.window_tokens,
                context_counting_method=context.counting_method,
                context_counting_version=context.counting_version,
            )
        conn.commit()


def _abandon_call_sync(call_id: str, exc: BaseException | None) -> None:
    from ..store import db

    raw_status = getattr(exc, "status_code", None) if exc is not None else None
    provider_status = (
        raw_status if isinstance(raw_status, int) and 100 <= raw_status <= 599 else None
    )
    if provider_status is not None:
        category = "provider"
        code = f"provider_http_{provider_status}"
    elif exc is not None:
        category = "provider"
        code = (
            "provider_"
            + "".join(
                character.lower() if character.isalnum() else "_"
                for character in type(exc).__name__
            ).strip("_")[:60]
        )
    else:
        category = "provider"
        code = "provider_abandoned"
    with db.connect() as conn:
        with conn.cursor() as cur:
            db.abandon_provider_call(
                cur,
                call_id,
                error_category=category,
                error_code=code,
                provider_status=provider_status,
            )
        conn.commit()


async def settle(
    *,
    call_id: str,
    kind: str,
    purpose: str,
    thinking: str,
    spec: ModelConfig,
    usage: NormalizedUsage,
) -> RequestAccounting | None:
    state = current()
    if state is None:
        return None
    if state.settlement_mode == "ingest":
        await asyncio.to_thread(
            _settle_ingest_call_sync,
            state.session_id,
            call_id,
            kind,
            purpose,
            thinking,
            spec,
            usage,
            state.resource_rates or {},
        )
        state.settled_calls += 1
        return state
    payload = {
        "sessionId": state.session_id,
        "callId": call_id,
        "kind": kind,
        "purpose": purpose,
        "thinking": thinking,
        "provider": elitellm.transport_provider_slug(spec),
        "model": elitellm.transport_model_slug(spec),
        **usage.as_dict(),
    }
    response = await _post_settlement(payload)
    state.credits_exhausted = bool(response.get("creditsExhausted"))
    state.terminal_call_allowed = bool(response.get("terminalCallAllowed"))
    state.settled_calls += 1
    return state


async def settle_units(
    *,
    call_id: str,
    kind: str,
    purpose: str,
    provider: str,
    model: str,
    units: int,
    unit: str,
    credit_micros: int | None = None,
) -> RequestAccounting | None:
    """Settle a provider resource measured in non-token units."""
    state = current()
    if state is None:
        return None
    if units < 0 or not unit:
        raise AccountingError("provider units must be non-negative and named")
    if state.settlement_mode == "ingest":
        if credit_micros is None or credit_micros < 0:
            raise AccountingError("ingest unit settlement requires snapshotted credits")
        await asyncio.to_thread(
            _settle_ingest_units_sync,
            state.session_id,
            call_id,
            kind,
            purpose,
            provider,
            model,
            units,
            unit,
            credit_micros,
        )
        state.settled_calls += 1
        return state
    response = await _post_settlement(
        {
            "sessionId": state.session_id,
            "callId": call_id,
            "kind": kind,
            "purpose": purpose,
            "thinking": "",
            "provider": provider,
            "model": model,
            "units": units,
            "unit": unit,
        }
    )
    state.credits_exhausted = bool(response.get("creditsExhausted"))
    state.terminal_call_allowed = bool(response.get("terminalCallAllowed"))
    state.settled_calls += 1
    return state


def _settle_ingest_call_sync(
    session_id: str,
    call_id: str,
    kind: str,
    purpose: str,
    thinking: str,
    spec: ModelConfig,
    usage: NormalizedUsage,
    resource_rates: dict[str, dict[str, Any]],
) -> None:
    from .. import registry
    from ..store import db

    credit_micros = registry.credits_for_tokens(
        spec,
        kind,
        usage.input_tokens,
        usage.output_tokens,
        usage.cached_read_tokens,
    )
    if purpose == "image_caption":
        rate = resource_rates.get("figure_caption_call")
        if not isinstance(rate, dict) or "creditMicrosPerUnit" not in rate:
            raise AccountingError("ingest caption settlement has no rate snapshot")
        credit_micros += int(rate["creditMicrosPerUnit"])
    with db.connect() as conn:
        with conn.cursor() as cur:
            db.settle_ingest_provider_call(
                cur,
                session_id=session_id,
                call_id=call_id,
                kind=kind,
                purpose=purpose,
                thinking=thinking,
                provider=elitellm.transport_provider_slug(spec),
                model=elitellm.transport_model_slug(spec),
                catalog_provider_slug=spec.provider_slug,
                catalog_model_slug=spec.model_slug,
                model_version=spec.version,
                usage=usage,
                credit_micros=credit_micros,
            )
        conn.commit()


def _settle_ingest_units_sync(
    session_id: str,
    call_id: str,
    kind: str,
    purpose: str,
    provider: str,
    model: str,
    units: int,
    unit: str,
    credit_micros: int,
) -> None:
    from ..store import db

    with db.connect() as conn:
        with conn.cursor() as cur:
            db.settle_ingest_provider_call(
                cur,
                session_id=session_id,
                call_id=call_id,
                kind=kind,
                purpose=purpose,
                thinking="",
                provider=provider,
                model=model,
                catalog_provider_slug="",
                catalog_model_slug="",
                model_version=0,
                usage=NormalizedUsage(),
                credit_micros=credit_micros,
                units=units,
                unit=unit,
            )
        conn.commit()


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
                    raise AccountingError("accounting returned invalid JSON") from exc
                if not isinstance(body, dict):
                    raise AccountingError("accounting returned an invalid body")
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
    raise AccountingError(f"accounting failed: {last_error or 'unavailable'}")


def _response_detail(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    if not isinstance(body, dict):
        return ""
    return str(body.get("message") or body.get("code") or "")
