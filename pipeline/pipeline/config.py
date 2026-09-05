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
        "DATABASE_URL", "postgres://capy:capy@localhost:5432/capy?sslmode=disable"
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
    poll_interval: float = float(_env("CAPY_POLL_INTERVAL", "2.0"))
    # Optional host-wide locks let isolated local and UAT queue consumers share
    # one active parse job and one active ingest job without sharing databases.
    shared_capacity_lock_dir: str = _env("CAPY_SHARED_CAPACITY_LOCK_DIR", "")
    parse_coordinator_concurrency: int = int(
        _env("CAPY_PARSE_COORDINATOR_CONCURRENCY", "4")
    )
    db_sync_pool_max_size: int = int(_env("CAPY_DB_SYNC_POOL_MAX_SIZE", "4"))
    db_async_pool_max_size: int = int(_env("CAPY_DB_ASYNC_POOL_MAX_SIZE", "8"))
    # Durable derived artifacts and parse-bundle reuse copies are swept from B2
    # when unused. Required local parse handoffs have a shorter spool TTL.
    caption_cache_ttl_days: int = int(_env("CAPY_CAPTION_CACHE_TTL_DAYS", "90"))
    parse_zip_ttl_hours: int = int(_env("CAPY_PARSE_ZIP_TTL_HOURS", "6"))
    parse_source_ttl_hours: int = int(_env("CAPY_PARSE_SOURCE_TTL_HOURS", "2"))
    # Interactive calls should fail while the browser request is still useful.
    # Background ingest has its own larger bound and remains retryable.
    interactive_provider_timeout_s: float = float(
        _env("CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S", "25")
    )
    ingest_provider_timeout_s: float = float(
        _env("CAPY_INGEST_PROVIDER_TIMEOUT_S", "120")
    )

    # ---- provider imports (Drive / OneDrive) -----------------------------
    # The import worker streams one provider file into B2 per claim and needs
    # GATEWAY_URL + PIPELINE_SECRET for the download grant and completion.
    # Hosts are suffix-matched against the download URL and every redirect.
    # Providers move their download tiers without notice (OneDrive personal
    # answers on microsoftpersonalcontent.com today), so extend this list in
    # the environment rather than in code.
    import_job_timeout: int = int(_env("CAPY_IMPORT_JOB_TIMEOUT", "600"))
    import_download_hosts: tuple[str, ...] = tuple(
        host.strip().lower()
        for host in _env(
            "CAPY_IMPORT_DOWNLOAD_HOSTS",
            "googleapis.com,googleusercontent.com,drive.usercontent.google.com,"
            "1drv.com,sharepoint.com,microsoftpersonalcontent.com",
        ).split(",")
        if host.strip()
    )

    # ---- persistent parse service ----------------------------------------
    # In production the ingest worker and parser both run on the Netcup ingest host.
    parser_url: str = _env("PARSER_URL", "")
    parser_token: str = _env("PARSER_TOKEN", "")
    # Includes the entire document request, including time its slices spend in
    # the parser's fair queue.
    parser_timeout: int = int(_env("PARSER_TIMEOUT", "2400"))
    # Starts independently for each slice when a MinerU lane begins execution.
    # Queue wait and the execution time of other slices do not spend this budget.
    parse_slice_timeout: int = int(_env("CAPY_PARSE_SLICE_TIMEOUT", "600"))
    # The parser and ingest worker mount this directory on the Netcup ingest host.
    # Sources are job-scoped; parse bundles are fingerprint-addressed caches.
    parse_shared_dir: str = _env("CAPY_PARSE_SHARED_DIR", "/tmp/capy-parse-spool")
    # These are deliberately separate deadlines. A parser call must finish
    # before its Redis admission lease and parse-job bound. The continuation has
    # its own smaller budget for captions, embeddings, and final bookkeeping.
    parser_slot_ttl: int = int(_env("PARSER_SLOT_TTL", str(parser_timeout + 300)))
    parse_job_timeout: int = int(_env("CAPY_PARSE_JOB_TIMEOUT", "3600"))
    ingest_timeout: int = int(_env("CAPY_INGEST_TIMEOUT", "1200"))
    # Match the parser's hard cap: at most four document jobs can enqueue
    # independently sliced MinerU work at once.
    parse_fast_slots: int = int(_env("CAPY_PARSE_SLOTS", "4"))
    # MinerU pipeline chooses text extraction or OCR for each slice in auto mode.
    # The method remains part of the artifact fingerprint.
    parse_method: str = _env("CAPY_PARSE_METHOD", "auto")
    # LibreOffice output can be much larger than the compressed Office source.
    # Bound both the worker allocation and the platform preview object.
    office_preview_max_bytes: int = int(
        _env("CAPY_OFFICE_PREVIEW_MAX_BYTES", str(128 << 20))
    )
    # Parser artifacts cross a container boundary and may contain highly
    # compressed text/images in addition to an Office preview. Keep both the
    # local zip and its extracted form bounded independently of source bytes.
    parse_artifact_max_bytes: int = int(
        _env("CAPY_PARSE_ARTIFACT_MAX_BYTES", str(256 << 20))
    )
    parse_artifact_max_entries: int = int(
        _env("CAPY_PARSE_ARTIFACT_MAX_ENTRIES", "4096")
    )
    parse_artifact_max_entry_bytes: int = int(
        _env("CAPY_PARSE_ARTIFACT_MAX_ENTRY_BYTES", str(128 << 20))
    )
    parse_artifact_max_expanded_bytes: int = int(
        _env("CAPY_PARSE_ARTIFACT_MAX_EXPANDED_BYTES", str(512 << 20))
    )
    parse_content_max_bytes: int = int(
        _env("CAPY_PARSE_CONTENT_MAX_BYTES", str(128 << 20))
    )
    parse_content_max_blocks: int = int(_env("CAPY_PARSE_CONTENT_MAX_BLOCKS", "250000"))
    parse_image_max_bytes: int = int(_env("CAPY_PARSE_IMAGE_MAX_BYTES", str(32 << 20)))
    parse_images_max_bytes: int = int(
        _env("CAPY_PARSE_IMAGES_MAX_BYTES", str(256 << 20))
    )

    # ---- chunking ---------------------------------------------------------
    # Target size in estimated tokens (chunking.estimate_tokens: ~4 Latin
    # characters or 1 CJK character per token), not a real tokenizer: the
    # boundary decisions are structural (headings, blocks) and the bound is
    # approximate anyway. Counting tokens rather than characters is what keeps
    # a Chinese chunk the same size as an English one; by characters a CJK
    # chunk carried ~4x the tokens and five hits filled the tool-output cap.
    chunk_tokens: int = int(_env("CAPY_CHUNK_TOKENS", "400"))
    chunk_overlap_tokens: int = int(_env("CAPY_CHUNK_OVERLAP_TOKENS", "50"))
    chunk_min_tokens: int = int(_env("CAPY_CHUNK_MIN_TOKENS", "40"))

    # Width the seeded qwen-embed row emits. Fixtures use this for synthetic
    # vectors. A new model is a new rag_chunk_vectors_* table, not an env edit.
    embedding_dim: int = int(_env("EMBEDDING_DIM", "2560"))
    embedding_batch: int = int(_env("CAPY_EMBEDDING_BATCH", "64"))

    # ---- retrieval --------------------------------------------------------
    search_candidates: int = int(_env("CAPY_SEARCH_CANDIDATES", "40"))
    search_top_k: int = int(_env("CAPY_SEARCH_TOP_K", "5"))
    # Cap on chunks one file may contribute to a result set, so a textbook
    # whose every page mentions the query term cannot fill every slot. Kept one
    # below top_k: at 3 of 5 the lab corpus lost correct passages from the one
    # file that held the answer to fill slots with other files' noise
    # (hits@5 24 -> 26 of 28 going from 3 to 4; 5 was no better than 4).
    search_per_file_cap: int = int(_env("CAPY_SEARCH_PER_FILE_CAP", "4"))
    # Tool-calling rounds per chat turn. The loop is capped rather than
    # open-ended: the cost of a wrong plan is bounded. Each round re-sends the
    # whole transcript, so this is the main lever on chat spend.
    agent_max_steps: int = int(_env("CAPY_AGENT_MAX_STEPS", "12"))
    # Pre-model gathering budget when no catalog model has been selected yet.
    # Provider calls use the selected catalog row's required context window.
    llm_input_budget_tokens: int = int(_env("CAPY_LLM_INPUT_BUDGET_TOKENS", "50000"))

    # Every surviving figure is captioned — the filters in parse/figures.py, not
    # a count, are what bound the cost. This is a safety valve for a pathological
    # document, not a quality knob; 0 disables it.
    caption_max_per_file: int = int(_env("CAPY_CAPTION_MAX_PER_FILE", "0"))
    # Wall clock, not price, is the binding constraint: a slide deck can have
    # hundreds of figures and each call is ~1-2s.
    caption_concurrency: int = int(_env("CAPY_CAPTION_CONCURRENCY", "8"))
    # Longest edge sent to the vision model. Figures are re-encoded to JPEG at
    # this size, which is well past the resolution a caption needs and keeps the
    # image-token count (and the upload) small.
    caption_max_edge: int = int(_env("CAPY_CAPTION_MAX_EDGE", "1280"))
    # Bumped whenever the prompt, the model or the filters change, so cached
    # captions from an older definition are not reused.
    caption_version: str = _env("CAPY_CAPTION_VERSION", "v2")
    # Standalone image uploads use the same vision pin and caption definition
    # as parsed figures, but get a source-level artifact rather than a block
    # caption map. Decoded pixels are bounded independently of compressed
    # upload bytes.
    image_max_pixels: int = int(_env("CAPY_IMAGE_MAX_PIXELS", "100000000"))

    # Uploaded audio awaits ElevenLabs Scribe v2 in the ingest attempt. Starter
    # admits 12 weighted units; a call costs min(4, ceil(duration / 480 seconds)).
    elevenlabs_api_key: str = _env("ELEVENLABS_API_KEY", "")
    elevenlabs_base_url: str = _env("ELEVENLABS_BASE_URL", "https://api.elevenlabs.io")
    elevenlabs_sync_timeout_s: int = int(
        _env("CAPY_ELEVENLABS_SYNC_TIMEOUT_S", "43200")
    )
    elevenlabs_transcript_version: str = _env(
        "CAPY_ELEVENLABS_TRANSCRIPT_VERSION", "scribe-v2-1"
    )
    elevenlabs_concurrency_units: int = int(
        _env("CAPY_ELEVENLABS_CONCURRENCY_UNITS", "12")
    )
    audio_max_duration_seconds: int = int(
        _env("CAPY_AUDIO_MAX_DURATION_SECONDS", "36000")
    )

    # Shape of deterministic CSV/TSV row text. Bump to keep donor reuse honest
    # if header inference or row formatting changes.
    tabular_text_version: str = _env("CAPY_TABULAR_TEXT_VERSION", "v1")


