"""Per-provider-call accounting for a spend session.

The Go gateway owns credit policy and concurrent turn admission. A request
binds the gateway's spend-session id here so every provider call can open a
pending row, then settle measured usage, before the next call is chosen.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import json
import logging
import math
import random
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import requests

from .. import elitellm, obs, registry
from ..config import cfg
from ..registry import ModelConfig
from .usage_extract import NormalizedUsage

log = logging.getLogger("capy.accounting")

KIND_LLM = "llm"
KIND_EMBEDDING = "embedding"
KIND_AUDIO = "audio"

PURPOSE_AGENT = "agent"
PURPOSE_TERMINAL = "terminal"
PURPOSE_LIVE_COMPACTION = "live_compaction"
PURPOSE_CHECKPOINT = "checkpoint"

_SETTLE_ATTEMPTS = 4
_SETTLE_TIMEOUT_S = 10
_RECEIPT_SETTLEMENT_GRACE_S = 300
# Suggested client wait when the model's gate never opened within the budget.
BUSY_RETRY_AFTER_S = 5.0
CONTEXT_COUNTING_METHOD = "provider_shape_cjk_chars_latin_chars_div3"
CONTEXT_COUNTING_VERSION = 2


class AccountingError(RuntimeError):
    pass


class SettlementError(AccountingError):
    """A provider receipt exists but could not be applied to Capy Notebook's ledger."""


def provider_status(exc: BaseException | None) -> int | None:
    """Find a definitive HTTP response across mapped exception causes."""
    seen: set[int] = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        raw = getattr(current, "status_code", None)
        response = getattr(current, "response", None)
        if raw is None and response is not None:
            raw = getattr(response, "status_code", None)
        if isinstance(raw, int) and 100 <= raw <= 599:
            return raw
        current = current.__cause__ or current.__context__
    return None


def definitive_provider_failure(exc: BaseException) -> bool:
    """True only when the provider answered with a failed HTTP response."""
    return provider_status(exc) is not None or bool(
        getattr(exc, "provider_not_called", False)
    )


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
    receipt_deadlines: dict[str, float] = field(default_factory=dict)
    # Calls holding a per-model capacity lease, released when the call ends.
    leased_calls: set[str] = field(default_factory=set)


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


def model_capacity(
    provider: str, model: str, settlement_mode: str
) -> tuple[str, int] | None:
    """Gate key and capacity for one platform-key call; None when ungated.

    Interactive callers may use the model's whole total. Ingest callers stop at
    total minus the interactive reserve, so a chat search never queues behind a
    wave of captions. A user's own key answers to that user's provider limits
    and is never gated here.
    """
    if registry.current_request_llm().paid_by == "user":
        return None
    limits = cfg.model_concurrency.get((provider, model))
    if limits is None:
        return None
    total, reserve = limits
    capacity = total - reserve if settlement_mode == "ingest" else total
    return f"{provider}:{model}", max(0, capacity)


def _gate_poll_s(settlement_mode: str) -> float:
    if settlement_mode == "ingest":
        return random.uniform(1.0, 2.0)
    return random.uniform(0.1, 0.3)


