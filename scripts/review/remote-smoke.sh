#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

review_load_env
review_require_command curl
review_require_authorized_uat
app_url="${UAT_APP_URL:-}"
api_url="${UAT_API_URL:-}"

probe() {
  local label="$1" url="$2" accepted="$3" code
  code="$(curl --silent --show-error --output /dev/null --max-time 20 \
    --max-redirs 0 --write-out '%{http_code}' "$url")"
  if [[ ! "$code" =~ $accepted ]]; then
    review_die "$label returned HTTP $code from $url"
  fi
  printf '%-18s %s  %s\n' "$label" "$code" "$url"
}

collab_health="${UAT_COLLAB_URL/#wss:/https:}"
collab_health="${collab_health/#ws:/http:}"
collab_health="${collab_health%/}/healthz"

probe "application" "${app_url%/}/" '^[23][0-9][0-9]$'
probe "gateway health" "${api_url%/}/healthz" '^2[0-9][0-9]$'
probe "collab health" "$collab_health" '^2[0-9][0-9]$'

if [[ -n "${UAT_OPS_URL:-}" ]]; then
  ops_host="$(review_url_host "$UAT_OPS_URL")"
  review_host_allowed "$ops_host" || review_die "UAT_OPS_URL host is not authorized"
  probe "ops edge" "${UAT_OPS_URL%/}/" '^(200|30[1278]|401|403)$'
fi

if [[ -n "${EXPECTED_REVISION:-}" ]]; then
  DEPLOYMENT_APP_URL="$UAT_APP_URL" \
  DEPLOYMENT_API_URL="$UAT_API_URL" \
  DEPLOYMENT_COLLAB_URL="$UAT_COLLAB_URL" \
  EXPECTED_REVISION="$EXPECTED_REVISION" \
    "$SCRIPT_DIR/../deploy/verify-release.sh"
fi
