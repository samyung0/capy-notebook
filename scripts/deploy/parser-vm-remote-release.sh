#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'parser-vm-release: %s\n' "$1" >&2
  exit 1
}

mode="${1:-}"
revision="${2:-}"
repo="${EVO_PARSER_REPO:-/opt/evo-parser/app}"
release_env="${EVO_PARSER_RELEASE_ENV:-/opt/evo-parser/release.env}"
pending_state="${EVO_PARSER_PENDING_STATE:-/opt/evo-parser/release.pending}"
secret_env="${EVO_PARSER_SECRET_ENV:-/etc/evo-parser/parser.env}"
compose="${EVO_PARSER_COMPOSE:-deploy/docker-compose.parser-vm.yml}"
health_attempts="${EVO_PARSER_HEALTH_ATTEMPTS:-100}"
health_interval="${EVO_PARSER_HEALTH_INTERVAL:-15}"

[[ "$mode" == "prepare" || "$mode" == "activate" || "$mode" == "rollback-if-pending" ]] ||
  die "mode must be prepare, activate, or rollback-if-pending"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "revision must be a lowercase full Git SHA"
[[ "$health_attempts" =~ ^[1-9][0-9]*$ ]] || die "health attempts must be positive"
[[ "$health_interval" =~ ^[0-9]+$ ]] || die "health interval must be non-negative"

cd "$repo"

write_release_env() {
  local sha="$1"
  printf 'RELEASE_SHA=%s\n' "$sha" >"${release_env}.tmp"
  mv "${release_env}.tmp" "$release_env"
}

