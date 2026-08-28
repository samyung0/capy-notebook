#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

mode="${1:-local}"
review_load_env

review_require_command git
review_require_command node

case "$mode" in
  local)
    review_require_command pnpm
    review_require_command go
    review_require_command uv
    ;;
  source)
    review_require_command strix
    review_require_value STRIX_LLM
    review_require_value LLM_API_KEY
    ;;
  uat)
    review_require_command curl
    review_require_authorized_uat
    ;;
  uat-security)
    review_require_command curl
    review_require_command strix
    review_require_value STRIX_LLM
    review_require_value LLM_API_KEY
    review_require_authorized_uat
    ;;
  *)
    review_die "unknown mode '$mode'; use local, source, uat, or uat-security"
    ;;
esac

printf 'review preflight passed for %s\n' "$mode"
