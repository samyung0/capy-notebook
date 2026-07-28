"""Runtime configuration for the RAG pipeline (worker + retrieval).

Everything is env-driven so the same image runs as worker or retrieval service.

LightRAG's Postgres storages read their OWN discrete env vars (POSTGRES_HOST,
POSTGRES_PORT, ...), NOT the libpq ``DATABASE_URL``. To keep a single source of
truth we parse ``DATABASE_URL`` here and populate the POSTGRES_* vars (without
clobbering anything the operator set explicitly), and we pin
``POSTGRES_VECTOR_INDEX_TYPE=HNSW_HALFVEC`` because the embedding dimension
(2560 for Qwen3-Embedding-4B) exceeds pgvector's 2000-dim cap for plain
``vector`` HNSW indexes (halfvec indexes up to 4000; requires pgvector >= 0.7.0).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import unquote, urlparse


def _env(key: str, default: str = "") -> str:
    return os.getenv(key, default)


def _seed_lightrag_pg_env() -> None:
    """Derive POSTGRES_* from DATABASE_URL for LightRAG's PG storages.

    Only fills vars that are not already set, so explicit overrides win.
    """
    dsn = os.getenv("DATABASE_URL", "")
    if dsn:
        u = urlparse(dsn)
        mapping = {
            "POSTGRES_HOST": u.hostname or "localhost",
            "POSTGRES_PORT": str(u.port or 5432),
            "POSTGRES_USER": unquote(u.username) if u.username else "postgres",
            "POSTGRES_PASSWORD": unquote(u.password) if u.password else "",
            "POSTGRES_DATABASE": (u.path or "/postgres").lstrip("/") or "postgres",
        }
        for k, v in mapping.items():
            os.environ.setdefault(k, v)

    # 2560-dim embeddings require halfvec HNSW indexes (pgvector >= 0.7.0).
    os.environ.setdefault("POSTGRES_VECTOR_INDEX_TYPE", "HNSW_HALFVEC")
    # LightRAG uses POSTGRES_WORKSPACE only as a global default; per-instance
    # isolation is set explicitly via LightRAG(workspace=...). Leave it unset so
    # a stray global workspace can't shadow the per-tenant value.

    # LightRAG's parse pipeline resolves pending_parse sources under
    # ``INPUT_DIR/<workspace>/``; the worker stages each blob there before
    # enqueueing and cleans up afterwards.
    working_dir = os.getenv("WORKING_DIR", "/data/rag_storage")
    os.environ.setdefault("INPUT_DIR", os.path.join(working_dir, "inputs"))


_seed_lightrag_pg_env()


@dataclass(frozen=True)
class ProviderCfg:
    api_key: str
    base_url: str


class Config:
    # ---- shared infra -----------------------------------------------------
    dsn: str = _env(
        "DATABASE_URL", "postgres://evo:evo@localhost:5432/evo?sslmode=disable"
    )
    redis_url: str = _env("REDIS_URL", "redis://localhost:6379/0")

    # ---- Backblaze B2 blob storage ---------------------------------------
    # The Go gateway stores the object key in the job payload. The worker
    # downloads that key to temporary local storage before parsing.
    b2_endpoint: str = _env("B2_ENDPOINT", "")
    b2_region: str = _env("B2_REGION", "")
    b2_bucket: str = _env("B2_BUCKET", "")
    b2_key_id: str = _env("B2_KEY_ID", "")
    b2_app_key: str = _env("B2_APP_KEY", "")

    # LightRAG still wants a working dir handle even with PG backends.
    working_dir: str = _env("WORKING_DIR", "/data/rag_storage")
    # Staging dir for pending_parse sources (seeded into INPUT_DIR above).
    input_dir: str = _env("INPUT_DIR", "")

    # ---- worker -----------------------------------------------------------
    poll_interval: float = float(_env("EVO_POLL_INTERVAL", "2.0"))
    lightrag_cache_size: int = int(_env("EVO_LIGHTRAG_CACHE_SIZE", "16"))
    # LightRAG caches extraction LLM responses in Postgres (keyed per workspace)
    # so re-ingesting identical content is cheap. Disable it to make ingest
    # deterministic w.r.t. outbound LLM calls — required when recording
    # record-replay test cassettes (see pipeline/tests/README.md).
    ingest_llm_cache: bool = _env("EVO_INGEST_LLM_CACHE", "true").lower() != "false"

    # ---- Modal MineRU parse service --------------------------------------
    modal_parse_url: str = _env("MODAL_PARSE_URL", "")
    modal_parse_token: str = _env("MODAL_PARSE_TOKEN", "")
    modal_parse_timeout: int = int(_env("MODAL_PARSE_TIMEOUT", "600"))
    modal_b2_artifacts: bool = _env("MODAL_B2_ARTIFACTS", "true").lower() != "false"
    parse_method: str = _env("EVO_PARSE_METHOD", "auto")  # auto | ocr | txt

    # ---- MinerU lightweight (free) cloud parse API ------------------------
    # Token-free, IP rate-limited "Agent" endpoints on mineru.net; used for
    # parseMode=normal jobs. 'ch' OCR pack = Chinese + English only.
    mineru_lite_base: str = _env(
        "MINERU_LITE_BASE_URL", "https://mineru.net/api/v1/agent"
    )
    mineru_lite_language: str = _env("MINERU_LITE_LANGUAGE", "ch")
    mineru_lite_timeout: int = int(_env("MINERU_LITE_TIMEOUT", "600"))
    mineru_relay_url: str = _env("MINERU_RELAY_URL", "")
    mineru_relay_token: str = _env("MINERU_RELAY_TOKEN", "")
    mineru_relay_timeout: int = int(_env("MINERU_RELAY_TIMEOUT", "180"))

    # ---- embeddings (OpenRouter, OpenAI-compatible) -----------------------
    embedding = ProviderCfg(
        api_key=_env("OPENROUTER_API_KEY"),
        base_url=_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    )
    embedding_model: str = _env("EVO_MODEL_EMBEDDING", "qwen/qwen3-embedding-4b")
    embedding_dim: int = int(_env("EMBEDDING_DIM", "2560"))
    embedding_max_tokens: int = int(_env("EVO_EMBEDDING_MAX_TOKENS", "8192"))

    # ---- text LLM (DeepSeek, OpenAI-compatible) ---------------------------
    llm = ProviderCfg(
        api_key=_env("DEEPSEEK_API_KEY"),
        base_url=_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    )
    # Ingest extraction is fixed to the cheap model.
    ingest_model: str = _env("EVO_MODEL_EXTRACTION", "deepseek-v4-flash")
    # Query keeps both reachable; defaults to pro, flash selectable per request.
    query_model: str = _env("EVO_QUERY_MODEL", "deepseek-v4-pro")
    query_model_alt: str = _env("EVO_QUERY_MODEL_ALT", "deepseek-v4-flash")

    # ---- vision / image caption (Gemini via its OpenAI-compatible API) ----
    vision = ProviderCfg(
        api_key=_env("GOOGLE_API_KEY"),
        base_url=_env(
            "GEMINI_BASE_URL",
            "https://generativelanguage.googleapis.com/v1beta/openai/",
        ),
    )
    vision_model: str = _env("EVO_MODEL_IMAGE_CAPTION", "gemini-3.1-flash-lite-preview")

    # ---- speech-to-text (Whisper-compatible, OpenAI API) ------------------
    # Used by /transcribe for voice notes. Defaults to OpenAI Whisper; point
    # WHISPER_BASE_URL at any OpenAI-compatible STT endpoint to swap providers.
    stt = ProviderCfg(
        api_key=_env("WHISPER_API_KEY", _env("OPENAI_API_KEY")),
        base_url=_env("WHISPER_BASE_URL", "https://api.openai.com/v1"),
    )
    stt_model: str = _env("EVO_MODEL_STT", "whisper-1")

    @property
    def query_models(self) -> set[str]:
        """Models the retrieval service is allowed to dispatch to."""
        return {m for m in (self.query_model, self.query_model_alt) if m}


cfg = Config()
