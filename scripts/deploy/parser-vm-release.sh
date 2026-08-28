#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'parser-vm-release: %s\n' "$1" >&2
  exit 1
}

mode="${1:-}"
revision="${DEPLOY_REVISION:-}"
host="${PARSER_VM_HOST:-}"
user="${PARSER_VM_USER:-evo-parser}"
port="${PARSER_VM_SSH_PORT:-22}"

[[ "$mode" == "prepare" || "$mode" == "activate" ]] || die "mode must be prepare or activate"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "DEPLOY_REVISION must be a lowercase full Git SHA"
[[ -n "$host" ]] || die "PARSER_VM_HOST is required"
[[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] || die "PARSER_VM_HOST has an invalid shape"
[[ "$user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "PARSER_VM_USER has an invalid shape"
[[ "$port" =~ ^[0-9]+$ ]] || die "PARSER_VM_SSH_PORT must be numeric"

ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=15 \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -p "$port" \
  "$user@$host" \
  bash -s -- "$mode" "$revision" <<'REMOTE'
set -euo pipefail

mode="$1"
revision="$2"
repo=/opt/evo-parser/app
release_env=/opt/evo-parser/release.env
compose=deploy/docker-compose.parser-vm.yml
secret_env=/etc/evo-parser/parser.env

cd "$repo"
[[ -z "$(git status --porcelain)" ]] || {
  printf 'parser checkout has local changes; refusing release\n' >&2
  exit 1
}

if [[ "$mode" == "prepare" ]]; then
  git fetch --prune origin
  git cat-file -e "${revision}^{commit}"
  git checkout --detach "$revision"
  [[ "$(git rev-parse HEAD)" == "$revision" ]]
  printf 'RELEASE_SHA=%s\n' "$revision" > "${release_env}.tmp"
  mv "${release_env}.tmp" "$release_env"
fi

[[ "$(git rev-parse HEAD)" == "$revision" ]] || {
  printf 'parser checkout does not match requested release\n' >&2
  exit 1
}
grep -qx "RELEASE_SHA=$revision" "$release_env"

dc=(docker compose -p evo-parser --env-file "$secret_env" --env-file "$release_env" -f "$compose")
"${dc[@]}" config >/dev/null

verify_container_revision() {
  local service="$1"
  local container image_revision
  container="$("${dc[@]}" ps -q "$service")"
  [[ -n "$container" ]] || return 1
  image_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container")"
  [[ "$image_revision" == "$revision" ]]
}

if [[ "$mode" == "prepare" ]]; then
  "${dc[@]}" stop worker host-sampler >/dev/null 2>&1 || true
  "${dc[@]}" up -d --build --no-deps parser
  for _attempt in $(seq 1 100); do
    if verify_container_revision parser && "${dc[@]}" exec -T parser python -c '
import json, os, sys, urllib.request
url = f"http://{os.environ["PARSER_BIND_ADDRESS"]}:8090/healthz"
with urllib.request.urlopen(url, timeout=5) as response:
    health = json.load(response)
if health.get("release_sha") != sys.argv[1]:
    raise SystemExit(1)
' "$revision"; then
      exit 0
    fi
    sleep 15
  done
  die="parser did not become healthy at release $revision"
  printf '%s\n' "$die" >&2
  exit 1
fi

verify_container_revision parser || {
  printf 'running parser image does not match requested release\n' >&2
  exit 1
}
"${dc[@]}" up -d --build --no-deps worker host-sampler
verify_container_revision worker
verify_container_revision host-sampler
REMOTE
