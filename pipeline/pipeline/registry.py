"""Hot-reloadable model registry, mirrored from server/internal/models.

Rows are immutable and versioned. The cache never evicts a (model_key, version)
pair. Polling ``model_registry_state`` only teaches this process the current
defaults; a pinned pair it has never seen is a point read of the table.

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

from .config import ProviderCfg, cfg
from .store import db

log = logging.getLogger("evo.registry")

POLL_INTERVAL = 30.0

SURFACE_CHAT = "chat"
SURFACE_GENERATE = "generate"
SURFACE_EDITOR = "editor"
SURFACE_QUIZ = "quiz"
SURFACE_INGEST = "ingest"
SURFACE_EMBEDDING = "embedding"
SURFACE_VISION = "vision"


AUTH_PLATFORM = "platform"
AUTH_USER_KEY = "user_key"
AUTH_PLATFORM_OR_USER = "platform_or_user"


@dataclass(frozen=True)
class ModelConfig:
    model_key: str
    version: int
    display_name: str
    provider_slug: str
    base_url: str
    provider_model_id: str
    params: dict[str, Any] = field(default_factory=dict)
    surfaces: tuple[str, ...] = ()
    micros_per_input_token: int = 0
    micros_per_output_token: int = 0
    enabled: bool = True
    is_default_for: tuple[str, ...] = ()
    auth_mode: str = AUTH_PLATFORM
    context_window_tokens: int = 0

    @property
    def pin(self) -> tuple[str, int]:
        return (self.model_key, self.version)

    def allows(self, surface: str) -> bool:
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
                f"embedding model {self.model_key} v{self.version} declares no "
                "dimensions"
            )
        return int(raw)

    def temperature(self, fallback: float = 0.3) -> float:
        raw = self.params.get("temperature", fallback)
        try:
            return float(raw)
        except (TypeError, ValueError):
            return fallback

    def reasoning(self) -> dict[str, Any]:
        raw = self.params.get("reasoning")
        return raw if isinstance(raw, dict) else {}

    def reasoning_style(self) -> str:
        return str(self.reasoning().get("style") or "")

    def reasoning_efforts(self) -> tuple[str, ...]:
        raw = self.reasoning().get("efforts") or ()
        return tuple(str(item) for item in raw if item)

    def reasoning_can_disable(self) -> bool:
        return bool(self.reasoning().get("canDisable", True))

    def reasoning_default_mode(self) -> str:
        return str(self.reasoning().get("defaultMode") or "off")

    def reasoning_default_effort(self) -> str:
        return str(self.reasoning().get("defaultEffort") or "medium")


class RegistryError(RuntimeError):
    """A pinned (model_key, version) could not be loaded. Never a silent default."""


@dataclass
class JobPins:
    ingest: ModelConfig | None = None
    embedding: ModelConfig | None = None
    vision: ModelConfig | None = None


_job_pins: ContextVar[JobPins | None] = ContextVar("job_pins", default=None)

_select_cols = """
                    SELECT model_key, version, display_name, provider_slug, base_url,
                           provider_model_id, params, surfaces,
                           micros_per_input_token, micros_per_output_token,
                           enabled, is_default_for, auth_mode, context_window_tokens
                      FROM model_configs
