# Pipeline image — runs as either the ingest worker or the retrieval service
# (compose overrides `command`). GPU-heavy MineRU parsing lives on Modal, so this
# image stays CPU-only and lightweight.
FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY pyproject.toml ./
COPY pipeline ./pipeline
RUN pip install --no-cache-dir .

# Default role: the ingest worker (compose overrides for the retrieval service).
CMD ["python", "-m", "pipeline.ingest.worker"]
