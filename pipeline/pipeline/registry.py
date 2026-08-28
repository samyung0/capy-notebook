"""Hot-reloadable model registry, mirrored from server/internal/models.

Rows are immutable and versioned. The cache never evicts a
``(provider_slug, model_slug, version)`` pin. Polling ``model_registry_state``
only teaches this process the current defaults.

Two rules keep a resolved model from drifting away from the one that was priced:

* A cache miss never falls back to the current default.
* :func:`resolve_pinned` requires an exact pin for **every** surface. Nothing
  that can bill, and nothing that writes a vector, is allowed to pick a model
  for itself; the caller that reserved the spend, enqueued the job or created
  the workspace already chose one. ``registry.default`` remains for the
  caller whose job it is to choose (ingest enqueue in the gateway).
"""

from __future__ import annotations

import logging
import threading
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from .generated import Surface
from .store import db

log = logging.getLogger("evo.registry")

POLL_INTERVAL = 600.0

AUTH_PLATFORM = "platform"
AUTH_USER_KEY = "user_key"
AUTH_PLATFORM_OR_USER = "platform_or_user"


def join_model_label(provider_name: str, model_name: str) -> str:
    provider = (provider_name or "").strip()
    model = (model_name or "").strip()
    if not provider:
        return model
    if not model:
        return provider
    return f"{provider} {model}"


@dataclass(frozen=True)
class ModelConfig:
    version: int
    provider_name: str
    model_name: str
    provider_slug: str
    model_slug: str
    platform_enabled: bool = True
    byok_enabled: bool = False
    params: dict[str, Any] = field(default_factory=dict)
    surfaces: tuple[Surface, ...] = ()
    thinking_levels: tuple[str, ...] = ()
    default_thinking: str = ""
    micros_per_input_token: int = 0
    micros_per_output_token: int = 0
    micros_per_cached_input_token: int = 0
    enabled: bool = True
    is_default_for: tuple[Surface, ...] = ()
    context_window_tokens: int = 0

    @property
    def auth_mode(self) -> str:
        if self.platform_enabled and self.byok_enabled:
            return AUTH_PLATFORM_OR_USER
        if self.byok_enabled:
            return AUTH_USER_KEY
        return AUTH_PLATFORM

    @property
    def litellm_model_id(self) -> str:
        return self.model_slug

    def resolve_thinking(self, stored: str) -> str:
        if not stored:
            if self.default_thinking in self.thinking_levels:
                return self.default_thinking
            raise RegistryError(
                f"model {self.provider_slug}/{self.model_slug} has no valid "
                "default thinking"
            )
        if stored in self.thinking_levels:
            return stored
        raise RegistryError(
            f"model {self.provider_slug}/{self.model_slug} does not support "
            f"thinking {stored!r}"
        )

    @property
    def pin(self) -> tuple[str, str, int]:
        return (self.provider_slug, self.model_slug, self.version)

    def allows(self, surface: Surface) -> bool:
        return surface in self.surfaces

    @property
    def embedding_dim(self) -> int:
        """Width this model emits, which selects the vector table it writes to.

        Required on every embedding row by a check constraint in the migration,
        so a missing value means the row was written around the schema.
        """
        raw = self.params.get("dimensions")
        if raw is None:
            raise RegistryError(
                f"embedding model {self.provider_slug}/{self.model_slug} "
                f"v{self.version} declares no "
                "dimensions"
            )
        return int(raw)

    def temperature(self, fallback: float = 0.3) -> float:
        raw = self.params.get("temperature", fallback)
        try:
            return float(raw)
        except (TypeError, ValueError):
            return fallback

    def api_mode(self) -> str:
        return "chat_completion"

    @property
    def display_name(self) -> str:
        return join_model_label(self.provider_name, self.model_name)


class RegistryError(RuntimeError):
    """An exact provider/model/version pin could not be loaded."""


@dataclass
class JobPins:
    ingest: ModelConfig | None = None
    embedding: ModelConfig | None = None
    vision: ModelConfig | None = None


_job_pins: ContextVar[JobPins | None] = ContextVar("job_pins", default=None)

