#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${REVIEW_ENV_FILE:-$ROOT_DIR/review/.env.uat}"
GITHUB_ENVIRONMENT="uat"

usage() {
  cat <<'EOF'
Usage: scripts/review/setup-uat.sh

Interactive setup for the Evo Notes UAT review environment. The wizard stores a
local, ignored review/.env.uat file and can configure GitHub Actions variables
and environment secrets through gh. It does not deploy infrastructure or create
third-party accounts.
EOF
}

die() {
  printf 'setup-uat: %s\n' "$1" >&2
  exit 1
}

pause() {
  printf '\nPress Enter when this stage is complete, or Ctrl-C to stop and resume later. '
  read -r _
}

ask() {
  local prompt="$1" default="${2:-}" value
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " value
    printf '%s' "${value:-$default}"
  else
    read -r -p "$prompt: " value
    printf '%s' "$value"
  fi
}

ask_required() {
  local prompt="$1" value
  while true; do
    value="$(ask "$prompt")"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return
    fi
    printf 'A value is required.\n' >&2
  done
}

ask_secret() {
  local prompt="$1" value
  read -r -s -p "$prompt: " value
  printf '\n' >&2
  printf '%s' "$value"
}

confirm() {
  local prompt="$1" answer
  read -r -p "$prompt [y/N]: " answer
  [[ "$answer" == "y" || "$answer" == "Y" || "$answer" == "yes" || "$answer" == "YES" ]]
}

write_env_value() {
  local name="$1" value="$2" temp quoted
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  temp="$(mktemp "$(dirname "$ENV_FILE")/.env.uat.XXXXXX")"
  awk -v key="$name" 'index($0, key "=") != 1 { print }' "$ENV_FILE" > "$temp"
  printf -v quoted '%q' "$value"
  printf '%s=%s\n' "$name" "$quoted" >> "$temp"
  chmod 600 "$temp"
  mv "$temp" "$ENV_FILE"
}

set_repo_var() {
  local name="$1" value="$2"
  [[ "$CONFIGURE_GITHUB" == "true" ]] || return 0
  gh variable set "$name" --repo "$GITHUB_REPOSITORY" --body "$value"
}

set_uat_secret() {
  local name="$1" value="$2"
  [[ "$CONFIGURE_GITHUB" == "true" ]] || return 0
  printf '%s' "$value" | gh secret set "$name" --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT"
}

set_uat_var() {
  set_repo_var "$1" "$2"
}

set_uat_environment_var() {
  local name="$1" value="$2"
  [[ "$CONFIGURE_GITHUB" == "true" ]] || return 0
  gh variable set "$name" --repo "$GITHUB_REPOSITORY" --env "$GITHUB_ENVIRONMENT" --body "$value"
}

stage() {
  printf '\n============================================================\n'
  printf 'Stage %s of 10: %s\n' "$1" "$2"
  printf '============================================================\n'
}

[[ "${1:-}" != "--help" && "${1:-}" != "-h" ]] || { usage; exit 0; }
cd "$ROOT_DIR"

printf 'Evo Notes UAT review setup\n'
printf 'Manual reference: openwiki/deployment-runbook.md, section 12\n'
printf 'Local secrets file: %s (mode 0600, ignored by Git)\n' "$ENV_FILE"

CONFIGURE_GITHUB=false
GITHUB_REPOSITORY=""
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
  if [[ -n "$GITHUB_REPOSITORY" ]] && confirm "Configure GitHub repository $GITHUB_REPOSITORY as values are collected?"; then
    CONFIGURE_GITHUB=true
  fi
fi

stage 1 "GitHub UAT environment"
printf '%s\n' \
  'Create an Actions environment named uat and restrict deployment branches.' \
  'Do not require reviewers if deterministic UAT jobs must run unattended; agent-driven review workflows remain manual dispatch only.' \
  'Repository settings: Settings > Environments > New environment > uat.'
if [[ "$CONFIGURE_GITHUB" == "true" ]] && confirm "Create or update the uat environment now?"; then
  gh api --method PUT "repos/$GITHUB_REPOSITORY/environments/$GITHUB_ENVIRONMENT" >/dev/null
  printf 'GitHub environment is present. Configure protection rules in the web UI.\n'
fi
pause

stage 2 "UAT deployment providers"
printf '%s\n' \
  'Create a dedicated UAT Coolify application and Cloudflare Pages project first.' \
  'Disable their native Git auto-deploy hooks; GitHub Actions will pin and deploy an exact main-branch SHA.'
