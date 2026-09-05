#!/usr/bin/env bash

# Publishes the local Vite dev server on a real hostname through a Cloudflare
# tunnel. A Clerk production instance refuses to authenticate on localhost, so
# `pnpm dev` against a deployed gateway (uat-api) needs a real origin.
#
# The hostname must sit one label under that Clerk instance's primary domain
# (dev-sam.uat.capynotebook.com). Clerk shares sessions across subdomains of
# the primary domain by default; a sibling name like dev.capynotebook.com
# would be a satellite domain instead, needing its own Clerk registration and
# an isSatellite branch in the SPA. Two labels deep is past Cloudflare's free
# Universal certificate, so the zone needs an Advanced Certificate Manager
# pack covering *.uat.capynotebook.com.
#
# The tunnel terminates on THIS machine. The hostname's DNS record points at
# your laptop's tunnel, not at the UAT VM. Only the API calls Vite proxies
# reach the VM.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CAPY_ENV_FILE:-$ROOT_DIR/deploy/.env}"
CONFIG_DIR="${CLOUDFLARED_HOME:-$HOME/.cloudflared}"

die() {
  printf 'tunnel: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/dev/tunnel.sh [--setup-only]

Creates (once) and runs the Cloudflare tunnel that publishes `pnpm dev` on
VITE_DEV_HOST. Re-running is safe: existing tunnel, credentials and DNS record
are reused. --setup-only stops before running the tunnel.

VITE_DEV_HOST is the only per-developer setting. The tunnel is named after it,
so two developers collide only by choosing the same hostname, and that collision
fails rather than stealing anything: the DNS record refuses to move, and a
tunnel whose credentials live on another laptop is rejected here.

Environment:
  CAPY_ENV_FILE           env file to read (default deploy/.env)
  CAPY_DEV_TUNNEL_NAME    override the name derived from VITE_DEV_HOST
EOF
}

setup_only=false
case "${1:-}" in
  --setup-only) setup_only=true ;;
  -h | --help)
    usage
    exit 0
    ;;
  '') ;;
  *)
    usage >&2
    die "unknown argument: $1"
    ;;
esac

command -v cloudflared >/dev/null 2>&1 || die "cloudflared is required (brew install cloudflared)"
command -v jq >/dev/null 2>&1 || die "jq is required"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found — copy deploy/.env.example first"

# Only the two keys this script needs; sourcing the whole file would pull
# every server secret into this shell for no reason.
read_env() {
  local key="$1"
  sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" | tail -1 | tr -d "\"'"
}

host="$(read_env VITE_DEV_HOST)"
port="$(read_env VITE_PORT)"
publishable="$(read_env VITE_CLERK_PUBLISHABLE_KEY)"
# Clerk cannot deliver to localhost, so /webhooks/ rides the same hostname
# through to a locally-run gateway. ADDR is only set for bare runs; the
# compose gateway and every doc use 8080.
addr="$(read_env ADDR)"
gateway_port="${addr##*:}"
[[ "$gateway_port" =~ ^[1-9][0-9]{2,4}$ ]] || gateway_port=8080
[[ -n "$host" ]] || die "VITE_DEV_HOST is not set in $ENV_FILE (e.g. dev-sam.uat.capynotebook.com)"
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
  die "VITE_DEV_HOST is not a hostname: $host"
[[ -n "$port" ]] || die "VITE_PORT is not set in $ENV_FILE"
[[ "$port" =~ ^[1-9][0-9]{2,4}$ ]] || die "VITE_PORT is not a port: $port"

# The Clerk publishable key carries its own Frontend API domain, so the
# instance the SPA will use decides which hostnames can authenticate. Reading
# it here turns a silent afternoon of 401s into a startup error.
case "$publishable" in
  pk_live_*)
    frontend_api="$(base64 -d <<<"${publishable#pk_live_}" 2>/dev/null | tr -d '$')"
    [[ -n "$frontend_api" ]] || die "could not decode VITE_CLERK_PUBLISHABLE_KEY"
    primary="${frontend_api#clerk.}"
    [[ "$host" == *".$primary" ]] ||
      die "VITE_DEV_HOST must sit under the Clerk primary domain $primary (e.g. dev-sam.$primary), otherwise Clerk treats $host as a satellite domain"
    [[ "$host" != *".."* && "${host%%.*}.$primary" == "$host" ]] ||
      die "VITE_DEV_HOST must be exactly one label under $primary, not $host"
    ;;
  pk_test_*)
    die "VITE_CLERK_PUBLISHABLE_KEY is a development instance key, which authenticates on localhost — run \`pnpm dev\` against a local gateway instead of tunnelling"
    ;;
  '')
    die "VITE_CLERK_PUBLISHABLE_KEY is not set in $ENV_FILE"
    ;;
  *)
    die "VITE_CLERK_PUBLISHABLE_KEY is not a Clerk publishable key"
    ;;
