#!/usr/bin/env bash
# Post a commit status for a locally run review so promote-production.yml can
# gate on it. Usage: report-status.sh <context> <success|failure> <description> <sha>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

context="${1:-}"
state="${2:-}"
description="${3:-}"
sha="${4:-}"

[[ -n "$context" && -n "$description" ]] || review_die "usage: report-status.sh <context> <success|failure> <description> <sha>"
[[ "$state" == "success" || "$state" == "failure" ]] || review_die "state must be success or failure"
[[ "$sha" =~ ^[0-9a-fA-F]{40}$ ]] || review_die "sha must be a full 40-character Git SHA"
review_require_command gh
gh auth status >/dev/null 2>&1 || review_die "gh is not authenticated; run gh auth login"

repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
# The description field is capped at 140 characters by GitHub.
gh api --method POST "repos/$repository/statuses/$sha" \
  -f state="$state" -f context="$context" -f description="${description:0:140}" >/dev/null
printf 'status %s=%s posted on %s\n' "$context" "$state" "$sha"
