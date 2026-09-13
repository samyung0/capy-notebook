FROM python:3.12.14-slim-bookworm@sha256:0f5b26b9518d002b6173fd61daad821fa340635ebfec5bba471013f9ca114579

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/run/capy-parser/home \
    OMP_NUM_THREADS=8 \
    CAPY_RAPIDOCR_MODEL_DIR=/models/rapidocr \
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
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer \
        openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY parser/requirements.txt ./parser/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r parser/requirements.txt

# RapidOCR PP-OCRv6 small detector/recogniser and the mobile angle classifier,
# the exact files the September 2026 lab runs used (rapidocr 3.9.2's own hosts).
RUN mkdir -p /models/rapidocr && cd /models/rapidocr \
    && curl -fsSL -o PP-OCRv6_det_small.onnx \
        https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx \
    && curl -fsSL -o PP-OCRv6_rec_small.onnx \
        https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx \
    && curl -fsSL -o ch_ppocr_mobile_v2.0_cls_mobile.onnx \
        https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx \
    && printf '%s\n' \
        '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f  PP-OCRv6_det_small.onnx' \
        '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884  PP-OCRv6_rec_small.onnx' \
        'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c  ch_ppocr_mobile_v2.0_cls_mobile.onnx' \
        | sha256sum -c -

# The reading-order model used by the frozen OCR checks, loaded only for OCR.
RUN curl -fsSL -o /models/rapidocr/pp_doc_layoutv3.onnx \
        https://www.modelscope.cn/models/RapidAI/RapidLayout/resolve/v1.2.0/onnx/pp_doc_layout/pp_doc_layoutv3.onnx \
    && printf '%s\n' \
        '250dbad1dfb9e4983fab75e1bf5085cd56ec3f41d5c7d0f8623ec74856e7aa67  /models/rapidocr/pp_doc_layoutv3.onnx' \
        | sha256sum -c -

# RELEASE_SHA sits below every cacheable layer so a new commit rebuilds only the
# source copy (Coolify must not inject build args above).
ARG RELEASE_SHA
RUN test "$(printf %s "$RELEASE_SHA" | wc -c)" -eq 40 \
    && ! printf %s "$RELEASE_SHA" | grep -q '[^0-9a-f]'
LABEL org.opencontainers.image.revision=$RELEASE_SHA
ENV RELEASE_SHA=$RELEASE_SHA

# The ingest host clones the build context under umask 077, so copy the runtime
# sources with an explicit mode: USER parser below cannot read 0600 root files.
COPY --chmod=644 parser/app.py ./parser/
COPY --chmod=644 parser/odl/ ./parser/odl/
RUN chmod 755 /app/parser/odl

RUN useradd --create-home --uid 10001 parser \
    && mkdir -p /run/capy-parser/home /run/capy-parser/work \
    && chown -R parser:parser /run/capy-parser
USER parser

EXPOSE 8090
CMD ["uvicorn", "app:app", "--app-dir", "/app/parser", "--host", "0.0.0.0", "--port", "8090", "--workers", "1"]
