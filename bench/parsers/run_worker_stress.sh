#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "usage: $0 LANE METHOD TAG MEMORY_LIMIT|unbounded MEMORY_SWAP_LIMIT|unbounded CPU_LIMIT" >&2
  exit 2
fi

lane=$1
method=$2
tag=$3
memory_limit=$4
memory_swap_limit=$5
cpu_limit=$6
spool=/opt/evo-ingest/stress-spool
bench_root=/opt/evo-ingest/worker-stress-20260831
result_dir=/opt/evo-ingest/stress-results/worker-${tag}
parser_name=evo-worker-test-parser
release_sha=2725da1cbe39407786c9b3bdcd40fe68e0149046

if [[ ! $lane =~ ^(digital|mixed|mostly-ocr|ocr)$ ]]; then
  echo "unsupported lane: $lane" >&2
  exit 2
fi
if [[ ! $method =~ ^(auto|ocr|txt)$ ]]; then
  echo "unsupported method: $method" >&2
  exit 2
fi
if [[ $memory_limit == unbounded && $memory_swap_limit != unbounded ]]; then
  echo "memory swap limit requires a memory limit" >&2
  exit 2
fi
if [[ $memory_limit != unbounded && $memory_swap_limit == unbounded ]]; then
  echo "memory limit requires an explicit total memory-plus-swap limit" >&2
  exit 2
fi

mkdir -p "$result_dir"
sample_file=$result_dir/resources.csv
done_file=$result_dir/.done
rm -f "$done_file" "$sample_file"
printf 'epoch,host_mem_available_bytes,host_swap_used_bytes,parser_current_bytes,parser_peak_bytes' >"$sample_file"
for copy_number in 1 2 3 4; do
  printf ',worker_%s_current_bytes,worker_%s_peak_bytes' "$copy_number" "$copy_number" >>"$sample_file"
done
printf '\n' >>"$sample_file"

names=()
for copy_number in 1 2 3 4; do
  name=evo-worker-${tag}-${copy_number}
  names+=("$name")
  docker rm -f "$name" >/dev/null 2>&1 || true
  filename=${lane}-${copy_number}.pdf
  digest=$(sha256sum "$spool/sources/$filename" | awk '{print $1}')
  docker_args=(
    run -d --name "$name" --network host
    --pids-limit 128
    --cpus "$cpu_limit"
    -v "$spool:/var/lib/evo-parse"
    -v "$bench_root/bench/parsers/bench_worker_job.py:/bench_worker_job.py:ro"
    -e PARSER_URL=http://127.0.0.1:8090/file_parse
    -e PARSER_TOKEN=worker-stress-token
    -e RELEASE_SHA="$release_sha"
    -e EVO_PARSE_METHOD="$method"
    -e EVO_PARSE_SHARED_DIR=/var/lib/evo-parse
    -e PARSER_TIMEOUT=2400
    -e EVO_PARSE_SLICE_TIMEOUT=600
    -e EVO_CAPTION_CONCURRENCY=8
  )
  if [[ $memory_limit != unbounded ]]; then
    docker_args+=(--memory "$memory_limit" --memory-swap "$memory_swap_limit")
  fi
  docker_args+=(
    evo-worker-stress:current python /bench_worker_job.py
    --source-key "sources/$filename"
    --source-sha256 "$digest"
    --filename "$filename"
    --request-id "worker-$tag-$copy_number"
    --hold-seconds 30
  )
  docker "${docker_args[@]}" >/dev/null
done

sample_resources() {
  while [[ ! -e $done_file ]]; do
    mem_available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
    swap_total_kib=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
    swap_free_kib=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
    parser_current=$(docker exec "$parser_name" cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0)
    parser_peak=$(docker exec "$parser_name" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)
    printf '%s,%s,%s,%s,%s' \
      "$(date +%s)" \
      "$((mem_available_kib * 1024))" \
      "$(((swap_total_kib - swap_free_kib) * 1024))" \
      "$parser_current" \
      "$parser_peak" >>"$sample_file"
    for name in "${names[@]}"; do
      current=$(docker exec "$name" cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0)
      peak=$(docker exec "$name" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)
      printf ',%s,%s' "$current" "$peak" >>"$sample_file"
    done
    printf '\n' >>"$sample_file"
    sleep 1
  done
}

sample_resources &
sampler_pid=$!
for copy_number in 1 2 3 4; do
  name=${names[$((copy_number - 1))]}
  docker wait "$name" >"$result_dir/exit-${copy_number}.txt"
done
touch "$done_file"
wait "$sampler_pid"

for copy_number in 1 2 3 4; do
  name=${names[$((copy_number - 1))]}
  docker logs "$name" >"$result_dir/worker-${copy_number}.log" 2>&1
  docker inspect --format '{{json .State}}' "$name" >"$result_dir/state-${copy_number}.json"
  docker rm "$name" >/dev/null
done

docker run --rm -i \
  -v "$result_dir:/results:ro" \
  evo-worker-stress:current \
  python - /results/resources.csv /results <<'PY'
import csv
import json
import pathlib
import sys

sample_file = pathlib.Path(sys.argv[1])
result_dir = pathlib.Path(sys.argv[2])
rows = list(csv.DictReader(sample_file.open()))
required_columns = [
    "host_mem_available_bytes",
    "host_swap_used_bytes",
    "parser_current_bytes",
    *(f"worker_{copy_number}_peak_bytes" for copy_number in range(1, 5)),
]
rows = [
    row
    for row in rows
    if all((row.get(column) or "").isdigit() for column in required_columns)
]
summary = {
    "samples": len(rows),
    "minimum_host_available_bytes": min(int(row["host_mem_available_bytes"]) for row in rows),
    "maximum_host_swap_used_bytes": max(int(row["host_swap_used_bytes"]) for row in rows),
    "maximum_parser_current_bytes": max(int(row["parser_current_bytes"]) for row in rows),
}
for copy_number in range(1, 5):
    summary[f"worker_{copy_number}_peak_bytes"] = max(
        int(row[f"worker_{copy_number}_peak_bytes"]) for row in rows
    )
    summary[f"worker_{copy_number}_log"] = (result_dir / f"worker-{copy_number}.log").read_text().strip()
    summary[f"worker_{copy_number}_state"] = json.loads(
        (result_dir / f"state-{copy_number}.json").read_text()
    )
print(json.dumps(summary, indent=2))
PY