_select_cols = """
                    SELECT version, provider_name, model_name, provider_slug,
                           model_slug, platform_enabled, byok_enabled,
                           params, surfaces, thinking_levels, default_thinking,
                           micros_per_input_token, micros_per_output_token,
                           enabled, is_default_for, context_window_tokens,
                           micros_per_cached_input_token
                      FROM model_configs
"""


@dataclass
class RequestLLM:
    user_id: str = ""
    paid_by: str = ""
    user_api_key: str = ""
    thinking: str = ""


_request_llm: ContextVar[RequestLLM | None] = ContextVar("request_llm", default=None)


def bind_request_llm(
    user_id: str | None = None,
    paid_by: str | None = None,
    thinking: str | None = None,
    *,
    user_api_key: str | None = None,
) -> None:
    _request_llm.set(
        RequestLLM(
            user_id=(user_id or "").strip(),
            paid_by=(paid_by or "").strip(),
            user_api_key=(user_api_key or "").strip(),
            thinking=(thinking or "").strip(),
        )
    )


def current_request_llm() -> RequestLLM:
    return _request_llm.get() or RequestLLM()


def set_job_pins(pins: JobPins | None) -> None:
    _job_pins.set(pins)


def current_job_pins() -> JobPins | None:
    return _job_pins.get()


class Registry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_pin: dict[tuple[str, str, int], ModelConfig] = {}
        self._current: dict[str, tuple[str, str, int]] = {}
        self._rev: int = -1
        self._started = False

    def start(self) -> None:
        # There is deliberately no process-start snapshot of the embedding or
        # vision default any more. Freezing them was how this process used to
        # avoid mixing vector spaces, which made the model a query embedded with
        # a function of when the container last booted. Embedding now comes from
        # the workspace embedding pin and vision from the job pin, so there
        # is nothing left for a poll to corrupt.
        self.refresh()
        with self._lock:
            self._started = True

    def refresh(self) -> None:
        try:
            with db.connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT version FROM model_registry_state WHERE id = true")
                row = cur.fetchone()
                rev = int(row[0]) if row else 0
                with self._lock:
                    if self._rev == rev and self._current:
                        return
                cur.execute(_select_cols)
                rows = cur.fetchall()
        except Exception:  # noqa: BLE001 - retain the last successfully loaded catalog
            if not self._started:
                log.warning("model registry unavailable; no catalog loaded")
            return

        by_pin: dict[tuple[str, str, int], ModelConfig] = {}
        current: dict[str, tuple[str, str, int]] = {}
        for row in rows:
            spec = _from_row(row)
            by_pin[spec.pin] = spec
            if not spec.enabled:
                continue
            for surface in spec.is_default_for:
                prev = current.get(surface)
                if prev is None or spec.version >= prev[2]:
                    current[surface] = spec.pin

        with self._lock:
            self._by_pin.update(by_pin)
            self._current.update(current)
            self._rev = rev

    def get(self, provider_slug: str, model_slug: str, version: int) -> ModelConfig:
        if not provider_slug or not model_slug or version <= 0:
            raise RegistryError(
                f"invalid pin {provider_slug!r}/{model_slug!r} v{version}"
            )
        pin = (provider_slug, model_slug, version)
        with self._lock:
            cached = self._by_pin.get(pin)
        if cached is not None:
            return cached
        spec = self._load(provider_slug, model_slug, version)
        with self._lock:
            self._by_pin[pin] = spec
        return spec

    def _load(self, provider_slug: str, model_slug: str, version: int) -> ModelConfig:
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                _select_cols
                + " WHERE provider_slug=%s AND model_slug=%s AND version=%s",
                (provider_slug, model_slug, version),
            )
            row = cur.fetchone()
        if not row:
            raise RegistryError(
                f"model config not found: {provider_slug}/{model_slug} v{version}"
            )
        return _from_row(row)

    def default_pin(self, surface: Surface) -> tuple[str, str, int]:
        with self._lock:
            pin = self._current.get(surface)
        if not pin:
            raise RegistryError(f"no default for {surface}")
        return pin

    def default(self, surface: Surface) -> ModelConfig:
        provider_slug, model_slug, version = self.default_pin(surface)
        return self.get(provider_slug, model_slug, version)

    def resolve_user(
        self, provider_slug: str | None, model_slug: str | None, surface: Surface
    ) -> ModelConfig:
        if not provider_slug or not model_slug:
            raise RegistryError(f"empty preference for {surface}")
        return self._latest_enabled(provider_slug, model_slug, surface)

    def _latest_enabled(
        self, provider_slug: str, model_slug: str, surface: Surface
    ) -> ModelConfig:
        with self._lock:
            best: ModelConfig | None = None
            for spec in self._by_pin.values():
                if (
                    spec.provider_slug == provider_slug
                    and spec.model_slug == model_slug
                    and spec.enabled
                    and spec.allows(surface)
                    and (best is None or spec.version > best.version)
                ):
                    best = spec
        if best is not None:
            return best
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                _select_cols
                + """
                 WHERE provider_slug=%s AND model_slug=%s
                   AND enabled AND %s = ANY(surfaces)
                 ORDER BY version DESC LIMIT 1
                """,
                (provider_slug, model_slug, surface),
            )
            row = cur.fetchone()
        if not row:
            raise RegistryError(
                f"no enabled {provider_slug}/{model_slug} for {surface}"
            )
        spec = _from_row(row)
        with self._lock:
            self._by_pin[spec.pin] = spec
        return spec


