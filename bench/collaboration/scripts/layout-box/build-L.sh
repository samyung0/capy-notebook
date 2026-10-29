#!/usr/bin/env bash
# The layout-cost run's images on the box, from L/src (prepare-L.sh): the
# branch's Rust collaboration image (collaboration-rs/Dockerfile, both
# layouts), its gateway, and the in-process matrix (Dockerfile.layout-cost).
# A cold release build on the box's 4 vCPUs takes most of an hour and GiBs of
# RAM, and buildx cannot be pinned off production's cores: run it before any
# step, never during one.
set -euo pipefail
W=/root/capy-capacity
mkdir -p "$W/runs"
cd "$W/L/src"
docker pull -q pgvector/pgvector:pg16
docker pull -q node:22-alpine
docker build --progress=plain -t capy-capacity-collaboration:L -f collaboration-rs/Dockerfile . >"$W/runs/build-L-collaboration.log" 2>&1
docker build --progress=plain -t capy-capacity-server:L server >"$W/runs/build-L-server.log" 2>&1
docker build --progress=plain -t capy-capacity-layout-cost:L \
  -f bench/collaboration/scripts/layout-box/Dockerfile.layout-cost . >"$W/runs/build-L-layout-cost.log" 2>&1
docker images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}' | grep -E 'capy-capacity|pgvector|node:22'
