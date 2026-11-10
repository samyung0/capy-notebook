# The layout service (layout/app.py). The float model comes in at build, from a
# pinned revision and SHA-256, and the first stage turns it into the int8 model
# the service runs (layout/quantise.py); the weights are never in the
# repository. Apache-2.0, bench/extraction/reports/2026-11-04-layout-models.md
# and 2026-11-10-layout-int8.md.
FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS model

WORKDIR /build
COPY layout/requirements-quantise.txt ./requirements.txt
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

ADD --chmod=644 --checksum=sha256:77afb2caa74dd13240d087d2eced91d7fcd2caebd16006a0a66162fc8707ff0e \
    https://huggingface.co/PaddlePaddle/PP-DocLayout_plus-L_onnx/resolve/feb74619326f634e0e883218598096a3733ad9f7/inference.onnx \
    /build/float.onnx
# The ranges belong to this revision: a new pin needs new calibration ranges.
COPY layout/quantise.py layout/calibration-ranges.json ./
RUN python quantise.py float.onnx int8.onnx

# The runtime image: the int8 model alone, with no quantisation package.
FROM python:3.12.16-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LAYOUT_MODEL_PATH=/opt/layout/inference.onnx

WORKDIR /app
COPY layout/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY --from=model --chmod=644 /build/int8.onnx /opt/layout/inference.onnx
# Some builders give the directory COPY creates the file's --chmod mode.
RUN chmod 755 /opt/layout
# Fails the build when a library the runtime needs is missing from this image.
RUN python -c "import onnxruntime as o; o.InferenceSession('/opt/layout/inference.onnx', providers=['CPUExecutionProvider'])"

COPY --chmod=644 layout/app.py ./app.py

RUN useradd --no-create-home --uid 10003 layout
USER layout

EXPOSE 8092
CMD ["uvicorn", "app:app", "--app-dir", "/app", "--host", "0.0.0.0", "--port", "8092", "--workers", "1", "--no-access-log", "--no-server-header"]