async def open_call(
    call_id: str,
    *,
    kind: str,
    purpose: str,
    thinking: str = "",
    context: ContextComposition | None = None,
    spec: ModelConfig | None = None,
    provider: str = "",
    model: str = "",
    deadline: float | None = None,
) -> None:
    """Insert the pending row before the provider HTTP call.

    Unbound requests (offline tests) are a no-op. A bound request without a
    database cannot prove the stub exists, so it must not call the provider.
    A gated model takes its capacity lease in the same transaction as the row;
    while the gate is full this polls until ``deadline`` (a monotonic instant)
    and then raises ProviderBusy without inserting anything.
    """
    state = current()
    if state is None:
        return
    if not call_id:
        raise AccountingError("provider call id is required")
    if not cfg.dsn:
        raise AccountingError("provider call open requires a database")
    call_context = context or ContextComposition()
    if spec is not None:
        provider = provider or elitellm.transport_provider_slug(spec)
        model = model or elitellm.transport_model_slug(spec)
    if kind == KIND_AUDIO:
        provider_timeout_s = cfg.elevenlabs_sync_timeout_s
    elif state.settlement_mode == "ingest":
        provider_timeout_s = cfg.ingest_provider_timeout_s
    else:
        # Interactive streams are bounded by the backstop, not the idle timer.
        provider_timeout_s = cfg.interactive_stream_max_s
    receipt_timeout_s = (
        max(1, math.ceil(provider_timeout_s)) + _RECEIPT_SETTLEMENT_GRACE_S
    )
    lease = (
        model_capacity(provider, model, state.settlement_mode)
        if spec is not None
        else None
    )
    while True:
        admission = asyncio.ensure_future(
            asyncio.to_thread(
                _open_call_sync,
                state.session_id,
                call_id,
                kind,
                purpose,
                thinking,
                call_context,
                receipt_timeout_s,
                provider,
                model,
                lease,
                state.job_attempt_id,
                state.job_stage,
            )
        )
        try:
            admitted = await asyncio.shield(admission)
        except asyncio.CancelledError:
            # The thread cannot be cancelled and may still commit the lease and
            # the row. Undo whatever it commits once it finishes, without
            # holding the cancellation up; the receipt window is the backstop.
            admission.add_done_callback(functools.partial(_undo_admission, call_id))
            raise
        if admitted:
            break
        wait = _gate_poll_s(state.settlement_mode)
        if deadline is None or time.monotonic() + wait > deadline:
            raise elitellm.ProviderBusy(
                f"{provider}/{model} is at its concurrency cap",
                retry_after=BUSY_RETRY_AFTER_S,
            )
        await asyncio.sleep(wait)
    if lease is not None:
        state.leased_calls.add(call_id)
    state.receipt_deadlines[call_id] = time.monotonic() + receipt_timeout_s


# Detached cleanup tasks, referenced so the loop cannot collect them early.
_background: set[asyncio.Task[Any]] = set()


def _undo_admission(call_id: str, admission: asyncio.Future[bool]) -> None:
    """Done-callback for an admission whose request was cancelled.

    Best effort: if the loop is already tearing down and the undo cannot be
    scheduled, the lease expires with the receipt window and the row is
    swept as ``receipt_timeout``.
    """
    try:
        if (
            admission.cancelled()
            or admission.exception() is not None
            or not admission.result()
        ):
            return
        task = asyncio.ensure_future(asyncio.to_thread(_undo_admission_sync, call_id))
    except Exception:
        log.warning("could not undo cancelled admission %s", call_id, exc_info=True)
        return
    _background.add(task)
    task.add_done_callback(_finish_background)


def _finish_background(task: asyncio.Task[Any]) -> None:
    _background.discard(task)
    if not task.cancelled() and task.exception() is not None:
        log.warning("cancelled admission undo failed", exc_info=task.exception())


def _undo_admission_sync(call_id: str) -> None:
    """Abandon the never-sent call row and free its lease in one transaction."""
    from ..store import db

    with db.connect() as conn:
        with conn.cursor() as cur:
            db.abandon_provider_call(
                cur,
                call_id,
                error_category="client",
                error_code="cancelled_before_send",
            )
            db.release_provider_capacity(cur, call_id)
        conn.commit()


