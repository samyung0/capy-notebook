#!/usr/bin/env bash
# Fail unless every named commit-status context is `success` on the SHA.
# Usage: require-statuses.sh <sha> <context>...
# Locally, gh must be authenticated; in Actions, GH_TOKEN with statuses:read.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

sha="${1:-}"
shift || true
[[ "$sha" =~ ^[0-9a-fA-F]{40}$ ]] || review_die "usage: require-statuses.sh <sha> <context>..."
(($# > 0)) || review_die "at least one status context is required"
review_require_command gh

repository="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
# The combined endpoint returns only the latest status per context.
statuses="$(gh api "repos/$repository/commits/$sha/status" --jq '.statuses[] | "\(.context)\t\(.state)\t\(.description)"')"

missing=0
for context in "$@"; do
  line="$(printf '%s\n' "$statuses" | awk -F'\t' -v c="$context" '$1 == c { print; exit }')"
  state="$(printf '%s' "$line" | cut -f2)"
  if [[ "$state" == "success" ]]; then
    printf '%-24s success  %s\n' "$context" "$(printf '%s' "$line" | cut -f3-)"
  else
    printf '%-24s %s\n' "$context" "${state:-missing}" >&2
    missing=1
  fi
done

((missing == 0)) || review_die "required review statuses are not green on $sha"
