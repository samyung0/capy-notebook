FROM python:3.12.14-slim-bookworm@sha256:0f5b26b9518d002b6173fd61daad821fa340635ebfec5bba471013f9ca114579

ARG RELEASE_SHA
RUN test "$(printf %s "$RELEASE_SHA" | wc -c)" -eq 40 \
    && ! printf %s "$RELEASE_SHA" | grep -q '[^0-9a-f]'

LABEL org.opencontainers.image.revision=$RELEASE_SHA

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/models/config \
    HF_HOME=/models/huggingface \
    HF_HUB_CACHE=/models/huggingface \
    TORCH_HOME=/models/torch \
    MINERU_DEVICE_MODE=cpu \
    MINERU_API_OUTPUT_ROOT=/run/evo-parser/output \
    MINERU_PROCESSING_WINDOW_SIZE=26 \
    MINERU_INTRA_OP_NUM_THREADS=2 \
    MINERU_INTER_OP_NUM_THREADS=1 \
    TOKENIZERS_PARALLELISM=false \
    CUDA_VISIBLE_DEVICES="" \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    RELEASE_SHA=$RELEASE_SHA \
    PYTHONPATH=/app/parser

COPY parser/debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        fonts-dejavu-core \
        fonts-noto-core \
        fonts-noto-cjk \
        fontconfig \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        libopenjp2-7 \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY parser/requirements.txt ./parser/requirements.txt
RUN pip install --no-cache-dir --require-hashes \
        -r parser/requirements.txt

COPY parser/app.py parser/mineru_worker.py ./parser/

RUN useradd --create-home --uid 10001 parser \
    && mkdir -p /models/config /models/huggingface /models/torch /run/evo-parser/output \
    && chown -R parser:parser /models /run/evo-parser
USER parser

EXPOSE 8090
CMD ["uvicorn", "app:app", "--app-dir", "/app/parser", "--host", "0.0.0.0", "--port", "8090", "--workers", "1"]
