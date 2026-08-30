"""Request identity, structured logging, error reporting, and usage capture.

Three things live here because they are the same concern from different angles:
a request needs an id, that id needs to reach every log line and error report,
and the tokens the request spent need to be attributed back to it.

The trace id is W3C ``traceparent``, minted by the browser or the Go gateway
and forwarded on every hop. It is the join key between Sentry events, log
lines, and ``usage_events`` rows, which is why no service is allowed to invent
its own.
"""

from __future__ import annotations

import contextvars
import json
import logging
import os
import secrets
import sys
from dataclasses import dataclass, field
from typing import Any, ClassVar

log = logging.getLogger("evo.obs")

TRACEPARENT_HEADER = "traceparent"

_trace_id: contextvars.ContextVar[str] = contextvars.ContextVar("trace_id", default="")
_actor_user_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "actor_user_id", default=""
)


def new_trace_id() -> str:
    return secrets.token_hex(16)


def new_span_id() -> str:
    return secrets.token_hex(8)


def parse_traceparent(header: str | None) -> str:
    """Return the trace id from a W3C traceparent, or "" when unusable.

    A malformed header is treated as absent rather than salvaged: continuing a
    trace that does not exist upstream produces orphaned spans that are harder
    to debug than a fresh id.
    """
    if not header:
        return ""
    parts = header.strip().split("-")
    if len(parts) != 4 or parts[0] != "00":
        return ""
    trace_id = parts[1].lower()
    if len(trace_id) != 32 or trace_id == "0" * 32:
        return ""
    try:
        int(trace_id, 16)
    except ValueError:
        return ""
    return trace_id


def trace_id() -> str:
    return _trace_id.get()


def actor_user_id() -> str:
    return _actor_user_id.get()


def set_trace(trace: str, actor: str = "") -> None:
    _trace_id.set(trace or new_trace_id())
    if actor:
        _actor_user_id.set(actor)


def traceparent() -> str:
    """Render the current trace for a parser or gateway callback."""
    current = _trace_id.get()
    if not current:
        return ""
    return f"00-{current}-{new_span_id()}-01"


def outbound_headers() -> dict[str, str]:
    header = traceparent()
    return {TRACEPARENT_HEADER: header} if header else {}


# --------------------------------------------------------------------- logging


