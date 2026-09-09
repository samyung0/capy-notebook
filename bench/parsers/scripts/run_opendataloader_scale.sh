#!/usr/bin/env bash
# Sequential full-document, long-document and warm-capacity comparisons.
set -euo pipefail
root=${1:?experiment directory required}
mkdir -p "$root/logs"

docker restart capy-mineru-eval capy-odl-eval >/dev/null
for quantize in --quantize --no-quantize; do
  set +e
  timeout --signal=TERM --kill-after=30s 300 \
    docker exec capy-odl-eval python /eval/scripts/probe_opendataloader_easyocr.py \
      /eval --id raster__rag__zh__zh-CN --page 0 --lang ch_sim,en "$quantize" \
      >"$root/logs/easyocr-probe$quantize.log" 2>&1
  status=$?
  set -e
  echo "$status" >"$root/logs/easyocr-probe$quantize.exit"
  docker restart capy-odl-eval >/dev/null
done

run_case() {
  local config=$1 run=$2 script=$3
  shift 3
  local container=capy-odl-eval
  [[ "$config" == mineru-* ]] && container=capy-mineru-eval
  docker restart capy-mineru-eval capy-odl-eval >/dev/null
  set +e
  timeout --signal=TERM --kill-after=30s 5400 \
    docker exec -e OMP_NUM_THREADS="${CPU_THREADS:-2}" \
      -e MKL_NUM_THREADS="${CPU_THREADS:-2}" \
      -e OPENBLAS_NUM_THREADS="${CPU_THREADS:-2}" \
      "$container" python "/eval/scripts/$script" /eval \
      --config "$config" --run "$run" "$@" >"$root/logs/$run.log" 2>&1
  local status=$?
  set -e
  echo "$status" >"$root/logs/$run.exit"
  docker restart "$container" >/dev/null
}

for config in odl-java-cluster mineru-auto odl-full-rapid-autoocr; do
  run_case "$config" "full-$config" compare_opendataloader.py \
    --suite full --timeout 900 --no-warmup
  run_case "$config" "long-$config" compare_opendataloader.py \
    --suite long --timeout 2400 --no-warmup
done

run_case odl-full-rapid full-odl-full-rapid compare_opendataloader.py \
  --suite full --timeout 900 --no-warmup
run_case odl-full-rapid-autoocr long-sliced-odl-full-rapid-autoocr \
  compare_opendataloader.py --suite long --timeout 2400 --no-warmup \
  --odl-slice-pages 26 --slice-workers 4 --hybrid-workers 4
run_case odl-java tags-control-odl-java compare_opendataloader.py \
  --ids rag__zh__mixed_zh_en rag__zh__zh_HK rag__es__variedades-espanol

for config in mineru-auto odl-full-rapid-autoocr; do
  for lane in digital ocr; do
    for parallel in 1 4; do
      run_case "$config" "capacity-$config-$lane-p$parallel" \
        bench_opendataloader_capacity.py --id "capacity__$lane" \
        --parallel "$parallel" --repeats 3 --timeout 900
    done
  done
done

for lane in digital ocr; do
  run_case odl-full-rapid-autoocr "capacity-odl-full-rapid-autoocr-$lane-p4-b4" \
    bench_opendataloader_capacity.py --id "capacity__$lane" \
    --parallel 4 --hybrid-workers 4 --repeats 3 --timeout 900
done

for threads in 1 2 8; do
  run_case odl-java-cluster "threads-java-$threads" \
    bench_opendataloader_capacity.py --id capacity__digital \
    --parallel 1 --repeats 3 --java-threads "$threads"
done

# Check whether allocating the whole CPU to a single hybrid request helps.
for lane in digital ocr; do
  CPU_THREADS=8 run_case odl-full-rapid-autoocr "threads-rapid-$lane-8" \
    bench_opendataloader_capacity.py --id "capacity__$lane" \
    --parallel 1 --repeats 3 --timeout 900
done
CPU_THREADS=8 run_case odl-full-easy-autoocr threads-easy-8 \
  compare_opendataloader.py --ids screen__biology-accuracy-sample \
    raster__rag__zh__zh_HK raster__rag__ja__jp_llm raster__rag__en__biology-ib-chapter-1

# Language-aware OCR is an upper-bound control: it uses known fixture languages.
docker restart capy-mineru-eval capy-odl-eval >/dev/null
docker exec capy-odl-eval docling-tools models download rapidocr \
  --rapidocr-backend-lang onnxruntime:ch --rapidocr-backend-lang onnxruntime:japan \
  --rapidocr-backend-lang onnxruntime:en --rapidocr-backend-lang onnxruntime:de \
  --rapidocr-backend-lang onnxruntime:fr --rapidocr-backend-lang onnxruntime:es \
  --output-dir /eval/models/docling >"$root/logs/prepare-rapidocr-languages.log" 2>&1
run_case odl-full-rapid-lang screen-odl-full-rapid-lang compare_opendataloader.py \
  --suite screen --timeout 600
run_case odl-auto-easy recheck-odl-auto-easy compare_opendataloader.py \
  --suite screen --timeout 600

# The native wrapper documents page-parallel output as experimental.
for config in odl-java odl-java-cluster; do
  run_case "$config" "screen-$config-t1" compare_opendataloader.py \
    --suite screen --java-threads 1
done
run_case odl-java-cluster full-odl-java-cluster-t1 compare_opendataloader.py \
  --suite full --java-threads 1 --no-warmup
run_case odl-java-cluster long-odl-java-cluster-t1 compare_opendataloader.py \
  --suite long --java-threads 1 --no-warmup
