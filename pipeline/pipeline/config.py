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
    release_sha: str = _env("RELEASE_SHA", "dev")
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
    # Durable caption artifacts are swept from B2 when unused. Parse bundles
    # live only in the VM's shared spool and have a much shorter local TTL.
    caption_cache_ttl_days: int = int(_env("EVO_CAPTION_CACHE_TTL_DAYS", "90"))
    parse_zip_ttl_hours: int = int(_env("EVO_PARSE_ZIP_TTL_HOURS", "6"))
    parse_source_ttl_hours: int = int(_env("EVO_PARSE_SOURCE_TTL_HOURS", "2"))
    # Interactive calls should fail while the browser request is still useful.
    # Background ingest has its own larger bound and remains retryable.
    interactive_provider_timeout_s: float = float(
        _env("EVO_INTERACTIVE_PROVIDER_TIMEOUT_S", "25")
    )
    ingest_provider_timeout_s: float = float(
        _env("EVO_INGEST_PROVIDER_TIMEOUT_S", "120")
    )

    # ---- persistent parse service ----------------------------------------
    # In production the ingest worker and parser both run on the Netcup VM.
    parser_url: str = _env("PARSER_URL", "")
    parser_token: str = _env("PARSER_TOKEN", "")
    # Includes queue time behind the measured two-job OCR-heavy lane.
    parser_timeout: int = int(_env("PARSER_TIMEOUT", "2400"))
    # Starts only after the parser acquires a process lane. Crossing it
    # quarantines the fingerprint and restarts the parser container.
    parse_hard_timeout: int = int(_env("EVO_PARSE_HARD_TIMEOUT", "2300"))
    # The parser and ingest worker mount this same directory on the Netcup VM.
    # Sources are job-scoped; parse bundles are fingerprint-addressed caches.
    parse_shared_dir: str = _env("EVO_PARSE_SHARED_DIR", "/tmp/evo-parse-spool")
    # These are deliberately separate deadlines. A parser call must finish
    # before its Redis admission lease, and the ingest job needs time afterwards
    # for captions, embeddings, and its billing receipt.
    parser_slot_ttl: int = int(_env("PARSER_SLOT_TTL", str(parser_timeout + 300)))
    ingest_timeout: int = int(_env("EVO_INGEST_TIMEOUT", "3600"))
    # Up to eight ingest workers may queue a parse. The parser independently
    # admits four Marker-only/selective digital jobs or two OCR-heavy jobs.
    parse_fast_slots: int = int(_env("EVO_PARSE_SLOTS", "8"))
    # Part of the parse artifact fingerprint. Never silently fall back between
    # these modes: their output and resource profile are intentionally distinct.
    parse_method: str = _env("EVO_PARSE_METHOD", "selective_rapidocr")
    # LibreOffice output can be much larger than the compressed Office source.
    # Bound both the worker allocation and the platform preview object.
    office_preview_max_bytes: int = int(
        _env("EVO_OFFICE_PREVIEW_MAX_BYTES", str(128 << 20))
    )
    # Parser artifacts cross a container boundary and may contain highly
    # compressed text/images in addition to an Office preview. Keep both the
    # local zip and its extracted form bounded independently of source bytes.
    parse_artifact_max_bytes: int = int(
        _env("EVO_PARSE_ARTIFACT_MAX_BYTES", str(256 << 20))
    )
    parse_artifact_max_entries: int = int(
        _env("EVO_PARSE_ARTIFACT_MAX_ENTRIES", "4096")
    )
    parse_artifact_max_entry_bytes: int = int(
        _env("EVO_PARSE_ARTIFACT_MAX_ENTRY_BYTES", str(128 << 20))
    )
    parse_artifact_max_expanded_bytes: int = int(
        _env("EVO_PARSE_ARTIFACT_MAX_EXPANDED_BYTES", str(512 << 20))
    )
    parse_content_max_bytes: int = int(
        _env("EVO_PARSE_CONTENT_MAX_BYTES", str(128 << 20))
    )
    parse_content_max_blocks: int = int(_env("EVO_PARSE_CONTENT_MAX_BLOCKS", "250000"))
    parse_image_max_bytes: int = int(_env("EVO_PARSE_IMAGE_MAX_BYTES", str(32 << 20)))
    parse_images_max_bytes: int = int(
        _env("EVO_PARSE_IMAGES_MAX_BYTES", str(256 << 20))
    )

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
    caption_version: str = _env("EVO_CAPTION_VERSION", "v2")
    # Standalone image uploads use the same vision pin and caption definition
    # as parsed figures, but get a source-level artifact rather than a block
    # caption map. Decoded pixels are bounded independently of compressed
    # upload bytes.
    image_max_pixels: int = int(_env("EVO_IMAGE_MAX_PIXELS", "100000000"))

    # Uploaded audio uses asynchronous ElevenLabs Scribe v2. Starter admits 12
    # weighted units; an audio job costs min(4, ceil(duration / 480 seconds)).
    elevenlabs_api_key: str = _env("ELEVENLABS_API_KEY", "")
    elevenlabs_base_url: str = _env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io")
    elevenlabs_webhook_id: str = _env("ELEVENLABS_WEBHOOK_ID", "")
    elevenlabs_transcript_version: str = _env(
        "EVO_ELEVENLABS_TRANSCRIPT_VERSION", "scribe-v2-1"
    )
    elevenlabs_concurrency_units: int = int(
        _env("EVO_ELEVENLABS_CONCURRENCY_UNITS", "12")
    )
    audio_max_duration_seconds: int = int(
        _env("EVO_AUDIO_MAX_DURATION_SECONDS", "36000")
    )

    # Shape of deterministic CSV/TSV row text. Bump to keep donor reuse honest
    # if header inference or row formatting changes.
    tabular_text_version: str = _env("EVO_TABULAR_TEXT_VERSION", "v1")


