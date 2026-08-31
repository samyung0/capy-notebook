#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 UNIQUE_TAG" >&2
  exit 2
fi

tag=$1
spool=/opt/evo-ingest/stress-spool
bench_root=/opt/evo-ingest/worker-stress-20260831
parser_name=evo-overlap-parser
release_sha=2725da1cbe39407786c9b3bdcd40fe68e0149046
parse_names=()

cleanup() {
  for name in "${parse_names[@]}" evo-overlap-warm "$parser_name"; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

docker rm -f "$parser_name" >/dev/null 2>&1 || true
docker run -d \
  --name "$parser_name" \
  --network host \
  --memory 14g \
  --memory-swap 18g \
  --cpus 8 \
  --pids-limit 256 \
  -v "$spool:/var/lib/evo-parse" \
  -e PARSER_BIND_ADDRESS=127.0.0.1 \
  -e PARSER_TOKEN=worker-stress-token \
  -e EVO_PARSE_CONCURRENCY=4 \
  -e EVO_MINERU_SLICE_PAGES=26 \
  -e EVO_PARSE_SLICE_TIMEOUT=600 \
  -e EVO_PARSE_SHARED_DIR=/var/lib/evo-parse \
  -e RELEASE_SHA="$release_sha" \
  evo-parser-stress:current \
  uvicorn app:app --app-dir /app/parser --host 127.0.0.1 --port 8090 --workers 1 \
  >/dev/null

for _ in $(seq 1 180); do
  if docker exec "$parser_name" curl --fail --silent http://127.0.0.1:8090/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$parser_name" curl --fail --silent http://127.0.0.1:8090/healthz

build_fixture_set() {
  local fixture_tag=$1
  local output_dir=$2
  docker run --rm \
    -v "$spool:/spool" \
    -v "$bench_root/bench/parsers/build_worker_stress_fixtures.py:/build_fixtures.py:ro" \
    evo-parser-stress:current \
    python /build_fixtures.py \
      --digital /spool/sources/digital-1.pdf \
      --ocr /spool/sources/ocr-1.pdf \
      --output-dir "/spool/$output_dir" \
      --tag "$fixture_tag" >/dev/null
}

run_parse_worker() {
  local name=$1
  local source_key=$2
  local request_id=$3
  local digest
  digest=$(sha256sum "$spool/$source_key" | awk '{print $1}')
  docker run -d \
    --name "$name" \
    --network host \
    --memory 1g \
    --memory-swap 1g \
    --cpus 1 \
    --pids-limit 128 \
    -v "$spool:/var/lib/evo-parse" \
    -v "$bench_root/bench/parsers/bench_worker_job.py:/bench_worker_job.py:ro" \
    -e PARSER_URL=http://127.0.0.1:8090/file_parse \
    -e PARSER_TOKEN=worker-stress-token \
    -e RELEASE_SHA="$release_sha" \
    -e EVO_PARSE_METHOD=auto \
    -e EVO_PARSE_SHARED_DIR=/var/lib/evo-parse \
    -e PARSER_TIMEOUT=2400 \
    -e EVO_PARSE_SLICE_TIMEOUT=600 \
    -e EVO_CAPTION_CONCURRENCY=4 \
    evo-worker-stress:current \
    python /bench_worker_job.py \
      --source-key "$source_key" \
      --source-sha256 "$digest" \
      --filename "${source_key##*/}" \
      --request-id "$request_id" >/dev/null
}

build_fixture_set "warm-${tag}" "overlap-${tag}-warm"
cp "$spool/overlap-${tag}-warm/digital-1.pdf" \
  "$spool/sources/overlap-warm-${tag}.pdf"
run_parse_worker evo-overlap-warm \
  "sources/overlap-warm-${tag}.pdf" "overlap-warm-${tag}"
docker wait evo-overlap-warm >/dev/null
docker logs evo-overlap-warm
docker rm evo-overlap-warm >/dev/null

build_fixture_set "burst-${tag}" "overlap-${tag}-burst"
for worker_number in 1 2 3 4; do
  source="sources/overlap-${tag}-${worker_number}.pdf"
  cp "$spool/overlap-${tag}-burst/digital-${worker_number}.pdf" "$spool/$source"
  name="evo-overlap-parse-${worker_number}"
  parse_names+=("$name")
  run_parse_worker "$name" "$source" "overlap-${tag}-${worker_number}"
done

for _ in $(seq 1 120); do
  health=$(docker exec "$parser_name" curl --fail --silent http://127.0.0.1:8090/healthz 2>/dev/null || true)
  if [[ $health == *'"active_slices":4'* ]]; then
    break
  fi
  sleep 0.5
done

bash "$bench_root/bench/parsers/run_worker_memory_concurrency.sh" \
  8 120 1g 1g 1.0 60

for name in "${parse_names[@]}"; do
  docker wait "$name" >/dev/null
  docker inspect --format '{{json .State}}' "$name"
  docker logs "$name"
done
docker exec "$parser_name" sh -c \
  'printf "parser_memory_peak_bytes="; cat /sys/fs/cgroup/memory.peak; printf "parser_swap_peak_bytes="; cat /sys/fs/cgroup/memory.swap.peak'
free -b
