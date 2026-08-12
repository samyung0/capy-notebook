"""Runtime configuration for the pipeline (ingest worker + retrieval service).

Everything is env-driven so the same image runs as either process.

The retrieval index lives in the same Postgres schema the Go migrations own, so
there is nothing to configure beyond ``DATABASE_URL`` — no per-workspace storage
namespaces, no working directory, no graph extension.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env(key: str, default: str = "") -> str:
    return os.getenv(key, default)


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

    # ---- gateway callback -------------------------------------------------
    # Tools with side effects (generate_material) POST to the Go gateway rather
    # than writing materials here, so authorization and storage quota stay in
    # one place. Unset disables those tools instead of bypassing the checks.
    gateway_url: str = _env("GATEWAY_URL", "")
    pipeline_secret: str = _env("PIPELINE_SECRET", "")

    # ---- worker -----------------------------------------------------------
    poll_interval: float = float(_env("EVO_POLL_INTERVAL", "2.0"))

    # ---- Modal MinerU parse service --------------------------------------
    modal_parse_url: str = _env("MODAL_PARSE_URL", "")
    modal_parse_token: str = _env("MODAL_PARSE_TOKEN", "")
    modal_parse_timeout: int = int(_env("MODAL_PARSE_TIMEOUT", "600"))
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

    # ---- chunking ---------------------------------------------------------
    # Target size in characters, not tokens: the boundary decisions here are
    # structural (headings, blocks) and a tokenizer would only add a dependency
    # and a per-model failure mode for a bound that is already approximate.
    chunk_chars: int = int(_env("EVO_CHUNK_CHARS", "1600"))
    chunk_overlap_chars: int = int(_env("EVO_CHUNK_OVERLAP_CHARS", "200"))
    chunk_min_chars: int = int(_env("EVO_CHUNK_MIN_CHARS", "160"))

    # ---- embeddings (OpenRouter, OpenAI-compatible) -----------------------
    embedding = ProviderCfg(
        api_key=_env("OPENROUTER_API_KEY"),
        base_url=_env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    )
    embedding_model: str = _env("EVO_MODEL_EMBEDDING", "qwen/qwen3-embedding-4b")
    # Must match halfvec(N) in server/migrations/0001_init.sql. Writes assert on
    # it rather than letting a mismatched vector reach Postgres.
    embedding_dim: int = int(_env("EMBEDDING_DIM", "2560"))
    embedding_batch: int = int(_env("EVO_EMBEDDING_BATCH", "64"))

    # ---- text LLM (DeepSeek, OpenAI-compatible) ---------------------------
    llm = ProviderCfg(
        api_key=_env("DEEPSEEK_API_KEY"),
        base_url=_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    )
    # Summaries, queries, generation, and editor AI use the flash model.
    ingest_model: str = _env("EVO_MODEL_EXTRACTION", "deepseek-v4-flash")
    query_model: str = _env("EVO_QUERY_MODEL", "deepseek-v4-flash")

    # ---- retrieval --------------------------------------------------------
    search_candidates: int = int(_env("EVO_SEARCH_CANDIDATES", "40"))
    search_top_k: int = int(_env("EVO_SEARCH_TOP_K", "8"))
    # Cap on chunks one file may contribute to a result set. A textbook whose
    # every page mentions the query term would otherwise crowd out the four
    # other sources that answer it.
    search_per_file_cap: int = int(_env("EVO_SEARCH_PER_FILE_CAP", "3"))
    # Tool calls per chat turn. The loop is capped rather than open-ended: the
    # cost of a wrong plan is bounded, and past ~4 rounds a cheap model tends to
    # re-search rather than answer.
    agent_max_steps: int = int(_env("EVO_AGENT_MAX_STEPS", "4"))

    # ---- vision / image caption (Gemini via its OpenAI-compatible API) ----
    vision = ProviderCfg(
        api_key=_env("GOOGLE_API_KEY"),
        base_url=_env(
            "GEMINI_BASE_URL",
            "https://generativelanguage.googleapis.com/v1beta/openai/",
        ),
    )
    vision_model: str = _env("EVO_MODEL_IMAGE_CAPTION", "gemini-3.1-flash-lite-preview")
    # Captioning is per-image and only pays off on figure-heavy sources; off by
    # default so a 300-page scan does not turn into 300 VLM calls.
    caption_images: bool = _env("EVO_CAPTION_IMAGES", "false").lower() == "true"
    caption_max_per_file: int = int(_env("EVO_CAPTION_MAX_PER_FILE", "40"))

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
        return {self.query_model} if self.query_model else set()


cfg = Config()
