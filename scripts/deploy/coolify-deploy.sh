#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'coolify-deploy: %s\n' "$1" >&2
  exit 1
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "$name is required"
}

require_value COOLIFY_API_URL
require_value COOLIFY_API_TOKEN
require_value COOLIFY_RESOURCE_UUID
require_value DEPLOY_REVISION

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

[[ "$COOLIFY_API_URL" == https://* ]] || die "COOLIFY_API_URL must use https://"
[[ "$COOLIFY_RESOURCE_UUID" =~ ^[A-Za-z0-9_-]+$ ]] || die "COOLIFY_RESOURCE_UUID has an invalid shape"
[[ "$DEPLOY_REVISION" =~ ^[0-9a-fA-F]{40}$ ]] || die "DEPLOY_REVISION must be a full 40-character Git SHA"

poll_interval="${COOLIFY_POLL_INTERVAL_SECONDS:-10}"
timeout="${COOLIFY_DEPLOY_TIMEOUT_SECONDS:-2700}"
[[ "$poll_interval" =~ ^[1-9][0-9]*$ ]] || die "COOLIFY_POLL_INTERVAL_SECONDS must be a positive integer"
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] || die "COOLIFY_DEPLOY_TIMEOUT_SECONDS must be a positive integer"

api_url="${COOLIFY_API_URL%/}"
auth_header="Authorization: Bearer $COOLIFY_API_TOKEN"
json_header="Content-Type: application/json"

# Pin the resource before starting it. Coolify otherwise resolves the moving
# branch head when its deployment worker begins, which can differ from the SHA
# that CI approved when several pushes arrive close together.
update_body="$(jq -cn --arg revision "$DEPLOY_REVISION" '{git_commit_sha: $revision, is_auto_deploy_enabled: false}')"
curl --silent --show-error --fail --retry 3 --retry-all-errors \
  --request PATCH "$api_url/applications/$COOLIFY_RESOURCE_UUID" \
  --header "$auth_header" \
  --header "$json_header" \
  --data "$update_body" >/dev/null

deploy_body="$(jq -cn --arg uuid "$COOLIFY_RESOURCE_UUID" '{uuid: $uuid, force: false}')"
deploy_response="$(curl --silent --show-error --fail \
  --request POST "$api_url/deploy" \
  --header "$auth_header" \
  --header "$json_header" \
  --data "$deploy_body")"

deployment_uuid="$(jq -r --arg uuid "$COOLIFY_RESOURCE_UUID" '
  [.deployments[]? | select(.resource_uuid == $uuid) | .deployment_uuid][0]
  // .deployments[0].deployment_uuid
  // empty
' <<< "$deploy_response")"
[[ -n "$deployment_uuid" && "$deployment_uuid" != "null" ]] || die "Coolify did not return a deployment UUID"
[[ "$deployment_uuid" =~ ^[A-Za-z0-9_-]+$ ]] || die "Coolify returned an invalid deployment UUID"

# Record the provider job before polling so recovery can prove it is terminal.
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'deployment_uuid=%s\n' "$deployment_uuid" >> "$GITHUB_OUTPUT"
fi
printf 'Coolify deployment %s queued for revision %s.\n' "$deployment_uuid" "$DEPLOY_REVISION"
started_at="$SECONDS"
last_status=""

while (( SECONDS - started_at < timeout )); do
  deployment="$(curl --silent --show-error --fail --retry 3 --retry-all-errors \
    "$api_url/deployments/$deployment_uuid" \
    --header "$auth_header")"
  status="$(jq -r '.status // empty' <<< "$deployment")"
  deployed_revision="$(jq -r '.commit // empty' <<< "$deployment")"

  if [[ "$status" != "$last_status" ]]; then
    printf 'Coolify deployment %s status: %s\n' "$deployment_uuid" "${status:-unknown}"
    last_status="$status"
  fi

  case "$status" in
    finished|completed|success|successful)
      [[ -n "$deployed_revision" ]] || die "finished deployment did not report its commit"
      if [[ "$DEPLOY_REVISION" != "$deployed_revision" ]]; then
        die "Coolify deployed commit $deployed_revision instead of $DEPLOY_REVISION"
      fi
      if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
        printf 'deployment_uuid=%s\n' "$deployment_uuid" >> "$GITHUB_OUTPUT"
        printf 'deployed_revision=%s\n' "$deployed_revision" >> "$GITHUB_OUTPUT"
      fi
      printf 'Coolify deployment %s finished at revision %s.\n' "$deployment_uuid" "$deployed_revision"
      exit 0
      ;;
    failed|error|cancelled|cancelled-by-user|cancelled-by-system)
      die "Coolify deployment $deployment_uuid ended with status $status"
      ;;
  esac

  sleep "$poll_interval"
done

die "Coolify deployment $deployment_uuid did not finish within ${timeout}s (last status: ${last_status:-unknown})"
