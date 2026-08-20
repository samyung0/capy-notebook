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
    micros_per_input_token: int = 250
    micros_per_output_token: int = 1000
    usd_micros_per_input_token: int = 0
    usd_micros_per_output_token: int = 0
    enabled: bool = True
    is_default_for: tuple[str, ...] = ()

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


class RegistryError(RuntimeError):
    """A pinned (model_key, version) could not be loaded. Never a silent default."""


@dataclass
class JobPins:
    ingest: ModelConfig | None = None
    embedding: ModelConfig | None = None
    vision: ModelConfig | None = None


_job_pins: ContextVar[JobPins | None] = ContextVar("job_pins", default=None)


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
                cur.execute(
                    """
                    SELECT model_key, version, display_name, provider_slug, base_url,
                           provider_model_id, params, surfaces,
                           micros_per_input_token, micros_per_output_token,
                           usd_micros_per_input_token, usd_micros_per_output_token,
                           enabled, is_default_for
                      FROM model_configs
                    """
                )
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
                """
                SELECT model_key, version, display_name, provider_slug, base_url,
                       provider_model_id, params, surfaces,
                       micros_per_input_token, micros_per_output_token,
                       usd_micros_per_input_token, usd_micros_per_output_token,
                       enabled, is_default_for
                  FROM model_configs WHERE model_key=%s AND version=%s
                """,
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
                """
                SELECT model_key, version, display_name, provider_slug, base_url,
                       provider_model_id, params, surfaces,
                       micros_per_input_token, micros_per_output_token,
                       usd_micros_per_input_token, usd_micros_per_output_token,
                       enabled, is_default_for
                  FROM model_configs
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
    defaults = tuple(row[13] or ())
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
        usd_micros_per_input_token=int(row[10]),
        usd_micros_per_output_token=int(row[11]),
        enabled=bool(row[12]),
        is_default_for=defaults,
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
    slug = spec.provider_slug
    base = spec.base_url
    if slug == "deepseek":
        return ProviderCfg(cfg.llm.api_key, base or cfg.llm.base_url)
    if slug == "openrouter":
        return ProviderCfg(cfg.embedding.api_key, base or cfg.embedding.base_url)
    if slug == "google":
        return ProviderCfg(cfg.vision.api_key, base or cfg.vision.base_url)
    return ProviderCfg(cfg.llm.api_key, base or cfg.llm.base_url)


def credits_for_tokens(
    spec: ModelConfig, kind: str, input_tokens: int, output_tokens: int
) -> int:
    if kind == "embedding":
        per = spec.micros_per_input_token or 50
        return (input_tokens + output_tokens) * per
    return (
        input_tokens * spec.micros_per_input_token
        + output_tokens * spec.micros_per_output_token
    )


def cost_micro_usd(spec: ModelConfig, input_tokens: int, output_tokens: int) -> int:
    return (
        input_tokens * spec.usd_micros_per_input_token
        + output_tokens * spec.usd_micros_per_output_token
    ) // 1_000_000


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
