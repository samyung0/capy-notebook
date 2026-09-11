#!/usr/bin/env bash
# Probe the Ops edge after its own deployment. The Ops application is deployed
# separately from the app stack, so the app quality gate never checks it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

review_load_env
review_require_command curl
[[ "${UAT_TARGET_AUTHORIZED:-false}" == "true" ]] ||
  review_die "UAT_TARGET_AUTHORIZED must be exactly true"
for name in UAT_ALLOWED_HOSTS DEPLOYMENT_OPS_URL OPS_CF_ACCESS_ISSUER \
  UAT_OPS_ACCESS_CLIENT_ID UAT_OPS_ACCESS_CLIENT_SECRET; do
  review_require_value "$name"
done
[[ "$DEPLOYMENT_OPS_URL" == https://* ]] || review_die "DEPLOYMENT_OPS_URL must use https://"
ops_host="$(review_url_host "$DEPLOYMENT_OPS_URL")" ||
  review_die "DEPLOYMENT_OPS_URL is not a valid URL"
review_host_allowed "$ops_host" || review_die "DEPLOYMENT_OPS_URL host is not authorized"

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
# Coolify reports the deployment finished once the new container starts, but
# Traefik only routes it after its first healthcheck passes and answers 404
# until then. A cached build gets here within seconds, so allow up to a minute.
for _ in $(seq 12); do
  [[ "$(curl --silent --output /dev/null --max-time 20 --max-redirs 0 \
    --write-out '%{http_code}' "${token[@]}" "${DEPLOYMENT_OPS_URL%/}/")" == 404 ]] || break
  sleep 5
done
review_probe "ops shell" "${DEPLOYMENT_OPS_URL%/}/" '^200$' "${token[@]}"
review_probe "ops session" "${DEPLOYMENT_OPS_URL%/}/api/ops/session" '^401$' "${token[@]}"