"""


@dataclass
class RequestLLM:
    user_id: str = ""
    paid_by: str = ""
    user_api_key: str = ""
    reasoning_mode: str = ""
    reasoning_effort: str = ""


_request_llm: ContextVar[RequestLLM | None] = ContextVar("request_llm", default=None)


def bind_request_llm(
    user_id: str | None = None,
    paid_by: str | None = None,
    reasoning_mode: str | None = None,
    reasoning_effort: str | None = None,
    *,
    user_api_key: str | None = None,
) -> None:
    _request_llm.set(
        RequestLLM(
            user_id=(user_id or "").strip(),
            paid_by=(paid_by or "").strip(),
            user_api_key=(user_api_key or "").strip(),
            reasoning_mode=(reasoning_mode or "").strip(),
            reasoning_effort=(reasoning_effort or "").strip(),
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
        self._by_pin: dict[tuple[str, int], ModelConfig] = {}
        self._current: dict[str, tuple[str, int]] = {}
        self._rev: int = -1
        self._started = False

    def start(self) -> None:
        # There is deliberately no process-start snapshot of the embedding or
        # vision default any more. Freezing them was how this process used to
        # avoid mixing vector spaces, which made the model a query embedded with
        # a function of when the container last booted. Embedding now comes from
        # workspaces.embedding_model_key and vision from the job pin, so there
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
        except Exception:  # noqa: BLE001 - first boot falls back to config.py
            if not self._started:
                log.warning("model registry unavailable; using config.py fallbacks")
            return

        by_pin: dict[tuple[str, int], ModelConfig] = {}
        current: dict[str, tuple[str, int]] = {}
        for row in rows:
            spec = _from_row(row)
            by_pin[(spec.model_key, spec.version)] = spec
            if not spec.enabled:
                continue
            for surface in spec.is_default_for:
                prev = current.get(surface)
                if prev is None or spec.version >= prev[1]:
                    current[surface] = spec.pin

        with self._lock:
            self._by_pin.update(by_pin)
            self._current.update(current)
            self._rev = rev

    def get(self, key: str, version: int) -> ModelConfig:
        if not key or version <= 0:
            raise RegistryError(f"invalid pin {key!r} v{version}")
        pin = (key, version)
        with self._lock:
            cached = self._by_pin.get(pin)
        if cached is not None:
            return cached
        spec = self._load(key, version)
        with self._lock:
            self._by_pin[pin] = spec
        return spec

    def _load(self, key: str, version: int) -> ModelConfig:
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                _select_cols + " WHERE model_key=%s AND version=%s",
                (key, version),
            )
            row = cur.fetchone()
        if not row:
            raise RegistryError(f"model config not found: {key} v{version}")
        return _from_row(row)

    def default_pin(self, surface: str) -> tuple[str, int]:
        with self._lock:
            pin = self._current.get(surface)
        if not pin:
            raise RegistryError(f"no default for {surface}")
        return pin

    def default(self, surface: str) -> ModelConfig:
        key, version = self.default_pin(surface)
        return self.get(key, version)

    def resolve_user(self, pref_key: str | None, surface: str) -> ModelConfig:
        if not pref_key:
            raise RegistryError(f"empty preference for {surface}")
        return self._latest_enabled(pref_key, surface)

    def _latest_enabled(self, key: str, surface: str) -> ModelConfig:
        with self._lock:
            best: ModelConfig | None = None
            for spec in self._by_pin.values():
                if (
                    spec.model_key == key
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
                 WHERE model_key=%s AND enabled AND %s = ANY(surfaces)
                 ORDER BY version DESC LIMIT 1
                """,
                (key, surface),
            )
            row = cur.fetchone()
        if not row:
            raise RegistryError(f"no enabled {key} for {surface}")
        spec = _from_row(row)
        with self._lock:
            self._by_pin[spec.pin] = spec
        return spec


def _from_row(row: tuple[Any, ...]) -> ModelConfig:
    params = row[6] or {}
    if not isinstance(params, dict):
        params = {}
    surfaces = tuple(row[7] or ())
    defaults = tuple(row[11] or ())
    auth_mode = row[12] if len(row) > 12 and row[12] else AUTH_PLATFORM
    window = int(row[13]) if len(row) > 13 and row[13] is not None else 0
    return ModelConfig(
        model_key=row[0],
        version=int(row[1]),
        display_name=row[2],
        provider_slug=row[3],
        base_url=row[4] or "",
        provider_model_id=row[5],
        params=params,
        surfaces=surfaces,
        micros_per_input_token=int(row[8]),
        micros_per_output_token=int(row[9]),
        enabled=bool(row[10]),
        is_default_for=defaults,
        auth_mode=str(auth_mode),
        context_window_tokens=window,
    )


registry = Registry()


def bootstrap_llm(provider_model_id: str) -> ModelConfig:
    return ModelConfig(
        model_key="bootstrap-llm",
        version=0,
        display_name="bootstrap",
        provider_slug="deepseek",
        base_url=cfg.llm.base_url,
        provider_model_id=provider_model_id or cfg.query_model,
        params={"temperature": 0.3},
        surfaces=(
            SURFACE_CHAT,
            SURFACE_GENERATE,
            SURFACE_EDITOR,
            SURFACE_QUIZ,
            SURFACE_INGEST,
        ),
        micros_per_input_token=250,
        micros_per_output_token=1000,
    )


