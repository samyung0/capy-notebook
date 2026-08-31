#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'ingest-host-release: %s\n' "$1" >&2
  exit 1
}

mode="${1:-}"
revision="${DEPLOY_REVISION:-}"
host="${INGEST_HOST:-}"
user="${INGEST_HOST_USER:-evo-ingest}"
port="${INGEST_HOST_SSH_PORT:-22}"

[[ "$mode" == "prepare" || "$mode" == "activate" || "$mode" == "rollback-if-pending" ]] ||
  die "mode must be prepare, activate, or rollback-if-pending"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "DEPLOY_REVISION must be a lowercase full Git SHA"
[[ -n "$host" ]] || die "INGEST_HOST is required"
[[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] || die "INGEST_HOST has an invalid shape"
[[ "$user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "INGEST_HOST_USER has an invalid shape"
[[ "$port" =~ ^[0-9]+$ ]] || die "INGEST_HOST_SSH_PORT must be numeric"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=15 \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -p "$port" \
  "$user@$host" \
  bash -s -- "$mode" "$revision" <"$script_dir/ingest-host-remote-release.sh"