esac

# One tunnel per hostname, named after it. Deriving the name keeps the two from
# drifting apart and leaves VITE_DEV_HOST as the only thing a developer sets.
TUNNEL_NAME="${CAPY_DEV_TUNNEL_NAME:-capy-${host%%.*}}"

if [[ ! -f "$CONFIG_DIR/cert.pem" ]]; then
  printf 'tunnel: no Cloudflare login found — a browser window will ask you to pick the zone\n'
  cloudflared tunnel login
fi

uuid="$(cloudflared tunnel list --output json | jq -r --arg name "$TUNNEL_NAME" \
  'map(select(.name == $name and ((.deleted_at // "") | startswith("0001-01-01") or . == ""))) | first | .id // empty')"
if [[ -z "$uuid" ]]; then
  printf 'tunnel: creating %s\n' "$TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME" >/dev/null
  uuid="$(cloudflared tunnel list --output json | jq -r --arg name "$TUNNEL_NAME" \
    'map(select(.name == $name and ((.deleted_at // "") | startswith("0001-01-01") or . == ""))) | first | .id // empty')"
fi
[[ -n "$uuid" ]] || die "could not resolve the tunnel id for $TUNNEL_NAME"

# Tunnels live under the Cloudflare account, credentials live on one machine.
# A tunnel this machine has no credentials for belongs to someone else, and
# deleting it would take their dev hostname down with it.
credentials="$CONFIG_DIR/$uuid.json"
[[ -f "$credentials" ]] ||
  die "tunnel $TUNNEL_NAME exists on the Cloudflare account but its credentials are not on this machine, so it belongs to another developer — set CAPY_DEV_TUNNEL_NAME (and a VITE_DEV_HOST) of your own rather than deleting theirs"

config="$CONFIG_DIR/$TUNNEL_NAME.yml"
cat > "$config" <<EOF
# Generated by scripts/dev/tunnel.sh. Edit that script, not this file.
tunnel: $uuid
credentials-file: $credentials

ingress:
  - hostname: $host
    path: ^/webhooks/
    service: http://localhost:$gateway_port
  - hostname: $host
    service: http://localhost:$port
  - service: http_status:404
EOF
printf 'tunnel: wrote %s\n' "$config"

# A second run reports the record already exists, which is the desired state —
# unless it belongs to someone else's tunnel, which the CLI cannot distinguish.
if ! route_output="$(cloudflared tunnel route dns "$TUNNEL_NAME" "$host" 2>&1)"; then
  if grep -qi 'already exists\|record with that host' <<<"$route_output"; then
    printf 'tunnel: DNS record for %s already exists — confirm it is a CNAME to %s.cfargotunnel.com\n' \
      "$host" "$uuid"
  else
    printf '%s\n' "$route_output" >&2
    die "could not create the DNS record for $host"
  fi
else
  printf 'tunnel: routed %s -> %s\n' "$host" "$TUNNEL_NAME"
fi

cat <<EOF

The tunnel is configured.
  https://$host            -> Vite on http://localhost:$port
  https://$host/webhooks/  -> gateway on http://localhost:$gateway_port

Point the Clerk development instance's webhook at
https://$host/webhooks/clerk (events user.created, user.updated,
user.deleted) and put its signing secret in CLERK_WEBHOOK_SECRET. Deliveries
502 whenever no local gateway is running, which is expected in the UI lane.
One list still has to learn about this origin, and the other two are already
covered:

  1. Clerk (UAT application, Production instance)
     Nothing to do: $host is a subdomain of the primary domain, which shares
     sessions by default. Add it only if the subdomain allowlist is enabled.

  2. UAT gateway env (Coolify -> capy-notebook-uat -> redeploy)
     COLLABORATION_ALLOWED_ORIGINS += https://$host
     Missing: the app loads but no note connects to the editor websocket.

  3. B2 bucket CORS
     deploy/b2-cors.uat.json covers this hostname with a wildcard. Apply it
     once per bucket. Missing: direct uploads fail at the presigned PUT.

Serve the dev server with \`pnpm dev:public\` (plain \`pnpm dev\` stays on
localhost). And in $ENV_FILE, to point it at the deployed gateway:
  VITE_USE_MSW=false
  VITE_API_URL=https://uat-api.capynotebook.com
  VITE_CLERK_PUBLISHABLE_KEY=<the pk_live value from deploy/.env.uat>

EOF

if [[ "$setup_only" == true ]]; then
  printf 'tunnel: setup complete. Run it with: pnpm dev:tunnel\n'
  exit 0
fi

printf 'tunnel: running — start the dev server in another shell with `pnpm dev:public`\n'
exec cloudflared tunnel --config "$config" run "$TUNNEL_NAME"
