#!/usr/bin/env bash
# Scans one local or pulled image's OS packages with Trivy and fails on a
# HIGH or CRITICAL advisory that has a fix and is not in .trivyignore.
# Language dependencies are audit.yml's per-ecosystem jobs, so they are not
# scanned twice here. Usage: scripts/ci/trivy-image.sh <image>
set -euo pipefail

image=${1:?usage: trivy-image.sh <image>}
root=$(cd "$(dirname "$0")/../.." && pwd)

# 0.75.0. Bump by tag and digest together, from Docker Hub.
trivy=aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa

echo "== $image"
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$root/.trivyignore:/work/.trivyignore:ro" \
  "$trivy" image \
  --scanners vuln \
  --pkg-types os \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --ignorefile /work/.trivyignore \
  --exit-code 1 \
  --no-progress \
  --skip-version-check \
  "$image"