coolify_api_url="$(ask_required 'Coolify API base URL, including /api/v1')"
coolify_resource_uuid="$(ask_required 'Coolify UAT application UUID')"
coolify_api_token="$(ask_secret 'Coolify UAT API token')"
[[ -n "$coolify_api_token" ]] || die "Coolify API token cannot be empty"
cloudflare_account_id="$(ask_required 'Cloudflare account ID')"
cloudflare_pages_project="$(ask_required 'Cloudflare Pages UAT project name')"
cloudflare_api_token="$(ask_secret 'Cloudflare Pages UAT API token')"
[[ -n "$cloudflare_api_token" ]] || die "Cloudflare API token cannot be empty"
for pair in COOLIFY_API_URL:"$coolify_api_url" COOLIFY_RESOURCE_UUID:"$coolify_resource_uuid" CLOUDFLARE_ACCOUNT_ID:"$cloudflare_account_id" CLOUDFLARE_PAGES_PROJECT:"$cloudflare_pages_project" CLOUDFLARE_PAGES_BRANCH:main; do
  name="${pair%%:*}"
  value="${pair#*:}"
  write_env_value "$name" "$value"
  set_uat_environment_var "$name" "$value"
done
write_env_value COOLIFY_API_TOKEN "$coolify_api_token"
write_env_value CLOUDFLARE_API_TOKEN "$cloudflare_api_token"
set_uat_secret COOLIFY_API_TOKEN "$coolify_api_token"
set_uat_secret CLOUDFLARE_API_TOKEN "$cloudflare_api_token"
unset coolify_api_token cloudflare_api_token
pause

stage 3 "Codex Security source scanner"
printf '%s\n' \
  'In Codex, open Settings > Plugins and install or enable Codex Security.' \
  'Grant repository access only. Do not grant deployment credentials to a source scanner.' \
  'The review skill will use it when callable and will report a coverage gap otherwise.'
pause

