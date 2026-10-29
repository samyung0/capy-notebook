#!/usr/bin/env bash
# cleanup.sh [--apply] (the 2026-10-28 presence run's, unchanged): removes what
# the capacity runs (every phase, this one's L included) created on the box, and
# nothing else. Without --apply it only lists. Inputs: the inventory taken
# before the first build (baseline-images.txt, one "repo:tag id" per line).
#   1. Compose project capy-capacity: containers (profiles included),
#      networks, volumes.
#   2. Images not in the baseline (the two built images, pgvector,
#      node:22-alpine, the build stages' bases), by ID.
#   3. The build cache, only if the baseline cache was empty (0 B) and every
#      build in `docker buildx history` since the baseline is one of ours.
#   4. /root/capy-capacity.
# Steps 3 and 4 are printed, to run by hand after that check.
set -uo pipefail
W=/root/capy-capacity
APPLY=${1:-}
run() {
  echo "+ $*"
  [ "$APPLY" = --apply ] && "$@"
}
# By the project's labels, so either phase's files are not needed.
for id in $(docker ps -aq --filter label=com.docker.compose.project=capy-capacity); do run docker rm -f "$id"; done
for v in $(docker volume ls -q --filter label=com.docker.compose.project=capy-capacity); do run docker volume rm "$v"; done
for n in $(docker network ls -q --filter label=com.docker.compose.project=capy-capacity); do run docker network rm "$n"; done
# By tag where there is one, by ID for untagged build results; never an ID
# the baseline lists.
docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' | while read -r ref id; do
  grep -q " $id\$" "$W/baseline-images.txt" && continue
  case $ref in "<none>:<none>") run docker rmi "$id" ;; *) run docker rmi "$ref" ;; esac
done
echo "build cache now:"
docker buildx du | tail -2
echo "builds since the baseline (check they are all ours before pruning):"
docker buildx history ls | head -20
echo "then: docker builder prune -af   and   rm -rf $W"