cfg = Config()

if cfg.office_preview_max_bytes <= 0:
    raise ValueError("CAPY_OFFICE_PREVIEW_MAX_BYTES must be positive")

for key, value in (
    ("CAPY_PARSE_ARTIFACT_MAX_BYTES", cfg.parse_artifact_max_bytes),
    ("CAPY_PARSE_ARTIFACT_MAX_ENTRIES", cfg.parse_artifact_max_entries),
    ("CAPY_PARSE_ARTIFACT_MAX_ENTRY_BYTES", cfg.parse_artifact_max_entry_bytes),
    ("CAPY_PARSE_ARTIFACT_MAX_EXPANDED_BYTES", cfg.parse_artifact_max_expanded_bytes),
    ("CAPY_PARSE_CONTENT_MAX_BYTES", cfg.parse_content_max_bytes),
    ("CAPY_PARSE_CONTENT_MAX_BLOCKS", cfg.parse_content_max_blocks),
    ("CAPY_PARSE_IMAGE_MAX_BYTES", cfg.parse_image_max_bytes),
    ("CAPY_PARSE_IMAGES_MAX_BYTES", cfg.parse_images_max_bytes),
):
    if value <= 0:
        raise ValueError(f"{key} must be positive")

if cfg.image_max_pixels <= 0:
    raise ValueError("CAPY_IMAGE_MAX_PIXELS must be positive")