stage 4 "Strix scanner model and budget"
strix_llm="$(ask 'Strix model identifier' 'openai/gpt-5.4')"
strix_budget="$(ask 'Maximum Strix UAT budget in USD' '40')"
strix_source_budget="$(ask 'Maximum Strix source-review budget in USD' '40')"
[[ "$strix_budget" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "UAT budget must be numeric"
[[ "$strix_source_budget" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "source-review budget must be numeric"
llm_api_key="$(ask_secret 'LLM API key for the Strix GitHub job')"
[[ -n "$llm_api_key" ]] || die "LLM API key cannot be empty"
write_env_value STRIX_LLM "$strix_llm"
write_env_value STRIX_MAX_BUDGET "$strix_budget"
write_env_value STRIX_SOURCE_MAX_BUDGET "$strix_source_budget"
write_env_value LLM_API_KEY "$llm_api_key"
set_uat_var STRIX_LLM "$strix_llm"
set_uat_var STRIX_UAT_MAX_BUDGET "$strix_budget"
set_uat_var STRIX_SOURCE_MAX_BUDGET "$strix_source_budget"
set_uat_secret LLM_API_KEY "$llm_api_key"
unset llm_api_key

stage 5 "Authorized UAT targets"
uat_app_url="$(ask_required 'UAT application URL, including https://')"
uat_api_url="$(ask_required 'UAT API URL, including https://')"
uat_collab_url="$(ask_required 'UAT collaboration URL, including wss://')"
uat_ops_url="$(ask 'UAT operator URL, including https:// (optional)')"
allowed_hosts="$(ask_required 'Exact comma-separated UAT hostnames; no wildcards')"
for pair in UAT_APP_URL:"$uat_app_url" UAT_API_URL:"$uat_api_url" UAT_COLLAB_URL:"$uat_collab_url" UAT_OPS_URL:"$uat_ops_url" UAT_ALLOWED_HOSTS:"$allowed_hosts"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  write_env_value "$name" "$value"
  set_uat_var "$name" "$value"
done
set_uat_environment_var DEPLOYMENT_APP_URL "$uat_app_url"
set_uat_environment_var DEPLOYMENT_API_URL "$uat_api_url"
set_uat_environment_var DEPLOYMENT_COLLAB_URL "$uat_collab_url"
set_uat_environment_var DEPLOYMENT_OPS_URL "$uat_ops_url"

stage 6 "Dedicated Clerk UAT application"
printf '%s\n' \
  'Create a separate Clerk application for UAT and activate its Production instance.' \
  'Configure its UAT domain, webhook, sign-in methods, and OAuth credentials as described in the runbook.'
clerk_publishable_key="$(ask_required 'Clerk UAT publishable key')"
clerk_secret_key="$(ask_secret 'Clerk UAT secret key')"
[[ -n "$clerk_secret_key" ]] || die "Clerk secret key cannot be empty"
clerk_webhook_secret="$(ask_secret 'Clerk UAT webhook signing secret (blank if the endpoint is not live yet)')"
write_env_value CLERK_PUBLISHABLE_KEY "$clerk_publishable_key"
write_env_value CLERK_SECRET_KEY "$clerk_secret_key"
write_env_value CLERK_WEBHOOK_SECRET "$clerk_webhook_secret"
set_uat_var CLERK_PUBLISHABLE_KEY "$clerk_publishable_key"
set_uat_environment_var CLERK_PUBLISHABLE_KEY "$clerk_publishable_key"
set_uat_secret CLERK_SECRET_KEY "$clerk_secret_key"
unset clerk_secret_key clerk_webhook_secret
pause

stage 7 "Synthetic Clerk accounts"
for role in OWNER EDITOR COMMENTER VIEWER OTHER; do
  role_label="$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]')"
  value="$(ask_required "Synthetic $role_label account email")"
  name="UAT_${role}_EMAIL"
  write_env_value "$name" "$value"
  set_uat_var "$name" "$value"
done
printf 'Use synthetic addresses only. Complete all invitations before continuing.\n'
strix_auth_instructions="$(ask_secret 'Optional Strix synthetic login instructions (blank for unauthenticated scanning)')"
if [[ -n "$strix_auth_instructions" ]]; then
  set_uat_secret STRIX_UAT_AUTH_INSTRUCTIONS "$strix_auth_instructions"
fi
unset strix_auth_instructions
pause

stage 8 "Private authorization fixture"
printf '%s\n' \
  'As the synthetic owner, create one private workspace and one material.' \
  'Invite editor, commenter, and viewer with their matching roles. Leave the other user uninvited.'
fixture_workspace_id="$(ask_required 'Fixture workspace ID')"
fixture_material_id="$(ask_required 'Fixture material ID')"
write_env_value UAT_FIXTURE_WORKSPACE_ID "$fixture_workspace_id"
write_env_value UAT_FIXTURE_MATERIAL_ID "$fixture_material_id"
set_uat_var UAT_FIXTURE_WORKSPACE_ID "$fixture_workspace_id"
set_uat_var UAT_FIXTURE_MATERIAL_ID "$fixture_material_id"

stage 9 "Stripe UAT sandbox"
printf '%s\n' \
  'Create a named Stripe sandbox for UAT. Create separate recurring Pro and Team prices and a UAT webhook.' \
  'These values are stored locally for reference but are not copied to GitHub Actions. Paste them into the UAT Coolify resource.'
stripe_secret_key="$(ask_secret 'Stripe sandbox secret key (must begin sk_test_)')"
[[ "$stripe_secret_key" == sk_test_* ]] || die "Stripe UAT must use an sk_test_ key"
stripe_webhook_secret="$(ask_secret 'Stripe UAT webhook signing secret')"
stripe_price_pro="$(ask_required 'Stripe UAT Pro price ID')"
stripe_price_team="$(ask_required 'Stripe UAT Team price ID')"
write_env_value STRIPE_SECRET_KEY "$stripe_secret_key"
write_env_value STRIPE_WEBHOOK_SECRET "$stripe_webhook_secret"
write_env_value STRIPE_PRICE_PRO "$stripe_price_pro"
write_env_value STRIPE_PRICE_TEAM "$stripe_price_team"
unset stripe_secret_key stripe_webhook_secret
pause

stage 10 "Explicit authorization and activation"
printf '%s\n' \
  'Confirm the targets are owned by you, isolated from production, contain only synthetic data, and match UAT_ALLOWED_HOSTS.' \
  'Automatic post-CI deployment remains disabled until a successful manual baseline run. Strix always remains manual.'
if ! confirm "Authorize deterministic testing against exactly these UAT hosts?"; then
  write_env_value UAT_TARGET_AUTHORIZED false
  set_uat_var UAT_TARGET_AUTHORIZED false
  die "authorization was not granted; remote review remains disabled"
fi
write_env_value UAT_TARGET_AUTHORIZED true
set_uat_var UAT_TARGET_AUTHORIZED true
set_repo_var UAT_DEPLOYMENT_ENABLED false

printf '\nSetup values have been recorded.\n'
printf '1. Copy Clerk and Stripe deployment values into the isolated UAT Coolify resource.\n'
printf '2. Manually dispatch “Deploy UAT”; it deploys the selected SHA and calls the deterministic quality gate.\n'
printf '3. Inspect the deployment, smoke, and Playwright evidence.\n'
printf '4. After a clean baseline, set repository variable UAT_DEPLOYMENT_ENABLED=true.\n'
printf "5. Dispatch Strix workflows or invoke \$review-repository only when you explicitly want a costly review.\n"
printf 'The wizard did not deploy or contact the application.\n'
