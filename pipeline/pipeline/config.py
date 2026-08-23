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


def _env_first(*keys: str, default: str = "") -> str:
    for key in keys:
        value = os.getenv(key)
        if value:
            return value
    return default


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
    # Same 32-byte value as the Go gateway. Retrieval decrypts user keys here
    # so the plaintext never crosses the gateway hop.
    llm_credentials_key: str = _env("LLM_CREDENTIALS_KEY", "")

    # ---- worker -----------------------------------------------------------
    poll_interval: float = float(_env("EVO_POLL_INTERVAL", "2.0"))
    # Caption cache entries unused for this long are swept. Parse zips are
    # dropped on success; the same sweeper is the orphan reaper for a zip
    # whose drop never ran.
    caption_cache_ttl_days: int = int(_env("EVO_CAPTION_CACHE_TTL_DAYS", "90"))
    parse_zip_ttl_hours: int = int(_env("EVO_PARSE_ZIP_TTL_HOURS", "6"))
    # Per-call bound for chat/embed/vision. A hung provider otherwise holds
    # the worker (and its job lease) until the process is killed.
    provider_timeout_s: float = float(_env("EVO_PROVIDER_TIMEOUT_S", "120"))

    # ---- Modal parse service ---------------------------------------------
    # One CPU endpoint: Marker with OCR off, RapidOCR (PP-OCRv6) on pages the
    # scan probe flags. MODAL_FAST_PARSE_URL wins; MODAL_PARSE_URL is an alias
    # so older compose files still work.
    modal_parse_url: str = _env("MODAL_PARSE_URL", "")
    modal_fast_parse_url: str = _env("MODAL_FAST_PARSE_URL", "")
    modal_parse_token: str = _env("MODAL_PARSE_TOKEN", "")
    # The endpoint may hold a request behind other documents sharing the
    # container (6 digital at once, 2 if RapidOCR is in play), so the client
    # timeout has to cover queueing, not just parsing.
    modal_parse_timeout: int = int(_env("MODAL_PARSE_TIMEOUT", "900"))
    # Must match modal/parse_common.py: max_containers × max_inputs. Extra jobs
    # wait in Postgres with file status pending instead of opening more boxes.
    parse_fast_slots: int = int(_env("EVO_PARSE_FAST_SLOTS", "72"))
    # ``ocr`` runs RapidOCR on scanned/thin pages; ``txt`` skips it.
    # Kept in the artifact fingerprint.
    parse_method: str = _env("EVO_PARSE_METHOD", "ocr")  # ocr | auto | txt

    # ---- chunking ---------------------------------------------------------
    # Target size in characters, not tokens: the boundary decisions here are
    # structural (headings, blocks) and a tokenizer would only add a dependency
    # and a per-model failure mode for a bound that is already approximate.
    chunk_chars: int = int(_env("EVO_CHUNK_CHARS", "1600"))
    chunk_overlap_chars: int = int(_env("EVO_CHUNK_OVERLAP_CHARS", "200"))
    chunk_min_chars: int = int(_env("EVO_CHUNK_MIN_CHARS", "160"))

    # ---- embeddings (OpenAI-compatible) -----------------------------------
    # Credentials only. Which embedding model runs is never configured here: it
    # is pinned per workspace (`workspaces.embedding_model_key`) and resolved
    # from `model_configs`, because every chunk already in that workspace lives
    # in that model's vector space and there is no reindex job to move them.
    # One env pair for every embedding row; base_url on the catalog row wins
    # when set. OPENROUTER_* is the previous name and still accepted.
    embedding = ProviderCfg(
        api_key=_env_first("EMBEDDING_API_KEY", "OPENROUTER_API_KEY"),
        base_url=_env_first(
            "EMBEDDING_BASE_URL",
            "OPENROUTER_BASE_URL",
            default="https://openrouter.ai/api/v1",
        ),
    )
    # Width the seeded qwen-embed row emits. Fixtures use this for synthetic
    # vectors. A new model is a new rag_chunk_vectors_* table, not an env edit.
    embedding_dim: int = int(_env("EMBEDDING_DIM", "2560"))
    embedding_batch: int = int(_env("EVO_EMBEDDING_BATCH", "64"))

    # ---- text LLM (DeepSeek, OpenAI-compatible) ---------------------------
    llm = ProviderCfg(
        api_key=_env("DEEPSEEK_API_KEY"),
        base_url=_env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    )
    # Last-resort provider model id for an LLM call that was handed a bare model
    # string rather than a registry pin. Ingest, embedding and vision no longer
    # have an equivalent: each is resolved from an exact pin and fails loudly
    # instead of running an unpriced model.
    query_model: str = _env("EVO_QUERY_MODEL", "deepseek-v4-flash")

    # ---- retrieval --------------------------------------------------------
    search_candidates: int = int(_env("EVO_SEARCH_CANDIDATES", "40"))
    search_top_k: int = int(_env("EVO_SEARCH_TOP_K", "8"))
    # Cap on chunks one file may contribute to a result set. A textbook whose
    # every page mentions the query term would otherwise crowd out the four
    # other sources that answer it.
    search_per_file_cap: int = int(_env("EVO_SEARCH_PER_FILE_CAP", "3"))
    # Tool-calling rounds per chat turn. The loop is capped rather than
    # open-ended: the cost of a wrong plan is bounded. Each round re-sends the
    # whole transcript, so this is the main lever on chat spend.
    agent_max_steps: int = int(_env("EVO_AGENT_MAX_STEPS", "12"))
    # Floor every LLM we dispatch to is assumed to support. File summaries,
    # generate context, and map-reduce splits all read this rather than a
    # per-call character constant.
    llm_input_budget_tokens: int = int(_env("EVO_LLM_INPUT_BUDGET_TOKENS", "50000"))

    # ---- vision / image caption (Gemini via its OpenAI-compatible API) ----
    vision = ProviderCfg(
        api_key=_env("GOOGLE_API_KEY"),
        base_url=_env(
            "GEMINI_BASE_URL",
            "https://generativelanguage.googleapis.com/v1beta/openai/",
        ),
    )
    # Default for uploads that do not carry an explicit captionImages choice.
    # The real switch is per file, set at upload time and carried on the job.
    caption_images: bool = _env("EVO_CAPTION_IMAGES", "false").lower() == "true"
    # Every surviving figure is captioned — the filters in parse/figures.py, not
    # a count, are what bound the cost. This is a safety valve for a pathological
    # document, not a quality knob; 0 disables it.
    caption_max_per_file: int = int(_env("EVO_CAPTION_MAX_PER_FILE", "0"))
    # Wall clock, not price, is the binding constraint: a slide deck can have
    # hundreds of figures and each call is ~1-2s.
    caption_concurrency: int = int(_env("EVO_CAPTION_CONCURRENCY", "8"))
    # Longest edge sent to the vision model. Figures are re-encoded to JPEG at
    # this size, which is well past the resolution a caption needs and keeps the
    # image-token count (and the upload) small.
    caption_max_edge: int = int(_env("EVO_CAPTION_MAX_EDGE", "1280"))
    # Bumped whenever the prompt, the model or the filters change, so cached
    # captions from an older definition are not reused.
    caption_version: str = _env("EVO_CAPTION_VERSION", "v1")

    @property
    def query_models(self) -> set[str]:
        """Models the retrieval service is allowed to dispatch to."""
        return {self.query_model} if self.query_model else set()


cfg = Config()
