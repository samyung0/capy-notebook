#!/usr/bin/env bash

set -euo pipefail

REVIEW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REVIEW_ENV_FILE="${REVIEW_ENV_FILE:-$REVIEW_ROOT/deploy/.env.uat}"

review_load_env() {
  if [[ -f "$REVIEW_ENV_FILE" ]]; then
    set -a
    # This file is created by the trusted setup wizard and is never committed.
    # shellcheck disable=SC1090
    source "$REVIEW_ENV_FILE"
    set +a
  fi
}

review_die() {
  printf 'review: %s\n' "$1" >&2
  exit 1
}

review_require_command() {
  command -v "$1" >/dev/null 2>&1 || review_die "required command not found: $1"
}

review_require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || review_die "required value is missing: $name"
}

review_url_host() {
  node -e 'try { process.stdout.write(new URL(process.argv[1]).hostname) } catch { process.exit(2) }' "$1"
}

review_host_allowed() {
  local host="$1" candidate
  IFS=',' read -r -a candidates <<< "${UAT_ALLOWED_HOSTS:-}"
  for candidate in "${candidates[@]}"; do
    candidate="${candidate//[[:space:]]/}"
    [[ -n "$candidate" && "$host" == "$candidate" ]] && return 0
  done
  return 1
}

review_require_authorized_uat() {
  [[ "${UAT_TARGET_AUTHORIZED:-false}" == "true" ]] ||
    review_die "UAT_TARGET_AUTHORIZED must be exactly true"
  review_require_value UAT_ALLOWED_HOSTS

  local name value host
  for name in UAT_APP_URL UAT_API_URL UAT_COLLAB_URL; do
    review_require_value "$name"
    value="${!name}"
    host="$(review_url_host "$value")" || review_die "$name is not a valid URL"
    review_host_allowed "$host" ||
      review_die "$name host '$host' is not listed in UAT_ALLOWED_HOSTS"
  done

  [[ "${UAT_APP_URL:-}" == https://* ]] || review_die "UAT_APP_URL must use https://"
  [[ "${UAT_API_URL:-}" == https://* ]] || review_die "UAT_API_URL must use https://"
  [[ "${UAT_COLLAB_URL:-}" == wss://* ]] || review_die "UAT_COLLAB_URL must use wss://"

  if [[ -n "${UAT_OPS_URL:-}" ]]; then
    host="$(review_url_host "$UAT_OPS_URL")" || review_die "UAT_OPS_URL is not a valid URL"
    review_host_allowed "$host" ||
      review_die "UAT_OPS_URL host '$host' is not listed in UAT_ALLOWED_HOSTS"
    [[ "$UAT_OPS_URL" == https://* ]] || review_die "UAT_OPS_URL must use https://"
  fi

  if [[ -n "${PRODUCTION_APP_URL:-}" && "$UAT_APP_URL" == "$PRODUCTION_APP_URL" ]]; then
    review_die "UAT_APP_URL is identical to PRODUCTION_APP_URL"
  fi
}

review_results_dir() {
  local kind="$1" stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  printf '%s/review-results/%s-%s' "$REVIEW_ROOT" "$kind" "$stamp"
}
