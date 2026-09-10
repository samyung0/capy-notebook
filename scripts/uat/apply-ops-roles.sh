#!/usr/bin/env bash
# Apply deploy/ops-roles.sql to the UAT database, taking both passwords from the
# configured DSNs so the roles match OPS_DATABASE_URL / OPS_ADMIN_DATABASE_URL by
# construction. Ops validates its role at startup and refuses to boot on a
# mismatch. Passwords travel on stdin, never in argv, and are never printed.
#
#   1. edit OPS_DATABASE_URL / OPS_ADMIN_DATABASE_URL in deploy/.env.uat
#   2. pnpm uat:ops-roles
#   3. pnpm env:push --file deploy/.env.uat --environment uat --repo <owner/repo>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${OPS_ROLES_ENV_FILE:-$root/deploy/.env.uat}"
[ -f "$env_file" ] || { echo "missing $env_file" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

key="${UAT_SSH_KEY:-$HOME/.ssh/id_ed25519_capy_uat}"
host="${UAT_APP_HOST:-root@159.195.250.206}"
project="${UAT_COMPOSE_PROJECT:-9kx3durs3sxyfotgy20scemv}"
db=$(ssh -i "$key" -o BatchMode=yes "$host" \
  "docker ps --format '{{.Names}}' --filter label=com.docker.compose.service=db --filter label=com.docker.compose.project=$project | head -1")
[ -n "$db" ] || { echo "no UAT db container running" >&2; exit 1; }
echo "applying ops roles in $db"

read -r ops_pw ops_admin_pw <<<"$(python3 - <<'PY'
import os, re, sys, urllib.parse
def password(name):
    match = re.match(r"^\w+://[^:]+:([^@]*)@", os.environ.get(name, ""))
    if not match:
        sys.exit(f"cannot read a password from {name}")
    return urllib.parse.unquote(match.group(1))
print(password("OPS_DATABASE_URL"), password("OPS_ADMIN_DATABASE_URL"))
PY
)"
if [ -z "$ops_pw" ] || [ -z "$ops_admin_pw" ]; then
  echo "empty password in a DSN" >&2
  exit 1
fi

{
  printf "\\\\set ops_password '%s'\n" "$ops_pw"
  printf "\\\\set ops_admin_password '%s'\n" "$ops_admin_pw"
  cat "$root/deploy/ops-roles.sql"
} | ssh -i "$key" -o BatchMode=yes "$host" \
  "docker exec -i $db psql -v ON_ERROR_STOP=1 -U capy -d capy" >/dev/null
echo "ops roles applied and passwords reset to match the configured DSNs"
