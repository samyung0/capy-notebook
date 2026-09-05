#!/usr/bin/env bash
set -euo pipefail

die() { printf 'ingest-host-release: %s\n' "$1" >&2; exit 1; }
mode="${1:-}"
revision="${DEPLOY_REVISION:-}"
environment="${TARGET_ENVIRONMENT:-}"
owner="${CAPY_RELEASE_OWNER:-}"
host="${INGEST_HOST:-}"
user="${INGEST_HOST_USER:-capy-ingest}"
port="${INGEST_HOST_SSH_PORT:-22}"
[[ "$mode" == bootstrap-prepare || "$mode" == prepare || "$mode" == activate || "$mode" == recover || "$mode" == rollback-if-pending ]] || die "invalid release phase"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "DEPLOY_REVISION must be a lowercase full Git SHA"
[[ "$environment" == uat || "$environment" == production ]] || die "TARGET_ENVIRONMENT must be uat or production"
[[ "$owner" =~ ^[A-Za-z0-9_-]+$ ]] || die "CAPY_RELEASE_OWNER is required"
[[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] || die "INGEST_HOST is invalid"
[[ "$user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "INGEST_HOST_USER is invalid"
[[ "$port" =~ ^[0-9]+$ ]] || die "INGEST_HOST_SSH_PORT must be numeric"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ssh_args=(-o BatchMode=yes -o ConnectTimeout=15 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -p "$port")
staging=""
cleanup() {
  if [[ "$staging" =~ ^/tmp/capy-release\.[A-Za-z0-9]+$ ]]; then
    ssh "${ssh_args[@]}" "$user@$host" "rm -rf -- '$staging'" >/dev/null || true
  fi
}
trap cleanup EXIT
if [[ "$mode" == prepare || "$mode" == bootstrap-prepare ]]; then
  [[ -d "${CAPY_CONFIG_DIR:-}" ]] || die "CAPY_CONFIG_DIR must contain rendered GitHub configuration"
  staging="$(ssh "${ssh_args[@]}" "$user@$host" 'umask 077; mktemp -d /tmp/capy-release.XXXXXXXX')"
  [[ "$staging" =~ ^/tmp/capy-release\.[A-Za-z0-9]+$ ]] || die "invalid staging directory"
  shared=prod.env
  [[ "$environment" == production ]] || shared=nonprod.env
  # tar avoids placing credentials in process arguments and preserves private modes.
  tar -C "$CAPY_CONFIG_DIR" -cf - "$shared" "$environment.queue.env" | \
    ssh "${ssh_args[@]}" "$user@$host" "tar -xf - -C '$staging'"
fi
ssh "${ssh_args[@]}" "$user@$host" bash -s -- "$mode" "$revision" "$environment" "$owner" "$staging" "${CAPY_INGEST_REPOSITORY_URL:-}" "${CAPY_BACKEND_REVISION:-}" \
  <"$script_dir/ingest-host-remote-release.sh"
