#!/usr/bin/env bash
# The deploy job's side of an app-host release (the host's side is
# app-host-deploy.sh). Two steps, each holding only its own secrets:
#
#   app-host-release.sh configure
#     APP_HOST_SSH_HOSTNAME, APP_HOST_KNOWN_HOSTS, APP_HOST_SSH_PRIVATE_KEY:
#     installs the pinned cloudflared and writes the SSH key, the pinned host
#     key and an SSH config that reaches the host through Cloudflare Access.
#
#   app-host-release.sh deploy app|ops <compose file> <env file>
#     DEPLOY_REVISION, GHCR_TOKEN (the job's own token, packages: read) and
#     TUNNEL_SERVICE_TOKEN_ID/SECRET (the Access service token cloudflared
#     reads): sends compose.yml, stack.env and ghcr-token as a tar on stdin to
#     the host's forced command `deploy app|ops <sha>`. Secrets never appear
#     in arguments or output.
set -euo pipefail

CLOUDFLARED_VERSION=2026.10.0
CLOUDFLARED_SHA256=d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db

die() {
  printf 'app-host-release: %s\n' "$1" >&2
  exit 1
}

ssh_dir="${RUNNER_TEMP:?}/capy-ssh"
case "${1:-}" in
  configure)
    [[ "${APP_HOST_SSH_HOSTNAME:-}" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] ||
      die "APP_HOST_SSH_HOSTNAME must be the host's Access SSH hostname"
    [[ -n "${APP_HOST_KNOWN_HOSTS:-}" && -n "${APP_HOST_SSH_PRIVATE_KEY:-}" ]] ||
      die "APP_HOST_KNOWN_HOSTS and APP_HOST_SSH_PRIVATE_KEY are required"
    umask 077
    mkdir -p "$ssh_dir"
    curl --fail --silent --show-error --location --retry 3 --output "$ssh_dir/cloudflared" \
      "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-amd64"
    printf '%s  %s\n' "$CLOUDFLARED_SHA256" "$ssh_dir/cloudflared" | sha256sum --check --quiet -
    chmod 700 "$ssh_dir/cloudflared"
    printf '%s\n' "$APP_HOST_KNOWN_HOSTS" >"$ssh_dir/known_hosts"
    printf '%s\n' "$APP_HOST_SSH_PRIVATE_KEY" >"$ssh_dir/key"
    cat >"$ssh_dir/config" <<EOF
Host capy-app
  HostName $APP_HOST_SSH_HOSTNAME
  User capy-deploy
  IdentityFile $ssh_dir/key
  IdentitiesOnly yes
  IdentityAgent none
  UserKnownHostsFile $ssh_dir/known_hosts
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  UpdateHostKeys no
  BatchMode yes
  ConnectTimeout 30
  ServerAliveInterval 15
  ServerAliveCountMax 8
  ProxyCommand $ssh_dir/cloudflared access ssh --hostname %h
EOF
    ;;
  deploy)
    stack="${2:-}"
    compose="${3:-}"
    env_file="${4:-}"
    [[ "$stack" == app || "$stack" == ops ]] || die "the stack must be app or ops"
    [[ -f "$compose" && -f "$env_file" ]] || die "the compose and env files are required"
    [[ "${DEPLOY_REVISION:-}" =~ ^[0-9a-f]{40}$ ]] || die "DEPLOY_REVISION must be a lowercase full Git SHA"
    [[ -n "${GHCR_TOKEN:-}" && -n "${GITHUB_ACTOR:-}" ]] || die "GHCR_TOKEN and GITHUB_ACTOR are required"
    [[ -n "${TUNNEL_SERVICE_TOKEN_ID:-}" && -n "${TUNNEL_SERVICE_TOKEN_SECRET:-}" ]] ||
      die "the Access service token is required"
    [[ -f "$ssh_dir/config" ]] || die "run configure first"
    umask 077
    staging="$(mktemp -d "$RUNNER_TEMP/capy-deploy.XXXXXX")"
    trap 'rm -rf -- "$staging"' EXIT
    cp -- "$compose" "$staging/compose.yml"
    cp -- "$env_file" "$staging/stack.env"
    printf '%s\n%s\n' "$GITHUB_ACTOR" "$GHCR_TOKEN" >"$staging/ghcr-token"
    tar -C "$staging" -cf - compose.yml stack.env ghcr-token |
      ssh -F "$ssh_dir/config" capy-app "deploy $stack $DEPLOY_REVISION"
    ;;
  *)
    die "usage: app-host-release.sh configure | deploy app|ops <compose file> <env file>"
    ;;
esac
