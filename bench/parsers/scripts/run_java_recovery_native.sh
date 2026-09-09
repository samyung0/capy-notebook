#!/usr/bin/env bash
set -euo pipefail

root=${1:?pass the isolated experiment directory}
container=capy-java-recovery-eval
mkdir -p "$root/logs"

run_java() {
  local config=$1 suite=$2
  local run="$suite-$config"
  docker restart "$container" >/dev/null
  set +e
  timeout --signal=TERM --kill-after=30s 1800 \
    docker exec "$container" python /eval/scripts/compare_opendataloader.py /eval \
    --config "$config" --suite "$suite" --run "$run" --java-threads 1 --no-warmup \
    >"$root/logs/$run.log" 2>&1
  local status=$?
  set -e
  echo "$status" >"$root/logs/$run.exit"
}

run_java odl-java-headers screen
run_java odl-java-headers full
run_java odl-java-headers long
run_java odl-java-lines screen
run_java odl-java-order-off screen

for pair in 1280:2 2560:2 2560:8; do
  edge=${pair%:*}
  threads=${pair#*:}
  run="ocr-$edge-t$threads"
  docker restart "$container" >/dev/null
  set +e
  timeout --signal=TERM --kill-after=30s 900 \
    docker exec -e OMP_NUM_THREADS="$threads" -e MKL_NUM_THREADS="$threads" \
      -e OPENBLAS_NUM_THREADS="$threads" "$container" \
      python /eval/scripts/bench_java_recovery.py ocr \
      /eval/jobs-ocr-vm.json "/eval/$run" --kinds java \
      --models /baseline/models/docling/RapidOcr --max-edge "$edge" --threads "$threads" \
      >"$root/logs/$run.log" 2>&1
  status=$?
  set -e
  echo "$status" >"$root/logs/$run.exit"
done

docker restart "$container" >/dev/null
