#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'verify-release: %s\n' "$1" >&2
  exit 1
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "$name is required"
}

require_value DEPLOYMENT_APP_URL
require_value DEPLOYMENT_API_URL
require_value DEPLOYMENT_COLLAB_URL
require_value EXPECTED_REVISION

command -v curl >/dev/null 2>&1 || die "curl is required"
[[ "$EXPECTED_REVISION" =~ ^[0-9a-fA-F]{40}$ ]] || die "EXPECTED_REVISION must be a full 40-character Git SHA"
[[ "$DEPLOYMENT_APP_URL" == https://* ]] || die "DEPLOYMENT_APP_URL must use https://"
[[ "$DEPLOYMENT_API_URL" == https://* ]] || die "DEPLOYMENT_API_URL must use https://"
[[ "$DEPLOYMENT_COLLAB_URL" == wss://* ]] || die "DEPLOYMENT_COLLAB_URL must use wss://"

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

app_body="$temporary_dir/app.html"
api_headers="$temporary_dir/api.headers"
collab_health="${DEPLOYMENT_COLLAB_URL/#wss:/https:}"

last_error=""
check_release() {
  local app_code app_revision api_code api_revision collab_code

  if ! app_code="$(curl --silent --show-error --location --max-time 30 \
    --output "$app_body" --write-out '%{http_code}' \
    "${DEPLOYMENT_APP_URL%/}/?capy_release=$EXPECTED_REVISION")"; then
    last_error="application request failed"
    return 1
  fi
  if [[ ! "$app_code" =~ ^2[0-9][0-9]$ ]]; then
    last_error="application returned HTTP $app_code"
    return 1
  fi
  app_revision="$(sed -n 's/.*<meta content="\([0-9a-fA-F]\{40\}\)" name="capy-release">.*/\1/p' "$app_body" | head -n 1)"
  if [[ "$app_revision" != "$EXPECTED_REVISION" ]]; then
    last_error="application reports revision '${app_revision:-missing}', expected $EXPECTED_REVISION"
    return 1
  fi

  if ! api_code="$(curl --silent --show-error --max-time 30 \
    --dump-header "$api_headers" --output /dev/null --write-out '%{http_code}' \
    "${DEPLOYMENT_API_URL%/}/healthz?capy_release=$EXPECTED_REVISION")"; then
    last_error="gateway health request failed"
    return 1
  fi
  if [[ ! "$api_code" =~ ^2[0-9][0-9]$ ]]; then
    last_error="gateway health returned HTTP $api_code"
    return 1
  fi
  api_revision="$(awk 'tolower($0) ~ /^x-capy-release:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }' "$api_headers")"
  if [[ "$api_revision" != "$EXPECTED_REVISION" ]]; then
    last_error="gateway reports revision '${api_revision:-missing}', expected $EXPECTED_REVISION"
    return 1
  fi

  if ! collab_code="$(curl --silent --show-error --max-time 30 \
    --output /dev/null --write-out '%{http_code}' \
    "${collab_health%/}/healthz")"; then
    last_error="collaboration health request failed"
    return 1
  fi
  if [[ ! "$collab_code" =~ ^2[0-9][0-9]$ ]]; then
    last_error="collaboration health returned HTTP $collab_code"
    return 1
  fi
}

verify_timeout="${VERIFY_RELEASE_TIMEOUT_SECONDS:-300}"
verify_interval="${VERIFY_RELEASE_INTERVAL_SECONDS:-10}"
[[ "$verify_timeout" =~ ^[1-9][0-9]*$ ]] || die "VERIFY_RELEASE_TIMEOUT_SECONDS must be a positive integer"
[[ "$verify_interval" =~ ^[1-9][0-9]*$ ]] || die "VERIFY_RELEASE_INTERVAL_SECONDS must be a positive integer"

started_at="$SECONDS"
until check_release; do
  if (( SECONDS - started_at >= verify_timeout )); then
    die "$last_error after waiting ${verify_timeout}s"
  fi
  printf 'Waiting for revision propagation: %s\n' "$last_error"
  sleep "$verify_interval"
done

printf 'Verified application and gateway revision %s; collaboration is healthy.\n' "$EXPECTED_REVISION"
