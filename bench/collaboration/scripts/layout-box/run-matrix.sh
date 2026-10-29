#!/usr/bin/env bash
# The in-process layout-cost matrix on the box (matrix-L.yml): one run into
# runs/L-matrix-<name>, with monitor.sh sampling the container's cgroup, a
# one-hour timeout, and the container removed however it ends.
#   layout-cost.jsonl   the matrix (one JSON object per room state)
#   layout-cost.err     per-state progress and any panic
#   monitor.tsv         cgroup CPU and memory every 2 s (monitor.sh)
#   EXIT                the container's exit code (137: the 2 GiB cap)
# Env: CAP_SCALE (1), CAP_ROOMS (20), CAP_RUNS (5), CAP_NOTES, CAP_LAYOUTS.
#
# Usage: run-matrix.sh <name>
set -uo pipefail
NAME=${1:?run name}
W=/root/capy-capacity
BOX=$(cd "$(dirname "$0")" && pwd)
RUN=$W/runs/L-matrix-$NAME
if [ -e "$RUN" ]; then
  echo "$RUN exists" >&2
  exit 1
fi
mkdir -p "$RUN"
export CAP_SHA
CAP_SHA=$(cat "$W/L/SHA" 2>/dev/null)
C=(docker compose -p capy-capacity -f "$BOX/matrix-L.yml")
cleanup() {
  touch "$RUN/STOP"
  docker ps -aq --filter label=com.docker.compose.project=capy-capacity \
    --filter label=com.docker.compose.service=matrix | xargs -r docker rm -f >/dev/null 2>&1
}
trap cleanup EXIT
setsid "$BOX/monitor.sh" "$RUN" 2>"$RUN/monitor.err" &
echo "$(date -u +%FT%TZ) matrix $NAME: scale ${CAP_SCALE:-1}, rooms ${CAP_ROOMS:-20}" | tee "$RUN/step.log"
timeout 3600 "${C[@]}" run --rm -T --no-deps matrix >"$RUN/layout-cost.jsonl" 2>"$RUN/layout-cost.err" </dev/null
echo $? >"$RUN/EXIT"
echo "$(date -u +%FT%TZ) done: exit $(cat "$RUN/EXIT"), $(wc -l <"$RUN/layout-cost.jsonl") lines" | tee -a "$RUN/step.log"
