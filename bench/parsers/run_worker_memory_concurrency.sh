#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "usage: $0 REPLICAS CONTENT_MIB MEMORY_LIMIT MEMORY_SWAP_LIMIT CPU_LIMIT HOLD_SECONDS" >&2
  exit 2
fi

replicas=$1
content_mib=$2
memory_limit=$3
memory_swap_limit=$4
cpu_limit=$5
hold_seconds=$6
fixture_root=/opt/evo-ingest/stress-current/worker-memory
bench_script=/opt/evo-ingest/worker-stress-20260831/bench/parsers/bench_worker_memory.py

names=()
for worker_number in $(seq 1 "$replicas"); do
  name="evo-worker-memory-${content_mib}-${worker_number}"
  names+=("$name")
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d \
    --name "$name" \
    --memory "$memory_limit" \
    --memory-swap "$memory_swap_limit" \
    --cpus "$cpu_limit" \
    --pids-limit 128 \
    -v "$fixture_root:/fixtures:ro" \
    -v "$bench_script:/bench_worker_memory.py:ro" \
    evo-worker-stress:current \
    python /bench_worker_memory.py load \
      --input "/fixtures/content-${content_mib}.json" \
      --hold-seconds "$hold_seconds" >/dev/null
done

minimum_available_bytes=9223372036854775807
maximum_swap_bytes=0
running=true
while [[ $running == true ]]; do
  available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  swap_total_kib=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
  swap_free_kib=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
  available_bytes=$((available_kib * 1024))
  swap_bytes=$(((swap_total_kib - swap_free_kib) * 1024))
  if (( available_bytes < minimum_available_bytes )); then
    minimum_available_bytes=$available_bytes
  fi
  if (( swap_bytes > maximum_swap_bytes )); then
    maximum_swap_bytes=$swap_bytes
  fi
  running=false
  for name in "${names[@]}"; do
    if [[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]]; then
      running=true
      break
    fi
  done
  sleep 0.1
done

printf 'replicas=%s content_mib=%s minimum_host_available_bytes=%s maximum_host_swap_bytes=%s\n' \
  "$replicas" "$content_mib" "$minimum_available_bytes" "$maximum_swap_bytes"
for name in "${names[@]}"; do
  docker inspect --format '{{json .State}}' "$name"
  docker logs "$name" 2>&1 || true
  docker rm "$name" >/dev/null
done