def resolve_pinned(key: str | None, version: int | None, surface: str) -> ModelConfig:
    """Load an exact pin, for every surface without exception.

    A missing or unresolvable pin is an error, never the live default. Whoever
    is downstream of this call is about to spend money against a price somebody
    else already quoted (the gateway's reservation, the job payload) or to write
    a vector into a space somebody else already chose (the workspace). Resolving
    a default here would run a different model than the one that was priced, and
    nothing would say so.
    """
    if not key or not version:
        raise RegistryError(f"missing pin for {surface}")
    return registry.get(key, int(version))


def ingest_spec() -> ModelConfig:
    """The ingest LLM this job was enqueued with."""
    pins = current_job_pins()
    if pins is None or pins.ingest is None:
        raise RegistryError("no ingest pin on this job")
    return pins.ingest


def embedding_spec() -> ModelConfig:
    """The embedding model of the workspace this job belongs to.

    Installed by the worker from ``workspaces.embedding_model_key`` before any
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


def provider_cfg_for(spec: ModelConfig) -> ProviderCfg:
    """Credentials for one catalog row.

    Embedding and vision are platform-only: one env pair each, never a user
    key. Chat / generate / editor / quiz / ingest use the bound user key when
    the row allows it, otherwise the DeepSeek platform key.
    """
    base = spec.base_url
    if spec.allows(SURFACE_EMBEDDING):
        return ProviderCfg(cfg.embedding.api_key, base or cfg.embedding.base_url)
    if spec.allows(SURFACE_VISION):
        return ProviderCfg(cfg.vision.api_key, base or cfg.vision.base_url)

    req = current_request_llm()
    if req.paid_by == "user":
        key = req.user_api_key or _load_user_key(req.user_id, spec.provider_slug)
        if not key or spec.auth_mode not in (AUTH_USER_KEY, AUTH_PLATFORM_OR_USER):
            raise RegistryError(f"user key required for {spec.model_key}")
        return ProviderCfg(key, base)
    if req.user_api_key and spec.auth_mode in (AUTH_USER_KEY, AUTH_PLATFORM_OR_USER):
        return ProviderCfg(req.user_api_key, base)
    if spec.auth_mode == AUTH_USER_KEY:
        raise RegistryError(f"user key required for {spec.model_key}")
    if spec.provider_slug == "deepseek":
        return ProviderCfg(cfg.llm.api_key, base or cfg.llm.base_url)
    raise RegistryError(f"unknown platform provider {spec.provider_slug}")


def _load_user_key(user_id: str, provider_slug: str) -> str:
    if not user_id or not provider_slug:
        return ""
    from . import credentials

    key = credentials.decrypt_user_provider_key(user_id, provider_slug)
    req = current_request_llm()
    req.user_api_key = key
    return key


def context_window(spec: ModelConfig) -> int:
    return spec.context_window_tokens or cfg.llm_input_budget_tokens


def input_budget(spec: ModelConfig) -> int:
    return max(4000, context_window(spec) - 8192)


def extra_headers_for(spec: ModelConfig) -> dict[str, str]:
    if spec.provider_slug == "anthropic":
        return {"anthropic-version": "2023-06-01"}
    return {}


def credits_for_tokens(
    spec: ModelConfig, kind: str, input_tokens: int, output_tokens: int
) -> int:
    if kind == "embedding":
        return (input_tokens + output_tokens) * spec.micros_per_input_token
    return (
        input_tokens * spec.micros_per_input_token
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

    def load(key_field: str, ver_field: str, surface: str) -> ModelConfig:
        return resolve_pinned(payload.get(key_field), payload.get(ver_field), surface)

    return JobPins(
        ingest=load("ingestModelKey", "ingestModelVersion", SURFACE_INGEST),
        embedding=embedding,
        vision=load("visionModelKey", "visionModelVersion", SURFACE_VISION),
    )
