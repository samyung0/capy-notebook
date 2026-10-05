# Pipeline image — parse coordinator, ingest worker, or retrieval service
# (compose overrides `command`). Document parsing runs in the separate persistent
# parser image; this image carries PyMuPDF for heading retention, extraction
# confidence and page captures. Build from the repository
# root so uv can copy the lockfile.

# ppt-master (MIT, Copyright (c) 2025-2026 Hugo He) checks and exports the
# slides of a chat deck (pipeline/retrieval/deck.py). The whole checkout at
# deck.PPT_MASTER_COMMIT, less icons, sounds and image-model comparison sheets
# as the playground clones it (its attribution guard refuses a partial copy),
# with deck.PPT_MASTER_DEPS in their own virtualenv; the retrieval service runs
# its two scripts as subprocesses. test_deck.py keeps these pins in step.
FROM python:3.11-slim AS ppt-master
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /bin/
ARG PPT_MASTER_COMMIT=44c10ed0bc3a9e1df7a25aa179ae7c26db09469b
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --quiet --filter=blob:none --no-checkout \
        https://github.com/hugohe3/ppt-master.git /opt/ppt-master \
    && git -C /opt/ppt-master sparse-checkout set --no-cone skills/ppt-master \
        '!skills/ppt-master/templates/icons/' '!skills/ppt-master/templates/sounds/' \
        '!skills/ppt-master/references/ai-image-comparison/' \
    && git -C /opt/ppt-master checkout --quiet "$PPT_MASTER_COMMIT" \
    && rm -rf /opt/ppt-master/.git
RUN uv venv --python /usr/local/bin/python3 /opt/ppt-master/.venv \
    && uv pip install --no-cache --python /opt/ppt-master/.venv/bin/python \
        python-pptx lxml pillow fonttools pyyaml xlsxwriter skia-pathops uharfbuzz

FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /uvx /bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy

# Dependencies first so a source change reuses the installed venv layer.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY pipeline ./pipeline
COPY server/internal/models/elitellm_providers.json ./server/internal/models/elitellm_providers.json
COPY server/internal/sourceupload/text_extensions.json ./server/internal/sourceupload/text_extensions.json
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable
COPY --from=ppt-master /opt/ppt-master /opt/ppt-master
# Retrieval diagnostics run inside this image via `docker compose exec`.
COPY bench/rag/scripts ./bench/rag/scripts
COPY bench/rag/fixtures ./bench/rag/fixtures
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app/pipeline"

# RELEASE_SHA changes every deployment; keep it below every cacheable layer.
ARG RELEASE_SHA=dev
LABEL org.opencontainers.image.revision=$RELEASE_SHA
ENV RELEASE_SHA=$RELEASE_SHA

# Default role: the ingest worker (compose overrides for the retrieval service).
CMD ["python", "-m", "pipeline.ingest.worker"]
