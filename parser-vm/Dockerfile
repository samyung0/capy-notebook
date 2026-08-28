FROM python:3.11-slim-bookworm

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
    PYTHONPATH=/app/modal:/app/parser-vm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        fonts-dejavu-core \
        libgl1 \
        libglib2.0-0 \
        libgomp1 \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY parser-vm/requirements.txt ./parser-vm/requirements.txt
RUN pip install --no-cache-dir \
        --index-url https://download.pytorch.org/whl/cpu \
        torch==2.13.0+cpu \
        torchvision==0.28.0+cpu
RUN pip install --no-cache-dir -r parser-vm/requirements.txt

COPY modal/marker_adapt.py modal/marker_worker.py modal/scan_pages.py ./modal/
COPY parser-vm/app.py ./parser-vm/app.py

RUN useradd --create-home --uid 10001 parser \
    && mkdir -p /models/fonts /run/evo-parser/output /run/evo-parser/debug \
    && ln -s /models /usr/local/lib/python3.11/site-packages/static \
    && chown -R parser:parser /models /run/evo-parser
USER parser

EXPOSE 8090
CMD ["uvicorn", "app:app", "--app-dir", "/app/parser-vm", "--host", "0.0.0.0", "--port", "8090", "--workers", "1"]
