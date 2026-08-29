# CPU-only parser benchmark image (Marker v2 + Docling).
#
# Build once, then pin cores at run time so the numbers map to a rentable VM:
#   docker build -t evo-parse-bench bench/parsers
#   docker run --rm --cpus=4 -v ...:/bench/docs:ro -v ...:/out -v evo-parse-models:/models evo-parse-bench --threads 4
#
# Nothing here needs an API key. Both parsers run fully local; the only network
# access is the one-time model download from Hugging Face into /models.
FROM python:3.12-slim

# libgl1/libglib2.0-0 support OpenCV; libgomp1 supports onnxruntime's OpenMP
# runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Marker v2's `fast` mode is NOT GPU-locked: on CPU it serves the surya VLM
# through llama.cpp, and the CLI hard-fails at startup if `llama-server` is
# missing. Without this the only runnable CPU mode is `fast --disable_ocr`,
# which is the weakest accuracy tier — so this binary is what makes the
# interesting comparison possible at all.
RUN set -eux; \
    url="$(curl -fsSL https://api.github.com/repos/ggml-org/llama.cpp/releases/latest \
        | grep -oE 'https://[a-zA-Z0-9._/-]+bin-ubuntu-x64\.tar\.gz' | head -n1)"; \
    test -n "$url"; \
    echo "llama.cpp asset: $url"; \
    curl -fsSL -o /tmp/llama.tar.gz "$url"; \
    mkdir -p /opt/llama; \
    tar -xzf /tmp/llama.tar.gz -C /opt/llama; \
    rm /tmp/llama.tar.gz; \
    bin="$(find /opt/llama -type f -name llama-server | head -n1)"; \
    test -n "$bin"; \
    chmod +x "$bin"; \
    ln -sf "$bin" /usr/local/bin/llama-server; \
    dirname "$bin" > /etc/ld.so.conf.d/llama.conf; \
    ldconfig; \
    llama-server --version || true
ENV LLAMA_CPP_BINARY=/usr/local/bin/llama-server

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models \
    TORCH_HOME=/models/torch \
    EASYOCR_MODULE_PATH=/models/easyocr

# CPU-only torch FIRST and from the CPU index, so the marker/docling installs
# below resolve against it instead of dragging in ~2.5 GB of CUDA wheels that
# would never be used on a CPU VM.
RUN pip install --no-cache-dir torch torchvision \
    --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir \
    "marker-pdf[full]" \
    docling \
    rapidocr-onnxruntime \
    onnxruntime \
    pypdfium2

WORKDIR /bench
COPY normalize.py run_bench.py fetch_samples.py ./
RUN mkdir -p /bench/docs /out /models

ENTRYPOINT ["python", "run_bench.py"]
