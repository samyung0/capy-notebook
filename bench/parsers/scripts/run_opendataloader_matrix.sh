#!/usr/bin/env bash
# Run on the authorized idle ingest VM after corpus preparation and model download.
set -euo pipefail
root=${1:?experiment directory required}
shift
mkdir -p "$root/logs"
docker restart capy-mineru-eval capy-odl-eval >/dev/null
case " $* " in
  *easy*)
    for language in ch_sim ch_tra ja; do
      docker exec capy-odl-eval docling-tools models download easyocr \
        --easyocr-lang "$language" --easyocr-lang en \
        --output-dir /eval/models/docling \
        >"$root/logs/prepare-easyocr-$language.log" 2>&1
    done
    ;;
esac
for config in "$@"; do
  case "$config" in
    mineru-*) container=capy-mineru-eval ;;
    odl-*) container=capy-odl-eval ;;
    *) echo "Unknown configuration: $config" >&2; exit 2 ;;
  esac
  run="${RUN_PREFIX:-screen}-$config"
  extra=()
  if [[ "$config" == "odl-java-tags" ]]; then
    # Page slicing discards the root structure tree. Test intact tagged files.
    run="tags-$config"
    extra=(--ids rag__zh__mixed_zh_en rag__zh__zh_HK rag__es__variedades-espanol)
  fi
  docker restart "$container" >/dev/null
  # Per-document hard deadlines live in the runner; this bounds an entire pass.
  set +e
  timeout --signal=TERM --kill-after=30s 5400 \
    docker exec "$container" python /eval/scripts/compare_opendataloader.py /eval \
      --config "$config" --suite screen --run "$run" "${extra[@]}" \
      >"$root/logs/$run.log" 2>&1
  status=$?
  set -e
  echo "$status" >"$root/logs/$run.exit"
  # A timed-out native parser may leave children. Always reset our test container.
  docker restart "$container" >/dev/null
done