def _cached_rate_from_row(row: tuple[Any, ...]) -> int:
    if len(row) <= 16 or row[16] is None:
        raise RegistryError(
            f"{row[3]}/{row[4]} v{row[0]} is missing micros_per_cached_input_token"
        )
    return int(row[16])


def _as_dict(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def _from_row(row: tuple[Any, ...]) -> ModelConfig:
    params = _as_dict(row[7])
    surfaces = tuple(Surface(value) for value in (row[8] or ()))
    thinking = tuple(row[9] or ())
    defaults = tuple(Surface(value) for value in (row[14] or ()))
    window = int(row[15]) if row[15] is not None else 0
    return ModelConfig(
        version=int(row[0]),
        provider_name=str(row[1] or ""),
        model_name=str(row[2] or ""),
        provider_slug=row[3],
        model_slug=str(row[4] or ""),
        platform_enabled=bool(row[5]),
        byok_enabled=bool(row[6]),
        params=params,
        surfaces=surfaces,
        thinking_levels=thinking,
        default_thinking=str(row[10] or ""),
        micros_per_input_token=int(row[11]),
        micros_per_output_token=int(row[12]),
        enabled=bool(row[13]),
        is_default_for=defaults,
        context_window_tokens=window,
        micros_per_cached_input_token=_cached_rate_from_row(row),
    )


registry = Registry()


def resolve_pinned(
    provider_slug: str | None,
    model_slug: str | None,
    version: int | None,
    surface: Surface,
) -> ModelConfig:
    """Load an exact pin, for every surface without exception.

    A missing or unresolvable pin is an error, never the live default. Whoever
    is downstream of this call is about to spend money against a price somebody
    else already quoted (the gateway's reservation, the job payload) or to write
    a vector into a space somebody else already chose (the workspace). Resolving
    a default here would run a different model than the one that was priced, and
    nothing would say so.
    """
    if not provider_slug or not model_slug or not version:
        raise RegistryError(f"missing pin for {surface}")
    return registry.get(provider_slug, model_slug, int(version))


def ingest_spec() -> ModelConfig:
    """The ingest LLM this job was enqueued with."""
    pins = current_job_pins()
    if pins is None or pins.ingest is None:
        raise RegistryError("no ingest pin on this job")
    return pins.ingest


def embedding_spec() -> ModelConfig:
    """The embedding model of the workspace this job belongs to.

    Installed by the worker from the workspace embedding pin before any
    indexing runs. Query-time embedding has no job and therefore does not come
    through here — see ``retrieval.search``.
    """
    pins = current_job_pins()
    if pins is None or pins.embedding is None:
        raise RegistryError("no embedding pin on this job")
    return pins.embedding


def vision_spec() -> ModelConfig:
    """The vision model this job was enqueued with."""
    pins = current_job_pins()
    if pins is None or pins.vision is None:
        raise RegistryError("no vision pin on this job")
    return pins.vision


def provider_api_key_for(spec: ModelConfig) -> str:
    """Return the key elitellm should use for this pin.

    User keys are passed per request and never written to process env.
    Platform keys come from the elitellm provider env name.
    """
    from .elitellm.providers import platform_api_key as elitellm_platform_key
    from .elitellm.providers import platform_env_name

    req = current_request_llm()
    if req.paid_by == "user":
        key = req.user_api_key or _load_user_key(req.user_id, spec.provider_slug)
        if not key or not spec.byok_enabled:
            raise RegistryError(
                f"user key required for {spec.provider_slug}/{spec.model_slug}"
            )
        return key
    if req.user_api_key and spec.byok_enabled and not spec.platform_enabled:
        return req.user_api_key
    if spec.byok_enabled and not spec.platform_enabled:
        raise RegistryError(
            f"user key required for {spec.provider_slug}/{spec.model_slug}"
        )
    try:
        env_name = platform_env_name(spec.provider_slug)
        key = elitellm_platform_key(spec.provider_slug)
    except KeyError as exc:
        raise RegistryError(f"unknown elitellm provider {spec.provider_slug}") from exc
    if not key:
        raise RegistryError(
            f"missing {env_name} for {spec.provider_slug}/{spec.model_slug}"
        )
    return key


def _load_user_key(user_id: str, provider_slug: str) -> str:
    if not user_id or not provider_slug:
        return ""
    from . import credentials

    key = credentials.decrypt_user_provider_key(user_id, provider_slug)
    req = current_request_llm()
    req.user_api_key = key
    return key


def context_window(spec: ModelConfig) -> int:
    if spec.context_window_tokens <= 0:
        raise RegistryError(
            f"model {spec.provider_slug}/{spec.model_slug} requires a positive "
            "context window"
        )
    return spec.context_window_tokens


def input_budget(spec: ModelConfig) -> int:
    return max(4000, context_window(spec) - 8192)


def credits_for_tokens(
    spec: ModelConfig,
    kind: str,
    input_tokens: int,
    output_tokens: int,
    cached_read_tokens: int = 0,
) -> int:
    cached = cached_read_tokens
    if cached < 0 or cached > input_tokens:
        cached = 0
    uncached = input_tokens - cached
    if kind == "embedding":
        return (
            input_tokens * spec.micros_per_input_token
            + output_tokens * spec.micros_per_input_token
        )
    return (
        uncached * spec.micros_per_input_token
        + cached * spec.micros_per_cached_input_token
        + output_tokens * spec.micros_per_output_token
    )


def poll_forever() -> None:
    while True:
        time.sleep(POLL_INTERVAL)
        try:
            registry.refresh()
        except Exception:
            log.exception("model registry poll failed")


def pins_from_payload(payload: dict[str, Any], *, embedding: ModelConfig) -> JobPins:
    """Resolve the models one ingest job is allowed to use.

    The ingest LLM and the vision model are snapshotted onto the payload at
    enqueue, because their surface defaults are hot-reloadable and the job may
    run long after the upload returned. ``embedding`` is not on the payload: it
    belongs to the workspace for the lifetime of that workspace, so the worker
    passes in the pin it read from the workspace row.

    Raises rather than returning a partial set. A job that cannot say which
    model it was priced for must not run.
    """

    def load(prefix: str, surface: Surface) -> ModelConfig:
        return resolve_pinned(
            payload.get(f"{prefix}ProviderSlug"),
            payload.get(f"{prefix}ModelSlug"),
            payload.get(f"{prefix}ModelVersion"),
            surface,
        )

    return JobPins(
        ingest=load("ingest", Surface.INGEST),
        embedding=embedding,
        vision=load("vision", Surface.VISION),
    )
