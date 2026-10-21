#!/usr/bin/env bash
# One stress pass on a throwaway parser container in the production shape:
# deploy/docker-compose.ingest-host.yml's hardening, limits and env, its own
# spool and work volumes, published on loopback only. Removes the container
# and both volumes when the pass ends, whatever happened.
#
#   IMG=capy-ingest-nonprod-parser:<sha> WORKERS=7 MODE=burst \
#   MANIFEST=a.json OUT=results/a bash capacity_pass.sh
#
# Optional: DEPTH (8), KEEP (bundle folder) and KEEP_IDS, TMP_TMPFS=1 (the
# /tmp tmpfs that compose files carried before the decoder sandbox),
# ABORT_SWAP_GIB (1.0). Every other running container is watched for a
# restart. Needs python3 and root (the spool and the cgroup belong to root).
set -u
here=$(cd "$(dirname "$0")" && pwd)
: "${IMG:?image}" "${WORKERS:?parse children}" "${MODE:?solo or burst}" "${MANIFEST:?manifest}" "${OUT:?output folder}"
DEPTH=${DEPTH:-8}
NAME=capy-ingest-capacity-parser
SPOOL=capy-ingest-capacity-spool
WORK=capy-ingest-capacity-work
SHA=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMG")
[ "${#SHA}" -eq 40 ] || { echo "image $IMG has no 40-character revision label"; exit 1; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$SPOOL" "$WORK" >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cleanup
mkdir -p "$OUT"
umask 077
token=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
watch=$(docker ps --format '{{.Names}}' | grep -v "^$NAME\$" | paste -sd, -)

docker volume create "$SPOOL" >/dev/null
docker volume create "$WORK" >/dev/null
# parse-spool-init, as in the compose file.
docker run --rm -v "$SPOOL":/var/lib/capy-parse -v "$WORK":/run/capy-parser/work alpine:3.20 sh -c \
  "mkdir -p /var/lib/capy-parse/sources /var/lib/capy-parse/artifacts /var/lib/capy-parse/quarantine \
   && chown -R 10001:10001 /var/lib/capy-parse \
   && chmod 2770 /var/lib/capy-parse /var/lib/capy-parse/sources /var/lib/capy-parse/artifacts /var/lib/capy-parse/quarantine \
   && chown 10001:10001 /run/capy-parser/work && chmod 0700 /run/capy-parser/work"

tmp=()
[ "${TMP_TMPFS:-0}" = 1 ] && tmp=(--tmpfs /tmp:noexec,nosuid,nodev,size=256m)
started=$(date +%s)
docker run -d --name "$NAME" -p 127.0.0.1:18090:8090 \
  --cap-drop ALL --security-opt no-new-privileges:true --read-only \
  --tmpfs /run/capy-parser/home:noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700 "${tmp[@]}" \
  -v "$SPOOL":/var/lib/capy-parse -v "$WORK":/run/capy-parser/work \
  --memory 14g --memory-swap 18g --cpus 8 --pids-limit 512 \
  -e APP_ENV=production -e RELEASE_SHA="$SHA" -e PARSER_TOKEN="$token" \
  -e PARSER_BIND_ADDRESS=0.0.0.0 \
  -e CAPY_PARSE_WORKERS="$WORKERS" -e CAPY_PARSE_QUEUE_DEPTH="$DEPTH" \
  -e CAPY_PARSE_DOCUMENT_TIMEOUT=600 -e CAPY_PARSE_OCR_PAGE_CAP=500 -e CAPY_PARSE_MAX_PAGES=1400 \
  -e CAPY_PARSER_JVM_MAX_HEAP=1g -e MALLOC_ARENA_MAX=2 \
  -e CAPY_PARSE_SHARED_DIR=/var/lib/capy-parse -e CAPY_OFFICE_CONVERT_TIMEOUT=180 \
  -e CAPY_OFFICE_PREVIEW_MAX_BYTES=134217728 -e CAPY_PARSE_ARTIFACT_MAX_BYTES=268435456 \
  -e CAPY_PARSE_ARTIFACT_MAX_ENTRY_BYTES=134217728 -e CAPY_PARSE_ARTIFACT_MAX_EXPANDED_BYTES=536870912 \
  -e CAPY_PARSE_CONTENT_MAX_BYTES=134217728 -e CAPY_PARSE_CONTENT_MAX_BLOCKS=250000 \
  "$IMG" uvicorn app:app --app-dir /app/parser --host 0.0.0.0 --port 8090 --workers 1 >/dev/null \
  || { echo "container did not start"; exit 1; }

keep=()
[ -n "${KEEP:-}" ] && keep=(--keep "$KEEP" --keep-ids "${KEEP_IDS:-}")
PARSER_TOKEN="$token" python3 "$here/stress_parser.py" "$MODE" --manifest "$MANIFEST" --out "$OUT" \
  --container "$NAME" --tag "cap-$(basename "$OUT")-$RANDOM" --watch "$watch" \
  --abort-swap-gib "${ABORT_SWAP_GIB:-1.0}" "${keep[@]}" > "$OUT/driver.log" 2>&1
status=$?
docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}' "$NAME" > "$OUT/container-state.txt" 2>&1
docker logs "$NAME" 2>&1 | tail -c 4000000 > "$OUT/parser.log"
journalctl -k --since "@$started" --no-pager 2>/dev/null | grep -i -E "oom|killed process|out of memory|segfault|landlock|audit" > "$OUT/kernel.log"
echo "pass $(basename "$OUT") driver exit $status; $(cat "$OUT/container-state.txt")"
tail -n 1 "$OUT/driver.log"