active_revision() {
  local sha=""
  if [[ -f "$release_env" ]]; then
    sha="$(sed -n 's/^RELEASE_SHA=//p' "$release_env")"
  fi
  if [[ -n "$sha" && ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    die "active release file contains an invalid revision"
  fi
  printf '%s' "$sha"
}

state_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$pending_state"
}

write_pending_state() {
  local previous="$1"
  local candidate="$2"
  umask 077
  {
    printf 'PREVIOUS_SHA=%s\n' "${previous:-none}"
    printf 'CANDIDATE_SHA=%s\n' "$candidate"
  } >"${pending_state}.tmp"
  mv "${pending_state}.tmp" "$pending_state"
}

read_pending_state() {
  [[ -f "$pending_state" ]] || return 1
  previous_revision="$(state_value PREVIOUS_SHA)"
  candidate_revision="$(state_value CANDIDATE_SHA)"
  [[ "$previous_revision" == "none" || "$previous_revision" =~ ^[0-9a-f]{40}$ ]] ||
    die "pending release contains an invalid previous revision"
  [[ "$candidate_revision" =~ ^[0-9a-f]{40}$ ]] ||
    die "pending release contains an invalid candidate revision"
}

dc() {
  local sha="$1"
  shift
  RELEASE_SHA="$sha" docker compose \
    -p evo-parser \
    --env-file "$secret_env" \
    -f "$compose" \
    "$@"
}

verify_container_revision() {
  local sha="$1"
  local service="$2"
  local containers container image_revision
  containers="$(dc "$sha" ps -q "$service")"
  [[ -n "$containers" ]] || return 1
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    image_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container")"
    [[ "$image_revision" == "$sha" ]] || return 1
  done <<<"$containers"
}

preserve_service_image() {
  local sha="$1"
  local service="$2"
  local target="$3"
  local containers container image image_revision
  containers="$(dc "$sha" ps -q "$service")"
  [[ -n "$containers" ]] || die "$service is not running at the active release"
  container="${containers%%$'\n'*}"
  image_revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container")"
  [[ "$image_revision" == "$sha" ]] || die "$service does not match the active release"
  image="$(docker inspect --format '{{ .Image }}' "$container")"
  docker image tag "$image" "$target"
}

verify_image_revision() {
  local image="$1"
  local sha="$2"
  local image_revision
  image_revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
  [[ "$image_revision" == "$sha" ]]
}

wait_for_parser() {
  local sha="$1"
  local remaining="$health_attempts"
  while ((remaining > 0)); do
    if verify_container_revision "$sha" parser && dc "$sha" exec -T parser python -c '
import json, os, sys, urllib.request
url = f"http://{os.environ["PARSER_BIND_ADDRESS"]}:8090/healthz"
with urllib.request.urlopen(url, timeout=5) as response:
    health = json.load(response)
if health.get("ok") is not True or health.get("state") != "ready":
    raise SystemExit(1)
if health.get("release_sha") != sys.argv[1]:
    raise SystemExit(1)
' "$sha"; then
      return 0
    fi
    remaining=$((remaining - 1))
    sleep "$health_interval"
  done
  return 1
}

rollback_release() {
  local previous_revision candidate_revision
  if ! read_pending_state; then
    printf 'parser-vm-release: no pending release to roll back\n'
    return 0
  fi

  git cat-file -e "${candidate_revision}^{commit}"
  git checkout --detach "$candidate_revision"
  if [[ "$previous_revision" == "none" ]]; then
    dc "$candidate_revision" stop worker host-sampler parser >/dev/null 2>&1 || true
    rm -f "$release_env" "$pending_state"
    printf 'parser-vm-release: removed failed bootstrap release %s\n' "$candidate_revision"
    return 0
  fi

  verify_image_revision "evo-parser-parser:${previous_revision}" "$previous_revision"
  verify_image_revision "evo-parser-pipeline:${previous_revision}" "$previous_revision"
  write_release_env "$previous_revision"
  dc "$previous_revision" up -d --no-build --no-deps parser
  wait_for_parser "$previous_revision" || die "previous parser did not recover"
  dc "$previous_revision" up -d --no-build --no-deps worker host-sampler
  verify_container_revision "$previous_revision" worker
  verify_container_revision "$previous_revision" host-sampler
  git checkout --detach "$previous_revision"
  rm -f "$pending_state"
  printf 'parser-vm-release: restored release %s\n' "$previous_revision"
}

rollback_on_failure() {
  local status="$?"
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then
    set +e
    rollback_release
    local rollback_status="$?"
    set -e
    if [[ "$rollback_status" -ne 0 ]]; then
      printf 'parser-vm-release: automatic rollback failed; pending state remains\n' >&2
    fi
  fi
  exit "$status"
}

[[ -z "$(git status --porcelain)" ]] || die "parser checkout has local changes; refusing release"

if [[ "$mode" == "rollback-if-pending" ]]; then
  rollback_release
  exit 0
fi

if [[ "$mode" == "prepare" ]]; then
  [[ ! -f "$pending_state" ]] || die "another parser release is still pending"
  previous_revision="$(active_revision)"
  if [[ -n "$previous_revision" ]]; then
    verify_container_revision "$previous_revision" parser || die "active parser revision is inconsistent"
    verify_container_revision "$previous_revision" worker || die "active worker revision is inconsistent"
    verify_container_revision "$previous_revision" host-sampler || die "active sampler revision is inconsistent"
    preserve_service_image "$previous_revision" parser "evo-parser-parser:${previous_revision}"
    preserve_service_image "$previous_revision" worker "evo-parser-pipeline:${previous_revision}"
  fi

  git fetch --prune origin
  git cat-file -e "${revision}^{commit}"
  git checkout --detach "$revision"
  [[ "$(git rev-parse HEAD)" == "$revision" ]]
  dc "$revision" config >/dev/null
  dc "$revision" build parser worker
  verify_image_revision "evo-parser-parser:${revision}" "$revision"
  verify_image_revision "evo-parser-pipeline:${revision}" "$revision"

  write_pending_state "$previous_revision" "$revision"
  trap rollback_on_failure EXIT

  dc "$revision" stop worker host-sampler
  write_release_env "$revision"
  dc "$revision" up -d --no-build --no-deps parser
  wait_for_parser "$revision" || die "parser did not become healthy at release $revision"
  printf 'parser-vm-release: parser %s is ready; ingest remains paused\n' "$revision"
  exit 0
fi

read_pending_state || die "no prepared parser release exists"
[[ "$candidate_revision" == "$revision" ]] || die "prepared parser revision does not match activation"
[[ "$(git rev-parse HEAD)" == "$revision" ]] || die "parser checkout does not match activation"
[[ "$(active_revision)" == "$revision" ]] || die "active release file does not match activation"
verify_container_revision "$revision" parser || die "running parser does not match activation"
dc "$revision" up -d --no-build --no-deps worker host-sampler
verify_container_revision "$revision" worker || die "running worker does not match activation"
verify_container_revision "$revision" host-sampler || die "running sampler does not match activation"
rm -f "$pending_state"
printf 'parser-vm-release: activated release %s\n' "$revision"
