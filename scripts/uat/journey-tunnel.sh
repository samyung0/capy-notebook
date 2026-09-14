#!/usr/bin/env bash
set -euo pipefail

# Optional CI route. The supplied database URL still selects the verifier role.
directory="${RUNNER_TEMP:?RUNNER_TEMP is required}/uat-journey-db"
case "${1:-}" in
  stop)
    status=0
    if [[ -S "$directory/control" ]]; then
      ssh -F /dev/null -S "$directory/control" -O exit "${UAT_DB_SSH_USER}@${UAT_DB_SSH_HOST}" || status=$?
    fi
    rm -rf "$directory"
    exit "$status"
    ;;
  start) ;;
  *) echo 'Usage: journey-tunnel.sh start|stop' >&2; exit 1 ;;
esac

names=(UAT_DB_SSH_HOST UAT_DB_SSH_USER UAT_DB_SSH_PORT UAT_DB_SSH_PRIVATE_KEY UAT_DB_SSH_KNOWN_HOSTS UAT_DB_FORWARD_HOST UAT_DB_FORWARD_PORT UAT_DB_LOCAL_PORT)
configured=false
for name in "${names[@]}"; do
  if [[ -n "${!name:-}" ]]; then configured=true; fi
done
if [[ "$configured" == false ]]; then
  echo 'No SSH route configured; verifier will use the explicit UAT_DATABASE_URL connection.'
  exit 0
fi
for name in "${names[@]}"; do
  if [[ -z "${!name:-}" ]]; then echo "$name is required for the SSH route" >&2; exit 1; fi
done
for name in UAT_DB_SSH_HOST UAT_DB_FORWARD_HOST; do
  [[ "${!name}" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo "$name must be a hostname or IPv4 address" >&2; exit 1; }
done
[[ "$UAT_DB_SSH_USER" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_-]*$ ]] || { echo 'Invalid UAT_DB_SSH_USER' >&2; exit 1; }
for name in UAT_DB_SSH_PORT UAT_DB_FORWARD_PORT UAT_DB_LOCAL_PORT; do
  if ! [[ "${!name}" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#${!name} > 65535 )); then
    echo "$name must be a port number" >&2
    exit 1
  fi
done
python3 - <<'PY'
import os
from urllib.parse import urlsplit

try:
    url = urlsplit(os.environ['UAT_DATABASE_URL'])
    assert url.hostname == '127.0.0.1' and url.port == int(os.environ['UAT_DB_LOCAL_PORT'])
except (KeyError, ValueError, AssertionError):
    raise SystemExit('UAT_DATABASE_URL must target 127.0.0.1 and UAT_DB_LOCAL_PORT for the SSH route')
PY

umask 077
mkdir "$directory"
trap 'rm -rf "$directory"' ERR
printf '%s\n' "$UAT_DB_SSH_PRIVATE_KEY" > "$directory/key"
printf '%s\n' "$UAT_DB_SSH_KNOWN_HOSTS" > "$directory/known_hosts"
ssh -F /dev/null -M -S "$directory/control" -fN \
  -i "$directory/key" -p "$UAT_DB_SSH_PORT" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$directory/known_hosts" \
  -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=15 \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L "127.0.0.1:$UAT_DB_LOCAL_PORT:$UAT_DB_FORWARD_HOST:$UAT_DB_FORWARD_PORT" \
  "$UAT_DB_SSH_USER@$UAT_DB_SSH_HOST"
echo 'Pinned SSH database tunnel established.'
