# Pipeline image — ingest worker or retrieval service (compose overrides
# `command`). CPU Marker and RapidOCR parsing run on Modal, so this image does
# not include those parser models. Build from the repository root so uv can copy the lockfile.
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /uvx /bin/

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
COPY pipeline ./pipeline
COPY server/internal/models/elitellm_providers.json ./server/internal/models/elitellm_providers.json
RUN uv sync --frozen --no-dev --no-editable
ENV PATH="/app/.venv/bin:$PATH"

# Default role: the ingest worker (compose overrides for the retrieval service).
CMD ["python", "-m", "pipeline.ingest.worker"]