class _TraceFilter(logging.Filter):
    """Injects request identity so every record can carry it without the call
    sites having to pass it."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = _trace_id.get()
        record.user_id = _actor_user_id.get()
        return True


class _JSONFormatter(logging.Formatter):
    # Standard LogRecord attributes, excluded so only caller-supplied `extra`
    # fields end up in the payload.
    _SKIP: ClassVar[set[str]] = {
        "args",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "thread",
        "threadName",
        "taskName",
    }

    def __init__(self, service: str, app_env: str) -> None:
        super().__init__()
        self.service = service
        self.app_env = app_env

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "service": self.service,
            "env": self.app_env,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in self._SKIP and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["error"] = self.formatException(record.exc_info)
        # default=str so an unexpected object never turns a log call into a
        # crash inside the logging framework.
        return json.dumps(payload, default=str)


def init_logging(service: str) -> None:
    app_env = os.getenv("APP_ENV", "development")
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    text_format = os.getenv(
        "LOG_FORMAT", "text" if app_env == "development" else "json"
    )

    handler = logging.StreamHandler(sys.stdout)
    if text_format == "text":
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s [%(trace_id)s] %(message)s"
            )
        )
    else:
        handler.setFormatter(_JSONFormatter(service, app_env))
    handler.addFilter(_TraceFilter())

    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # Uvicorn installs its own handlers; let records propagate to ours instead
    # so access logs and application logs share one shape.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).handlers = []
        logging.getLogger(name).propagate = True


# ---------------------------------------------------------------------- sentry


def init_sentry(service: str) -> None:
    """Configure error reporting. A missing DSN disables it silently.

    Sentry's own distributed tracing is not enabled: the W3C trace id above is
    attached as a tag instead, so one identifier joins Sentry, the logs, and the
    usage ledger rather than having two that must be cross-referenced.
    """
    dsn = os.getenv("SENTRY_DSN", "")
    if not dsn:
        log.info("sentry disabled (no SENTRY_DSN)")
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.logging import LoggingIntegration
    except ImportError:
        log.warning("SENTRY_DSN set but sentry-sdk is not installed")
        return

    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("APP_ENV", "development"),
        release=os.getenv("RELEASE_SHA") or None,
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
        # Logs stay as breadcrumbs. capture_error is the only event path, so a
        # retryable provider 503 does not open a Sentry issue on its way to
        # being requeued.
        integrations=[LoggingIntegration(event_level=None)],
        # Prompts and note content flow through this service.
        send_default_pii=False,
    )
    sentry_sdk.set_tag("service", service)
    log.info("sentry enabled service=%s", service)


def capture_error(exc: BaseException, **tags: str) -> None:
    """Report a handled error that never reached a client as a 5xx."""
    log.exception("captured error", exc_info=exc)
    try:
        import sentry_sdk
    except ImportError:
        return
    with sentry_sdk.new_scope() as scope:
        scope.set_tag("trace_id", _trace_id.get())
        if _actor_user_id.get():
            scope.set_user({"id": _actor_user_id.get()})
        for key, value in tags.items():
            scope.set_tag(key, value)
        sentry_sdk.capture_exception(exc)


def bind_error_context() -> None:
    """Attach the current trace to whatever Sentry reports next."""
    try:
        import sentry_sdk
    except ImportError:
        return
    sentry_sdk.set_tag("trace_id", _trace_id.get())
    if _actor_user_id.get():
        sentry_sdk.set_user({"id": _actor_user_id.get()})


# ----------------------------------------------------------------------- usage


@dataclass
class Usage:
    """Token accounting for one request, aggregated across every provider call.

    One-shot routes send this aggregate to the gateway for settlement. Chat
    also keeps it for turn telemetry, while retrieval.accounting settles each
    provider call before the agent continues.
    """

    provider: str = ""
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    embed_tokens: int = 0
    calls: int = 0
    cached_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    cache_anomaly: str = ""
    # Per-model breakdown, kept for diagnosing which step in an agent loop is
    # actually expensive. Not used for billing.
    by_model: dict[str, dict[str, int]] = field(default_factory=dict)

    def add_completion(
        self,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        *,
        cached_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        reasoning_tokens: int = 0,
        cache_anomaly: str = "",
    ) -> None:
        self.provider = self.provider or provider
        self.model = self.model or model
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self.cached_read_tokens += cached_read_tokens
        self.cache_write_tokens += cache_write_tokens
        self.reasoning_tokens += reasoning_tokens
        if cache_anomaly and not self.cache_anomaly:
            self.cache_anomaly = cache_anomaly
        self.calls += 1
        bucket = self.by_model.setdefault(
            model, {"input": 0, "output": 0, "calls": 0, "cached": 0}
        )
        bucket["input"] += input_tokens
        bucket["output"] += output_tokens
        bucket["calls"] += 1
        bucket["cached"] += cached_read_tokens

    def add_embedding(self, provider: str, model: str, tokens: int) -> None:
        self.embed_tokens += tokens
        self.calls += 1
        bucket = self.by_model.setdefault(
            model, {"input": 0, "output": 0, "calls": 0, "cached": 0}
        )
        bucket["input"] += tokens
        bucket["calls"] += 1

    def as_dict(self) -> dict[str, Any]:
        """Wire shape consumed by the gateway. Keys match Go's pipeUsage."""
        payload: dict[str, Any] = {
            "provider": self.provider,
            "model": self.model,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "embedTokens": self.embed_tokens,
            "calls": self.calls,
        }
        if self.cached_read_tokens:
            payload["cachedReadTokens"] = self.cached_read_tokens
        if self.cache_write_tokens:
            payload["cacheWriteTokens"] = self.cache_write_tokens
        if self.reasoning_tokens:
            payload["reasoningTokens"] = self.reasoning_tokens
        if self.cache_anomaly:
            payload["cacheAnomaly"] = self.cache_anomaly
        return payload

    def is_empty(self) -> bool:
        return not (self.input_tokens or self.output_tokens or self.embed_tokens)


_usage: contextvars.ContextVar[Usage | None] = contextvars.ContextVar(
    "usage", default=None
)


@dataclass
class ParseUsage:
    """Measured work for one persistent-parser attempt.

    Page counts determine the charge. Every other field is operational
    telemetry: it can change capacity decisions, but never user billing.
    """

    pages: int = 0
    ocr_pages: int = 0
    cpu_milliseconds: int = 0
    elapsed_milliseconds: int = 0
    queue_milliseconds: int = 0
    download_milliseconds: int = 0
    upload_milliseconds: int = 0
    worker_rss_bytes: int = 0
    worker_pss_bytes: int = 0
    io_read_bytes: int = 0
    io_write_bytes: int = 0
    method: str = ""
    source_format: str = ""
    receipt_id: str = ""

    def is_empty(self) -> bool:
        return not (
            self.pages > 0 or self.cpu_milliseconds > 0 or self.elapsed_milliseconds > 0
        )


_parse_usage: contextvars.ContextVar[ParseUsage | None] = contextvars.ContextVar(
    "parse_usage", default=None
)


def start_usage() -> Usage:
    """Begin accumulating for the current request and return the accumulator."""
    usage = Usage()
    _usage.set(usage)
    _parse_usage.set(ParseUsage())
    return usage


