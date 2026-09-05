#!/usr/bin/env bash
# One persistent pending release per stack; the owner survives separate workflow jobs.
set -euo pipefail
umask 077

die() { printf 'ingest-host-release: %s\n' "$1" >&2; exit 1; }
mode="${1:-}"; revision="${2:-}"; environment="${3:-}"; owner="${4:-}"; staging="${5:-}"; repository_url="${6:-}"; backend_revision="${7:-}"
[[ "$mode" == bootstrap-prepare || "$mode" == prepare || "$mode" == activate || "$mode" == recover || "$mode" == rollback-if-pending ]] || die 'invalid phase'
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die 'invalid revision'
[[ "$environment" == uat || "$environment" == production ]] || die 'invalid environment'
[[ "$owner" =~ ^[A-Za-z0-9_-]+$ ]] || die 'invalid release owner'
base="${CAPY_INGEST_ROOT:-/opt/capy-ingest}"
stack=production; project=capy-ingest; repo="$base/app"; compose=deploy/docker-compose.ingest-host.yml
shared=prod.env; consumers=(parse-coordinator worker import-worker host-sampler)
if [[ "$environment" == uat ]]; then
  stack=nonprod; project=capy-ingest-nonprod; repo="$base/app-nonprod"
  compose=deploy/docker-compose.ingest-host.nonprod.yml; shared=nonprod.env
  consumers=(parse-coordinator-uat worker-uat import-worker-uat host-sampler-uat)
fi
state="$base/releases/$stack"; pending="$state/pending"; active="$state/active"
if [[ "$mode" == bootstrap-prepare ]]; then
  [[ ! -e "$active" ]] || die 'stack already initialized; use a normal deployment'
  mkdir -p "$state"
else
  [[ -d "$repo/.git" && -d "$state" ]] || die 'stack not initialized; explicitly select bootstrap on the deployment workflow'
fi
# flock serializes individual mutations; pending ownership covers gaps between jobs.
exec 9>"$state/operation.lock"
flock -n 9 || die 'another ingest operation is running'
if [[ "$mode" == bootstrap-prepare ]]; then
  [[ ! -e "$active" && ! -e "$pending" ]] || die 'stack is initialized or another bootstrap is pending'
fi
restore_revision=""
pending_work=""
cleanup() {
  local status="$?"
  if [[ "$status" != 0 && "$restore_revision" =~ ^[0-9a-f]{40}$ && ! -e "$pending" ]]; then
    git checkout --detach "$restore_revision" >/dev/null || printf 'Could not restore the previous checkout.\n' >&2
  fi
  if [[ -n "$pending_work" && -d "$pending_work" ]]; then rm -rf -- "$pending_work"; fi
  if [[ "$staging" =~ ^/tmp/capy-release\.[A-Za-z0-9]+$ ]]; then rm -rf -- "$staging"; fi
}
trap cleanup EXIT
if [[ "$mode" == bootstrap-prepare && ! -d "$repo/.git" ]]; then
  [[ "$repository_url" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$ ]] || die 'bootstrap requires the repository HTTPS URL'
  [[ ! -e "$repo" || -z "$(ls -A "$repo")" ]] || die 'bootstrap checkout is not empty; refusing overwrite'
  git clone --no-checkout -- "$repository_url" "$repo"
  git -C "$repo" checkout --detach "$revision"