async def release_call(call_id: str) -> None:
    """Free the call's capacity lease once the provider is done. Best effort.

    A lease that cannot be released expires with the receipt window.
    """
    state = current()
    if state is None or call_id not in state.leased_calls:
        return
    state.leased_calls.discard(call_id)
    try:
        await asyncio.to_thread(_release_lease_sync, call_id)
    except Exception:
        log.warning("could not release capacity lease %s", call_id, exc_info=True)


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
    receipt_timeout_s: int,
    provider: str = "",
    model: str = "",
    lease: tuple[str, int] | None = None,
    job_attempt_id: int | None = None,
    job_stage: str = "",
) -> bool:
    """Take the capacity lease and insert the row atomically. False when full."""
    from ..store import db

    with db.connect() as conn:
        with conn.cursor() as cur:
            if lease is not None:
                # Unlocked look first: a full gate returns without touching
                # the session or call rows, and without the model-wide lock.
                key, capacity = lease
                if db.provider_capacity_used(cur, key) >= capacity:
                    conn.rollback()
                    return False
            db.open_provider_call(
                cur,
                session_id,
                call_id,
                kind,
                purpose,
                thinking,
                job_attempt_id=job_attempt_id,
                job_stage=job_stage,
                provider=provider,
                model=model,
                context_system_tokens=context.system_tokens,
                context_tool_tokens=context.tool_tokens,
                context_conversation_tokens=context.conversation_tokens,
                context_total_tokens=context.total_tokens,
                context_window_tokens=context.window_tokens,
                context_counting_method=context.counting_method,
                context_counting_version=context.counting_version,
                receipt_timeout_seconds=receipt_timeout_s,
            )
            if lease is not None:
                # Last, so the model-wide advisory lock covers only the
                # delete, sum and insert, never the row locks above.
                key, capacity = lease
                admitted = db.acquire_provider_capacity(
                    cur,
                    lease_id=call_id,
                    provider=key,
                    units=1,
                    capacity=capacity,
                    lease_seconds=receipt_timeout_s,
                )
                if not admitted:
                    conn.rollback()
                    return False
        conn.commit()
    return True


def _release_lease_sync(call_id: str) -> None:
    from ..store import db

    with db.connect() as conn:
        with conn.cursor() as cur:
            db.release_provider_capacity(cur, call_id)
        conn.commit()


