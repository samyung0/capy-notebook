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

# Extra arguments after the accepted pattern are passed to curl (headers).
probe() {
  local label="$1" url="$2" accepted="$3" code
  shift 3
  code="$(curl --silent --show-error --output /dev/null --max-time 20 \
    --max-redirs 0 --write-out '%{http_code}' "$@" "$url")"
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

if [[ -n "${DEPLOYMENT_OPS_URL:-}" ]]; then
  ops_host="$(review_url_host "$DEPLOYMENT_OPS_URL")"
  review_host_allowed "$ops_host" || review_die "DEPLOYMENT_OPS_URL host is not authorized"
  for name in OPS_CF_ACCESS_ISSUER UAT_OPS_ACCESS_CLIENT_ID UAT_OPS_ACCESS_CLIENT_SECRET; do
    review_require_value "$name"
  done
  # Anonymous visitors must land on the Access login for this hostname, never
  # on the origin (200), its own gate (401) or an unrelated Cloudflare rule.
  login="${OPS_CF_ACCESS_ISSUER%/}/cdn-cgi/access/login/$ops_host?"
  answer="$(curl --silent --show-error --output /dev/null --max-time 20 \
    --max-redirs 0 --write-out '%{http_code} %{redirect_url}' "${DEPLOYMENT_OPS_URL%/}/")"
  [[ "$answer" == "302 $login"* ]] ||
    review_die "ops edge did not redirect anonymous requests to Cloudflare Access: ${answer%% *}"
  printf '%-18s %s  %s\n' "ops access" "${answer%% *}" "$login"
  # The smoke service token is allowed through Access: the shell is served and
  # the API still demands a Clerk session.
  token=(-H "CF-Access-Client-Id: $UAT_OPS_ACCESS_CLIENT_ID"
    -H "CF-Access-Client-Secret: $UAT_OPS_ACCESS_CLIENT_SECRET")
  probe "ops shell" "${DEPLOYMENT_OPS_URL%/}/" '^200$' "${token[@]}"
  probe "ops session" "${DEPLOYMENT_OPS_URL%/}/api/ops/session" '^401$' "${token[@]}"
fi

if [[ -n "${EXPECTED_REVISION:-}" ]]; then
  DEPLOYMENT_APP_URL="$UAT_APP_URL" \
  DEPLOYMENT_API_URL="$UAT_API_URL" \
  DEPLOYMENT_COLLAB_URL="$UAT_COLLAB_URL" \
  EXPECTED_REVISION="$EXPECTED_REVISION" \
    "$SCRIPT_DIR/../deploy/verify-release.sh"
fi
