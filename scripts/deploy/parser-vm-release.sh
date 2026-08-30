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

[[ "$mode" == "prepare" || "$mode" == "activate" || "$mode" == "rollback-if-pending" ]] ||
  die "mode must be prepare, activate, or rollback-if-pending"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "DEPLOY_REVISION must be a lowercase full Git SHA"
[[ -n "$host" ]] || die "PARSER_VM_HOST is required"
[[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] || die "PARSER_VM_HOST has an invalid shape"
[[ "$user" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "PARSER_VM_USER has an invalid shape"
[[ "$port" =~ ^[0-9]+$ ]] || die "PARSER_VM_SSH_PORT must be numeric"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=15 \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -p "$port" \
  "$user@$host" \
  bash -s -- "$mode" "$revision" <"$script_dir/parser-vm-remote-release.sh"
