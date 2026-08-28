"""Runtime configuration for the pipeline (ingest worker + retrieval service).

Everything is env-driven so the same image runs as either process.

The retrieval index lives in the same Postgres schema the Go migrations own, so
there is nothing to configure beyond ``DATABASE_URL`` — no per-workspace storage
namespaces, no working directory, no graph extension.
"""

from __future__ import annotations

import os


def _env(key: str, default: str = "") -> str:
    value = os.getenv(key)
    if value:
        return value
    return default


def env_name_for_provider(provider_slug: str) -> str:
    from .elitellm.providers import platform_env_name

    try:
        return platform_env_name(provider_slug)
    except KeyError:
        replacer = str.maketrans({"-": "_", ".": "_"})
        return provider_slug.upper().translate(replacer) + "_API_KEY"


def platform_api_key(provider_slug: str) -> str:
    return _env(env_name_for_provider(provider_slug))


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

    # ---- persistent parse service ----------------------------------------
    # In production the ingest worker and parser both run on the Netcup VM.
    # The old MODAL_* names remain read-only fallbacks so a checkout of this
    # branch can be rolled back without editing secrets first.
    parser_url: str = _env("PARSER_URL", _env("MODAL_FAST_PARSE_URL", ""))
    parser_token: str = _env("PARSER_TOKEN", _env("MODAL_PARSE_TOKEN", ""))
    # Includes queue time behind the measured two-job OCR-heavy lane.
    parser_timeout: int = int(
        _env("PARSER_TIMEOUT", _env("MODAL_PARSE_TIMEOUT", "1800"))
    )
    # Up to eight ingest workers may queue a parse. The parser independently
    # admits four Marker-only/selective digital jobs or two OCR-heavy jobs.
    parse_fast_slots: int = int(
        _env("EVO_PARSE_SLOTS", _env("EVO_PARSE_FAST_SLOTS", "8"))
    )
    # Part of the parse artifact fingerprint. Never silently fall back between
    # these modes: their output and resource profile are intentionally distinct.
    parse_method: str = _env("EVO_PARSE_METHOD", "selective_rapidocr")

    # Compatibility attributes for code outside this repository that has not
    # moved to the provider-neutral names yet.
    modal_fast_parse_url: str = parser_url
    modal_parse_token: str = parser_token
    modal_parse_timeout: int = parser_timeout

    # ---- chunking ---------------------------------------------------------
    # Target size in characters, not tokens: the boundary decisions here are
    # structural (headings, blocks) and a tokenizer would only add a dependency
    # and a per-model failure mode for a bound that is already approximate.
    chunk_chars: int = int(_env("EVO_CHUNK_CHARS", "1600"))
    chunk_overlap_chars: int = int(_env("EVO_CHUNK_OVERLAP_CHARS", "200"))
    chunk_min_chars: int = int(_env("EVO_CHUNK_MIN_CHARS", "160"))

    # Width the seeded qwen-embed row emits. Fixtures use this for synthetic
    # vectors. A new model is a new rag_chunk_vectors_* table, not an env edit.
    embedding_dim: int = int(_env("EMBEDDING_DIM", "2560"))
    embedding_batch: int = int(_env("EVO_EMBEDDING_BATCH", "64"))

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
    # Pre-model gathering budget when no catalog model has been selected yet.
    # Provider calls use the selected catalog row's required context window.
    llm_input_budget_tokens: int = int(_env("EVO_LLM_INPUT_BUDGET_TOKENS", "50000"))

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


cfg = Config()
