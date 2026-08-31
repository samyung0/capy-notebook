# Pipeline image — parse coordinator, ingest worker, or retrieval service
# (compose overrides `command`). CPU MinerU runs in the separate persistent parser
# image, so this image does not include those models. Build from the repository
# root so uv can copy the lockfile.
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /uvx /bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ARG RELEASE_SHA=dev
LABEL org.opencontainers.image.revision=$RELEASE_SHA

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV RELEASE_SHA=$RELEASE_SHA
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
COPY pipeline ./pipeline
COPY server/internal/models/elitellm_providers.json ./server/internal/models/elitellm_providers.json
COPY server/internal/sourceupload/text_extensions.json ./server/internal/sourceupload/text_extensions.json
RUN uv sync --frozen --no-dev --no-editable
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH="/app/pipeline"

# Default role: the ingest worker (compose overrides for the retrieval service).
CMD ["python", "-m", "pipeline.ingest.worker"]