cfg = Config()

if cfg.office_preview_max_bytes <= 0:
    raise ValueError("EVO_OFFICE_PREVIEW_MAX_BYTES must be positive")

for key, value in (
    ("EVO_PARSE_ARTIFACT_MAX_BYTES", cfg.parse_artifact_max_bytes),
    ("EVO_PARSE_ARTIFACT_MAX_ENTRIES", cfg.parse_artifact_max_entries),
    ("EVO_PARSE_ARTIFACT_MAX_ENTRY_BYTES", cfg.parse_artifact_max_entry_bytes),
    ("EVO_PARSE_ARTIFACT_MAX_EXPANDED_BYTES", cfg.parse_artifact_max_expanded_bytes),
    ("EVO_PARSE_CONTENT_MAX_BYTES", cfg.parse_content_max_bytes),
    ("EVO_PARSE_CONTENT_MAX_BLOCKS", cfg.parse_content_max_blocks),
    ("EVO_PARSE_IMAGE_MAX_BYTES", cfg.parse_image_max_bytes),
    ("EVO_PARSE_IMAGES_MAX_BYTES", cfg.parse_images_max_bytes),
):
    if value <= 0:
        raise ValueError(f"{key} must be positive")

if cfg.image_max_pixels <= 0:
    raise ValueError("EVO_IMAGE_MAX_PIXELS must be positive")

for key, value in (
    ("EVO_PARSE_HARD_TIMEOUT", cfg.parse_hard_timeout),
    ("EVO_INTERACTIVE_PROVIDER_TIMEOUT_S", cfg.interactive_provider_timeout_s),
    ("EVO_INGEST_PROVIDER_TIMEOUT_S", cfg.ingest_provider_timeout_s),
    ("EVO_ELEVENLABS_CONCURRENCY_UNITS", cfg.elevenlabs_concurrency_units),
    ("EVO_AUDIO_MAX_DURATION_SECONDS", cfg.audio_max_duration_seconds),
):
    if value <= 0:
        raise ValueError(f"{key} must be positive")

if cfg.parse_zip_ttl_hours <= 0 or cfg.parse_source_ttl_hours <= 0:
    raise ValueError("local parse spool TTLs must be positive")

if not cfg.parse_shared_dir.strip():
    raise ValueError("EVO_PARSE_SHARED_DIR must not be empty")

if not (
    cfg.parse_hard_timeout < cfg.parser_timeout
    and cfg.parser_timeout < cfg.parser_slot_ttl
    and cfg.parser_slot_ttl < cfg.ingest_timeout
):
    raise ValueError(
        "parse time budgets must satisfy hard timeout < parser timeout < slot TTL < ingest timeout"
    )
