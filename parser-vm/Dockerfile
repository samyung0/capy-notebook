FROM python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1

ARG RELEASE_SHA
RUN test "$(printf %s "$RELEASE_SHA" | wc -c)" -eq 40 \
    && ! printf %s "$RELEASE_SHA" | grep -q '[^0-9a-f]'

LABEL org.opencontainers.image.revision=$RELEASE_SHA

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/models/huggingface \
    HF_HUB_CACHE=/models/huggingface \
    MODEL_CACHE_DIR=/models/datalab \
    FONT_DIR=/models/fonts \
    OUTPUT_DIR=/run/evo-parser/output \
    DEBUG_DATA_FOLDER=/run/evo-parser/debug \
    TORCHINDUCTOR_COMPILE_THREADS=1 \
    TOKENIZERS_PARALLELISM=false \
    SURYA_INFERENCE_AUTOSTART=false \
    CUDA_VISIBLE_DEVICES="" \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    RELEASE_SHA=$RELEASE_SHA \
    PYTHONPATH=/app/modal:/app/parser-vm

COPY parser-vm/debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        fonts-dejavu-core \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        libopenjp2-7 \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY parser-vm/requirements.txt ./parser-vm/requirements.txt
RUN pip install --no-cache-dir --require-hashes \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r parser-vm/requirements.txt

COPY modal/marker_adapt.py modal/marker_worker.py modal/scan_pages.py ./modal/
COPY parser-vm/app.py ./parser-vm/app.py

RUN useradd --create-home --uid 10001 parser \
    && mkdir -p /models/fonts /run/evo-parser/output /run/evo-parser/debug \
    && ln -s /models /usr/local/lib/python3.11/site-packages/static \
    && chown -R parser:parser /models /run/evo-parser
USER parser

EXPOSE 8090
CMD ["uvicorn", "app:app", "--app-dir", "/app/parser-vm", "--host", "0.0.0.0", "--port", "8090", "--workers", "1"]
