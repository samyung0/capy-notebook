#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 MEMORY_LIMIT MEMORY_SWAP_LIMIT CPU_LIMIT" >&2
  exit 2
fi

memory_limit=$1
memory_swap_limit=$2
cpu_limit=$3
fixture_root=/opt/capy-ingest/stress-current/worker-memory
bench_script=/opt/capy-ingest/worker-stress-20260831/bench/parsers/bench_worker_memory.py

for mib in ${MIBS:-32 64 96 120}; do
  name="capy-worker-memory-${mib}"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d \
    --name "$name" \
    --memory "$memory_limit" \
    --memory-swap "$memory_swap_limit" \
    --cpus "$cpu_limit" \
    --pids-limit 128 \
    -v "$fixture_root:/fixtures:ro" \
    -v "$bench_script:/bench_worker_memory.py:ro" \
    capy-worker-stress:current \
    python /bench_worker_memory.py load \
      --input "/fixtures/content-${mib}.json" \
      --hold-seconds 5 >/dev/null

  peak=0
  swap_peak=0
  events=""
  while [[ $(docker inspect --format '{{.State.Running}}' "$name") == true ]]; do
    current=$(docker exec "$name" cat /sys/fs/cgroup/memory.peak 2>/dev/null || true)
    swap_current=$(docker exec "$name" cat /sys/fs/cgroup/memory.swap.peak 2>/dev/null || true)
    [[ $current =~ ^[0-9]+$ ]] || current=0
    [[ $swap_current =~ ^[0-9]+$ ]] || swap_current=0
    if (( current > peak )); then
      peak=$current
    fi
    if (( swap_current > swap_peak )); then
      swap_peak=$swap_current
    fi
    events=$(docker exec "$name" cat /sys/fs/cgroup/memory.events 2>/dev/null || true)
    sleep 0.1
  done

  state=$(docker inspect --format '{{json .State}}' "$name")
  log=$(docker logs "$name" 2>&1 || true)
  printf 'target_mib=%s sampled_peak_bytes=%s sampled_swap_peak_bytes=%s state=%s events=%q\n' \
    "$mib" "$peak" "$swap_peak" "$state" "$events"
  printf '%s\n' "$log"
  docker rm "$name" >/dev/null
done