def record_parse_usage(
    *,
    pages: int,
    ocr_pages: int,
    cpu_milliseconds: int,
    elapsed_milliseconds: int,
    queue_milliseconds: int = 0,
    download_milliseconds: int = 0,
    upload_milliseconds: int = 0,
    worker_rss_bytes: int = 0,
    worker_pss_bytes: int = 0,
    io_read_bytes: int = 0,
    io_write_bytes: int = 0,
    method: str = "",
    source_format: str = "",
    receipt_id: str = "",
) -> None:
    pages = max(0, int(pages))
    ocr_pages = min(pages, max(0, int(ocr_pages)))
    current = _parse_usage.get() or ParseUsage()
    _parse_usage.set(
        ParseUsage(
            pages=current.pages + pages,
            ocr_pages=current.ocr_pages + ocr_pages,
            cpu_milliseconds=current.cpu_milliseconds + max(0, int(cpu_milliseconds)),
            elapsed_milliseconds=current.elapsed_milliseconds
            + max(0, int(elapsed_milliseconds)),
            queue_milliseconds=current.queue_milliseconds
            + max(0, int(queue_milliseconds)),
            download_milliseconds=current.download_milliseconds
            + max(0, int(download_milliseconds)),
            upload_milliseconds=current.upload_milliseconds
            + max(0, int(upload_milliseconds)),
            worker_rss_bytes=max(
                current.worker_rss_bytes, max(0, int(worker_rss_bytes))
            ),
            worker_pss_bytes=max(
                current.worker_pss_bytes, max(0, int(worker_pss_bytes))
            ),
            io_read_bytes=current.io_read_bytes + max(0, int(io_read_bytes)),
            io_write_bytes=current.io_write_bytes + max(0, int(io_write_bytes)),
            method=method or current.method,
            source_format=source_format or current.source_format,
            receipt_id=receipt_id or current.receipt_id,
        )
    )


def take_parse_usage() -> ParseUsage:
    """Read and reset parse work, so one attempt cannot be charged twice."""
    value = _parse_usage.get() or ParseUsage()
    _parse_usage.set(ParseUsage())
    return value


def current_usage() -> Usage | None:
    return _usage.get()


def record_normalized(
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    *,
    cached_read_tokens: int = 0,
    cache_write_tokens: int = 0,
    reasoning_tokens: int = 0,
    cache_anomaly: str = "",
) -> None:
    usage = _usage.get()
    if usage is None:
        return
    usage.add_completion(
        provider,
        model,
        input_tokens,
        output_tokens,
        cached_read_tokens=cached_read_tokens,
        cache_write_tokens=cache_write_tokens,
        reasoning_tokens=reasoning_tokens,
        cache_anomaly=cache_anomaly,
    )


def record_completion(provider: str, model: str, response: Any) -> None:
    """Fold a provider response's usage block into the request accumulator.

    Providers are inconsistent about reporting usage and some omit it entirely,
    so a missing block is normal and must not raise: metering is never allowed
    to fail the request it is measuring.
    """
    usage = _usage.get()
    if usage is None:
        return
    block = getattr(response, "usage", None)
    if block is None and isinstance(response, dict):
        block = response.get("usage")
    if block is None:
        return
    from .retrieval.usage_extract import extract_usage

    parsed = extract_usage(block, provider=provider)
    usage.add_completion(
        provider,
        model,
        parsed.input_tokens,
        parsed.output_tokens,
        cached_read_tokens=parsed.cached_read_tokens,
        cache_write_tokens=parsed.cache_write_tokens,
        reasoning_tokens=parsed.reasoning_tokens,
        cache_anomaly=parsed.anomaly,
    )


def record_embedding(provider: str, model: str, response: Any) -> None:
    usage = _usage.get()
    if usage is None:
        return
    block = getattr(response, "usage", None)
    if block is None:
        return
    usage.add_embedding(provider, model, int(getattr(block, "prompt_tokens", 0) or 0))


def record_stream_chunk(provider: str, model: str, chunk: Any) -> None:
    """Fold the usage chunk that terminates a streamed completion.

    OpenAI-compatible streams only emit this when the request opted in with
    ``stream_options={"include_usage": True}``; without it a streamed answer
    reports nothing at all, which is how the highest-volume path ends up
    invisible.
    """
    usage = _usage.get()
    if usage is None:
        return
    block = getattr(chunk, "usage", None)
    if block is None and isinstance(chunk, dict):
        block = chunk.get("usage")
    if block is None:
        return
    from .retrieval.usage_extract import extract_usage

    parsed = extract_usage(block, provider=provider)
    usage.add_completion(
        provider,
        model,
        parsed.input_tokens,
        parsed.output_tokens,
        cached_read_tokens=parsed.cached_read_tokens,
        cache_write_tokens=parsed.cache_write_tokens,
        reasoning_tokens=parsed.reasoning_tokens,
        cache_anomaly=parsed.anomaly,
    )
