"""Hot-reloadable model registry, mirrored from server/internal/models.

Rows are immutable and versioned. The cache never evicts a (model_key, version)
pair. Polling ``model_registry_state`` only teaches this process the current
defaults; a pinned pair it has never seen is a point read of the table.

A cache miss never falls back to the current default. Embedding and vision
defaults are frozen at process start so a poll cannot mix vector spaces.
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
SURFACE_INGEST = "ingest"
SURFACE_EMBEDDING = "embedding"
SURFACE_VISION = "vision"
SURFACE_STT = "stt"

_FROZEN_SURFACES = {SURFACE_EMBEDDING, SURFACE_VISION}


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
        self._frozen: dict[str, tuple[str, int]] = {}
        self._rev: int = -1
        self._started = False

    def start(self) -> None:
        self.refresh()
        with self._lock:
            for surface in _FROZEN_SURFACES:
                pin = self._current.get(surface)
                if pin:
                    self._frozen[surface] = pin
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
            for surface, pin in current.items():
                if surface in _FROZEN_SURFACES and surface in self._frozen:
                    continue
                self._current[surface] = pin
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
            if surface in _FROZEN_SURFACES and surface in self._frozen:
                return self._frozen[surface]
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
        surfaces=(SURFACE_CHAT, SURFACE_GENERATE, SURFACE_EDITOR, SURFACE_INGEST),
        micros_per_input_token=250,
        micros_per_output_token=1000,
    )


def bootstrap_embedding() -> ModelConfig:
    return ModelConfig(
        model_key="bootstrap-embed",
        version=0,
        display_name="bootstrap",
        provider_slug="openrouter",
        base_url=cfg.embedding.base_url,
        provider_model_id=cfg.embedding_model,
        params={"dimensions": cfg.embedding_dim},
        surfaces=(SURFACE_EMBEDDING,),
        micros_per_input_token=50,
        micros_per_output_token=50,
    )


def bootstrap_vision() -> ModelConfig:
    return ModelConfig(
        model_key="bootstrap-vision",
        version=0,
        display_name="bootstrap",
        provider_slug="google",
        base_url=cfg.vision.base_url,
        provider_model_id=cfg.vision_model,
        params={"temperature": 0.2},
        surfaces=(SURFACE_VISION,),
        micros_per_input_token=250,
        micros_per_output_token=1000,
    )


def bootstrap_stt() -> ModelConfig:
    return ModelConfig(
        model_key="bootstrap-stt",
        version=0,
        display_name="bootstrap",
        provider_slug="openai",
        base_url=cfg.stt.base_url,
        provider_model_id=cfg.stt_model,
        surfaces=(SURFACE_STT,),
        micros_per_input_token=0,
        micros_per_output_token=0,
    )


def resolve_pinned(key: str | None, version: int | None, surface: str) -> ModelConfig:
    """Load an exact pin.

    Chat, generate, and editor must be given a (key, version). Missing or
    unresolvable pins are errors: the gateway prices from the same pair, and
    falling back to the live default would run a different model than the one
    reserved. Ingest/embed/vision/stt may still resolve a surface default when
    a job was enqueued without pins.
    """
    if key and version:
        return registry.get(key, int(version))
    if surface in (SURFACE_CHAT, SURFACE_GENERATE, SURFACE_EDITOR):
        raise RegistryError(f"missing pin for {surface}")
    try:
        return registry.default(surface)
    except RegistryError:
        if surface == SURFACE_EMBEDDING:
            return bootstrap_embedding()
        if surface == SURFACE_VISION:
            return bootstrap_vision()
        if surface == SURFACE_STT:
            return bootstrap_stt()
        return bootstrap_llm(cfg.query_model)


def ingest_spec() -> ModelConfig:
    pins = current_job_pins()
    if pins and pins.ingest is not None:
        return pins.ingest
    return resolve_pinned(None, None, SURFACE_INGEST)


def embedding_spec() -> ModelConfig:
    pins = current_job_pins()
    if pins and pins.embedding is not None:
        return pins.embedding
    return resolve_pinned(None, None, SURFACE_EMBEDDING)


def vision_spec() -> ModelConfig:
    pins = current_job_pins()
    if pins and pins.vision is not None:
        return pins.vision
    return resolve_pinned(None, None, SURFACE_VISION)


def provider_cfg_for(spec: ModelConfig) -> ProviderCfg:
    slug = spec.provider_slug
    base = spec.base_url
    if slug == "deepseek":
        return ProviderCfg(cfg.llm.api_key, base or cfg.llm.base_url)
    if slug == "openrouter":
        return ProviderCfg(cfg.embedding.api_key, base or cfg.embedding.base_url)
    if slug == "google":
        return ProviderCfg(cfg.vision.api_key, base or cfg.vision.base_url)
    if slug == "openai":
        return ProviderCfg(cfg.stt.api_key, base or cfg.stt.base_url)
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


def pins_from_payload(payload: dict[str, Any]) -> JobPins:
    def load(key_field: str, ver_field: str) -> ModelConfig | None:
        key = payload.get(key_field)
        version = payload.get(ver_field)
        if not key or not version:
            return None
        return registry.get(str(key), int(version))

    return JobPins(
        ingest=load("ingestModelKey", "ingestModelVersion"),
        embedding=load("embeddingModelKey", "embeddingModelVersion"),
        vision=load("visionModelKey", "visionModelVersion"),
    )