def _abandon_call_sync(call_id: str, exc: BaseException | None) -> None:
    from ..store import db

    response_status = provider_status(exc)
    if response_status is not None:
        category = "provider"
        code = f"provider_http_{response_status}"
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
                provider_status=response_status,
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
        await _finish_known_receipt(
            _retry_local_settlement(
                _settle_ingest_call_sync,
                state.session_id,
                call_id,
                kind,
                purpose,
                thinking,
                spec,
                usage,
                state.resource_rates or {},
                deadline=state.receipt_deadlines.get(call_id),
            )
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
    deadline = state.receipt_deadlines.get(call_id)
    response = await _finish_known_receipt(
        _post_settlement(payload, deadline=deadline)
        if deadline is not None
        else _post_settlement(payload)
    )
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
        await _finish_known_receipt(
            _retry_local_settlement(
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
                deadline=state.receipt_deadlines.get(call_id),
            )
        )
        state.settled_calls += 1
        return state
    payload = {
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
    deadline = state.receipt_deadlines.get(call_id)
    response = await _finish_known_receipt(
        _post_settlement(payload, deadline=deadline)
        if deadline is not None
        else _post_settlement(payload)
    )
    state.credits_exhausted = bool(response.get("creditsExhausted"))
    state.terminal_call_allowed = bool(response.get("terminalCallAllowed"))
    state.settled_calls += 1
    return state


async def settle_ingest_units_for_session(
    *,
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
    """Recover a pending artifact against the call's original reservation."""
    if not cfg.dsn:
        raise AccountingError("ingest unit recovery requires a database")
    if not session_id or not call_id:
        raise AccountingError("ingest unit recovery requires session and call ids")
    await _retry_local_settlement(
        _settle_ingest_units_sync,
        session_id,
        call_id,
        kind,
        purpose,
        provider,
        model,
        units,
        unit,
        credit_micros,
        deadline=None,
    )


async def _retry_local_settlement(
    function: Any,
    *args: Any,
    deadline: float | None,
) -> None:
    """Keep the exact in-memory receipt until it applies or its window closes."""
    attempt = 0
    while True:
        try:
            await asyncio.to_thread(function, *args)
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            attempt += 1
            if type(exc).__name__ == "ProviderReceiptExpired":
                raise SettlementError("provider receipt deadline elapsed") from exc
            if not _transient_local_settlement_error(exc):
                raise SettlementError("provider receipt settlement rejected") from exc
            if deadline is None:
                if attempt >= _SETTLE_ATTEMPTS:
                    raise SettlementError("provider receipt settlement failed") from exc
            elif time.monotonic() >= deadline:
                raise SettlementError(
                    "provider receipt settlement deadline elapsed"
                ) from exc
            delay = min(5.0, 0.25 * (2 ** min(attempt - 1, 5)))
            if deadline is not None:
                delay = min(delay, max(0.0, deadline - time.monotonic()))
            if delay <= 0:
                raise SettlementError(
                    "provider receipt settlement deadline elapsed"
                ) from exc
            await asyncio.sleep(delay)


async def _finish_known_receipt(awaitable: Any) -> Any:
    """Do not discard measured provider usage when the requester disconnects."""
    task = asyncio.create_task(awaitable)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # The provider response is already known. Keep the exact receipt alive
        # through its settlement deadline, then preserve caller cancellation.
        try:
            await task
        except Exception:
            log.exception("provider receipt could not be settled after cancellation")
        raise


def _transient_local_settlement_error(exc: BaseException) -> bool:
    """Retry only database availability/serialization outcomes that can heal."""
    sqlstate = getattr(exc, "sqlstate", None)
    if isinstance(sqlstate, str) and (
        sqlstate.startswith("08")
        or sqlstate in {"40001", "40P01", "53300", "57P01", "57P02", "57P03"}
    ):
        return True
    return type(exc).__name__ in {
        "ConnectionTimeout",
        "InterfaceError",
        "OperationalError",
        "PoolTimeout",
    }


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
            result = db.settle_ingest_provider_call(
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
        if result == "expired":
            raise db.ProviderReceiptExpired("provider receipt deadline elapsed")


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
            result = db.settle_ingest_provider_call(
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
        if result == "expired":
            raise db.ProviderReceiptExpired("provider receipt deadline elapsed")


async def _post_settlement(
    payload: dict[str, Any], *, deadline: float | None = None
) -> dict[str, Any]:
    url = cfg.gateway_url.rstrip("/") + "/api/internal/provider-calls"
    headers = {
        "Content-Type": "application/json",
        "X-Pipeline-Secret": cfg.pipeline_secret,
        **obs.outbound_headers(),
    }
    last_error = ""
    attempt = 0
    while True:
        retryable = True
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
                    raise SettlementError("accounting returned invalid JSON") from exc
                if not isinstance(body, dict):
                    raise SettlementError("accounting returned an invalid body")
                return body
            last_error = _response_detail(response) or str(response.status_code)
            if response.status_code < 500 and response.status_code != 429:
                retryable = False
        except (requests.Timeout, requests.ConnectionError) as exc:
            last_error = str(exc)
        except requests.RequestException as exc:
            last_error = str(exc)
            retryable = False
        attempt += 1
        if not retryable:
            raise SettlementError(f"accounting failed: {last_error or 'unavailable'}")
        if deadline is None:
            if attempt >= _SETTLE_ATTEMPTS:
                raise SettlementError(
                    f"accounting failed: {last_error or 'unavailable'}"
                )
        elif time.monotonic() >= deadline:
            raise SettlementError(
                f"accounting failed before receipt deadline: {last_error or 'unavailable'}"
            )
        delay = min(5.0, 0.25 * (2 ** min(attempt - 1, 5)))
        if deadline is not None:
            delay = min(delay, max(0.0, deadline - time.monotonic()))
        if delay <= 0:
            raise SettlementError(
                f"accounting failed before receipt deadline: {last_error or 'unavailable'}"
            )
        await asyncio.sleep(delay)


def _response_detail(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    if not isinstance(body, dict):
        return ""
    return str(body.get("message") or body.get("code") or "")