for key, value in (
    ("CAPY_PARSE_SLICE_TIMEOUT", cfg.parse_slice_timeout),
    ("CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S", cfg.interactive_provider_timeout_s),
    ("CAPY_INGEST_PROVIDER_TIMEOUT_S", cfg.ingest_provider_timeout_s),
    ("CAPY_ELEVENLABS_CONCURRENCY_UNITS", cfg.elevenlabs_concurrency_units),
    ("CAPY_ELEVENLABS_SYNC_TIMEOUT_S", cfg.elevenlabs_sync_timeout_s),
    ("CAPY_AUDIO_MAX_DURATION_SECONDS", cfg.audio_max_duration_seconds),
):
    if value <= 0:
        raise ValueError(f"{key} must be positive")

if cfg.parse_zip_ttl_hours <= 0 or cfg.parse_source_ttl_hours <= 0:
    raise ValueError("local parse spool TTLs must be positive")

if cfg.caption_cache_ttl_days <= 0:
    raise ValueError("CAPY_CAPTION_CACHE_TTL_DAYS must be positive")

if not cfg.parse_shared_dir.strip():
    raise ValueError("CAPY_PARSE_SHARED_DIR must not be empty")

if cfg.shared_capacity_lock_dir and not os.path.isabs(cfg.shared_capacity_lock_dir):
    raise ValueError("CAPY_SHARED_CAPACITY_LOCK_DIR must be an absolute path")

if not (
    cfg.parse_slice_timeout < cfg.parser_timeout
    and cfg.parser_timeout < cfg.parser_slot_ttl
    and cfg.parser_slot_ttl < cfg.parse_job_timeout
):
    raise ValueError(
        "parse time budgets must satisfy slice timeout < parser timeout < slot TTL < parse job timeout"
    )

if cfg.ingest_timeout <= 0:
    raise ValueError("CAPY_INGEST_TIMEOUT must be positive")

# The gateway fences each import attempt with a twelve-minute lease; a longer
# transfer would finish only to lose its completion.
if not 0 < cfg.import_job_timeout < 720:
    raise ValueError("CAPY_IMPORT_JOB_TIMEOUT must be between 1 and 719 seconds")

if not cfg.import_download_hosts:
    raise ValueError("CAPY_IMPORT_DOWNLOAD_HOSTS must name at least one host")

if not 1 <= cfg.parse_coordinator_concurrency <= 4:
    raise ValueError("CAPY_PARSE_COORDINATOR_CONCURRENCY must be between 1 and 4")

if cfg.db_sync_pool_max_size <= 0 or cfg.db_async_pool_max_size <= 0:
    raise ValueError("pipeline database pool limits must be positive")