fi
cd "$repo"
[[ -z "$(git status --porcelain)" ]] || die 'ingest checkout has local changes'
read_sha() { local sha; sha="$(cat "$1")"; [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die 'invalid stored release'; printf '%s' "$sha"; }
set_current() {
  local target="$1"
  python3 - "$target" "$state/current" "$owner" <<'PY_LINK'
import os,sys
source,destination,owner=sys.argv[1:]
temporary=destination+'.'+owner+'.tmp'
if os.path.lexists(temporary): os.unlink(temporary)
os.symlink(source, temporary)
os.replace(temporary, destination)
PY_LINK
}
write_active() { printf '%s\n' "$1" > "$active.tmp"; mv "$active.tmp" "$active"; }
config="$state/current"
dc() {
  local sha="$1"; shift
  local args=(-p "$project" --env-file "$config/$shared" -f "$compose")
  if [[ "$environment" == uat ]]; then args+=(--profile uat); fi
  CAPY_INGEST_UAT_ENV_FILE="$config/uat.queue.env" RELEASE_SHA="$sha" docker compose "${args[@]}" "$@"
}
verify() {
  local sha="$1" service="$2" ids id actual running
  ids="$(dc "$sha" ps -q "$service")"; [[ -n "$ids" ]] || return 1
  while IFS= read -r id; do
    actual="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$id")"
    running="$(docker inspect --format '{{.State.Running}}' "$id")"
    [[ "$actual" == "$sha" && "$running" == true ]] || return 1
  done <<<"$ids"
}
parser_ready() {
  local sha="$1" remaining=100 container health
  while ((remaining > 0)); do
    container="$(dc "$sha" ps -q parser)"
    if [[ -n "$container" ]] && verify "$sha" parser; then
      health="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
      # The Compose healthcheck calls /healthz on the configured parser port.
      # That endpoint returns 503 until the parser workers are ready.
      [[ "$health" != healthy ]] || return 0
    fi
    remaining=$((remaining-1)); sleep 15
  done
  return 1
}

check_owner() {
  [[ "$(cat "$pending/owner")" == "$owner" && "$(read_sha "$pending/candidate")" == "$revision" ]] || die 'pending release belongs to another workflow; refusing mutation'
}
rollback() {
  [[ -d "$pending" ]] || { printf 'No pending ingest release.\n'; return; }
  check_owner
  local previous; previous="$(cat "$pending/previous")"
  config="$pending/candidate-config"
  if [[ "$previous" == none ]]; then
    dc "$revision" stop "${consumers[@]}" parser
    [[ ! -e "$state/failed-bootstrap-$owner" ]] || die 'bootstrap failure evidence already exists; pending state retained'
    rm -f "$state/current"
    mv "$pending" "$state/failed-bootstrap-$owner"
    printf 'Stopped failed bootstrap; volumes and configuration evidence retained.\n'
    return
  fi
  previous="$(read_sha "$pending/previous")"
  dc "$revision" stop "${consumers[@]}" parser
  git checkout --detach "$previous"
  local previous_config; previous_config="$(cd "$pending/previous-config" && pwd -P)"
  set_current "$previous_config"
  config="$state/current"
  dc "$previous" up -d --no-build --no-deps parser
  parser_ready "$previous" || die 'previous parser failed to recover; pending state retained'
  dc "$previous" up -d --no-build --no-deps "${consumers[@]}"
  for service in "${consumers[@]}"; do verify "$previous" "$service" || die 'previous consumer failed to recover'; done
  write_active "$previous"
  rm -rf "$pending"
  printf 'Restored %s ingest release %s.\n' "$environment" "$previous"
}
if [[ "$mode" == recover ]]; then
  [[ -d "$pending" ]] || { printf 'No pending ingest release.\n'; exit; }
  check_owner
  [[ "$backend_revision" =~ ^[0-9a-f]{40}$ ]] || die 'backend revision could not be verified; pending state retained'
  if [[ "$backend_revision" == "$revision" ]]; then
    mode=activate
  elif [[ "$backend_revision" == "$(cat "$pending/previous")" ]]; then
    rollback
    exit
  else
    die 'backend matches neither pending revision; keep consumers paused and investigate'
  fi
