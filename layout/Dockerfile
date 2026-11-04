# The layout service (layout/app.py). The model comes in at build, from a pinned
# revision and SHA-256; the weights are never in the repository. Apache-2.0,
# bench/extraction/reports/2026-11-04-layout-models.md.
FROM python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LAYOUT_MODEL_PATH=/opt/layout/inference.onnx

WORKDIR /app
COPY layout/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

ADD --chmod=644 --checksum=sha256:77afb2caa74dd13240d087d2eced91d7fcd2caebd16006a0a66162fc8707ff0e \
    https://huggingface.co/PaddlePaddle/PP-DocLayout_plus-L_onnx/resolve/feb74619326f634e0e883218598096a3733ad9f7/inference.onnx \
    /opt/layout/inference.onnx
# Fails the build when a library the runtime needs is missing from this image.
RUN python -c "import onnxruntime as o; o.InferenceSession('/opt/layout/inference.onnx', providers=['CPUExecutionProvider'])"

COPY --chmod=644 layout/app.py ./app.py

RUN useradd --no-create-home --uid 10003 layout
USER layout

EXPOSE 8092
CMD ["uvicorn", "app:app", "--app-dir", "/app", "--host", "0.0.0.0", "--port", "8092", "--workers", "1", "--no-access-log", "--no-server-header"]
