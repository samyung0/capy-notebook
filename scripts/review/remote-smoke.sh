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

collab_health="${UAT_COLLAB_URL/#wss:/https:}"
collab_health="${collab_health/#ws:/http:}"
collab_health="${collab_health%/}/healthz"

review_probe "application" "${app_url%/}/" '^[23][0-9][0-9]$'
review_probe "gateway health" "${api_url%/}/healthz" '^2[0-9][0-9]$'
review_probe "collab health" "$collab_health" '^2[0-9][0-9]$'

if [[ -n "${EXPECTED_REVISION:-}" ]]; then
  DEPLOYMENT_APP_URL="$UAT_APP_URL" \
  DEPLOYMENT_API_URL="$UAT_API_URL" \
  DEPLOYMENT_COLLAB_URL="$UAT_COLLAB_URL" \
  EXPECTED_REVISION="$EXPECTED_REVISION" \
    "$SCRIPT_DIR/../deploy/verify-release.sh"
fi