fi
if [[ "$mode" == rollback-if-pending ]]; then rollback; exit; fi
if [[ "$mode" == prepare || "$mode" == bootstrap-prepare ]]; then
  [[ ! -e "$pending" ]] || die 'another release is pending; recover it with its original owner before retrying'
  [[ "$staging" =~ ^/tmp/capy-release\.[A-Za-z0-9]+$ && -f "$staging/$shared" && -f "$staging/$environment.queue.env" ]] || die 'rendered configuration is missing'
  previous=none
  if [[ "$mode" == prepare ]]; then
    [[ -f "$active" ]] || die 'stack not initialized; explicitly select bootstrap on the deployment workflow'
    previous="$(read_sha "$active")"
    [[ -d "$config" && -f "$config/$shared" ]] || die 'current config snapshot is missing; restore it before deploying'
  fi
  if [[ "$environment" == uat ]]; then
    for service in worker-local parse-coordinator-local import-worker-local host-sampler-local; do
      [[ -z "$(docker ps -q --filter label=com.docker.compose.project=capy-ingest-nonprod --filter "label=com.docker.compose.service=$service")" ]] || die 'stop local-profile consumers before changing the shared nonprod parser; local data is preserved'
    done
  fi
  if [[ "$previous" != none ]]; then
    verify "$previous" parser || die 'active parser SHA mismatch'
    for service in "${consumers[@]}"; do verify "$previous" "$service" || die "active $service SHA mismatch"; done
  else
    [[ -z "$(docker ps -q --filter "label=com.docker.compose.project=$project")" ]] || die 'bootstrap found running containers; initialize their existing release state instead'
  fi
  if [[ "$previous" != none ]]; then restore_revision="$previous"; fi
  git fetch origin
  git cat-file -e "$revision^{commit}"
  git checkout --detach "$revision"
  config="$staging"
  dc "$revision" config --quiet 2>/dev/null || die 'invalid rendered Compose configuration (details redacted)'
  dc "$revision" build parser "${consumers[1]}"
  local_snapshot="$state/config-$owner"
  [[ ! -e "$local_snapshot" ]] || die 'configuration snapshot for this owner already exists; use a new run attempt'
  cp -a "$staging" "$local_snapshot"
  pending_work="$(mktemp -d "$state/.pending-$owner.XXXXXXXX")"
  printf '%s\n' "$owner" > "$pending_work/owner"
  printf '%s\n' "$revision" > "$pending_work/candidate"
  printf '%s\n' "$previous" > "$pending_work/previous"
  if [[ "$previous" != none ]]; then
    ln -s "$(cd "$state/current" && pwd -P)" "$pending_work/previous-config"
  fi
  ln -s "$local_snapshot" "$pending_work/candidate-config"
  mv "$pending_work" "$pending"
  pending_work=""
  config="$state/current"
  if [[ "$previous" != none ]]; then dc "$previous" stop "${consumers[@]}"; fi
  set_current "$local_snapshot"
  if [[ "$previous" == none ]]; then
    dc "$revision" run --rm --no-deps parse-spool-init
  fi
  dc "$revision" up -d --no-build --no-deps parser
  parser_ready "$revision" || die 'candidate parser failed; run rollback with this release owner'
  printf 'Prepared %s parser %s; consumers remain stopped.\n' "$environment" "$revision"
  exit
fi
[[ -d "$pending" ]] || die 'no pending release'
check_owner
[[ "$(git rev-parse HEAD)" == "$revision" ]] || die 'checkout revision mismatch'
parser_ready "$revision" || die 'candidate parser is not healthy at this revision; pending state retained'
dc "$revision" up -d --no-build --no-deps "${consumers[@]}"
for service in "${consumers[@]}"; do verify "$revision" "$service" || die "$service revision mismatch"; done
# Snapshots are immutable and live outside pending; interruption at any point
# leaves both release configurations available to owner-scoped recovery.
if [[ -d "$pending/previous-config" ]]; then
  previous_config="$(cd "$pending/previous-config" && pwd -P)"
  rm -f "$state/previous-config"
  ln -s "$previous_config" "$state/previous-config"
fi
set_current "$(cd "$pending/candidate-config" && pwd -P)"
write_active "$revision"
cp "$pending/previous" "$state/previous"
rm -rf "$pending"
printf 'Activated %s ingest release %s.\n' "$environment" "$revision"
