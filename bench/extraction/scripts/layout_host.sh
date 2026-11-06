#!/bin/sh
# Layout-model runs on the ingest host (bench/extraction/reports/2026-11-04-layout-models.md).
#
# Setup, done by hand once, as the report describes:
#   /opt/capy-layout-bench-20261104/{data,gold,scripts}: the four HKDSE PDFs,
#   the gold files and layout_detect.py, copied with scp; venvs onnx, paddle and
#   torch and the model weights under venvs/ and models/, installed from a
#   networked container; then the bench container, with no network, at the
#   parser's production limits:
#     docker run -d --name capy-layout-bench --network none --cpus 8 \
#       --memory 14g --memory-swap 18g -v /opt/capy-layout-bench-20261104:/work \
#       -e HF_HUB_OFFLINE=1 -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
#       capy-layout-bench:20261104 sleep infinity
#
# Run on the host: sh /opt/capy-layout-bench-20261104/scripts/layout_host.sh
# The born-digital pages: PAGES=pages-digital OUT=out-digital PASSES=1 sh ...
# Each model runs in its own process, one after another; the host's load and
# the containers' CPU are logged before each.
set -eu
D=/opt/capy-layout-bench-20261104
OUT=${OUT:-out}
PAGES=${PAGES:-pages}
PASSES=${PASSES:-2}
run() {
  name=$1 venv=$2 backend=$3 model=$4 path=$5 threads=$6
  {
    echo "== $name threads=$threads $(date -u +%H:%M:%S) load $(cut -d' ' -f1-3 /proc/loadavg)"
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | grep -v capy-layout-bench
  } >>"$D/$OUT/host-load.log"
  docker exec capy-layout-bench "/work/venvs/$venv/bin/python" \
    /work/scripts/layout_detect.py detect --backend "$backend" --model "$model" \
    --path "/work/models/$path" --pages "/work/$PAGES" --threads "$threads" \
    --passes "$PASSES" --out "/work/$OUT/$name.json" >"$D/$OUT/$name.log" 2>&1
  tail -1 "$D/$OUT/$name.log"
}
mkdir -p "$D/$OUT"
run pp-plus-l-onnx onnx pp-onnx PP-DocLayout_plus-L PP-DocLayout_plus-L_onnx 8
run pp-v2-onnx onnx pp-onnx PP-DocLayoutV2 PP-DocLayoutV2_onnx 8
run pp-v3-onnx onnx pp-onnx PP-DocLayoutV3 PP-DocLayoutV3_onnx 8
run heron-onnx onnx heron-onnx docling-layout-heron docling-layout-heron-onnx 8
run pp-l-paddle paddle paddle PP-DocLayout-L PP-DocLayout-L 8
run pp-plus-l-paddle paddle paddle PP-DocLayout_plus-L PP-DocLayout_plus-L 8
run pp-m-paddle paddle paddle PP-DocLayout-M PP-DocLayout-M 8
run heron-torch torch torch docling-layout-heron docling-layout-heron 8
run heron-101-torch torch torch docling-layout-heron-101 docling-layout-heron-101 8
# One thread: the CPU a page costs when pages run side by side.
run pp-plus-l-onnx-t1 onnx pp-onnx PP-DocLayout_plus-L PP-DocLayout_plus-L_onnx 1
run pp-v2-onnx-t1 onnx pp-onnx PP-DocLayoutV2 PP-DocLayoutV2_onnx 1
run heron-onnx-t1 onnx heron-onnx docling-layout-heron docling-layout-heron-onnx 1
