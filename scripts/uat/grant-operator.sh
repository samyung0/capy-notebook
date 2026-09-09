#!/usr/bin/env bash
# Grant UAT operator access to one Clerk user. The operator must have signed in
# to the product once: operators.user_id references users(id).
#
#   scripts/uat/grant-operator.sh user_xxx [admin|viewer]
set -euo pipefail

user_id="${1:?usage: grant-operator.sh <clerk_user_id> [admin|viewer]}"
role="${2:-admin}"
[[ "$user_id" =~ ^user_[A-Za-z0-9]+$ ]] || { echo "invalid Clerk user id" >&2; exit 1; }
[[ "$role" == admin || "$role" == viewer ]] || { echo "role must be admin or viewer" >&2; exit 1; }

key="${UAT_SSH_KEY:-$HOME/.ssh/id_ed25519_capy_uat}"
host="${UAT_APP_HOST:-root@159.195.250.206}"
project="${UAT_COMPOSE_PROJECT:-9kx3durs3sxyfotgy20scemv}"
db=$(ssh -i "$key" -o BatchMode=yes "$host" \
  "docker ps --format '{{.Names}}' --filter label=com.docker.compose.service=db --filter label=com.docker.compose.project=$project | head -1")
[ -n "$db" ] || { echo "no UAT db container running" >&2; exit 1; }

# psql never substitutes variables inside dollar quotes, so the guard is an
# INSERT ... SELECT that yields no row when the operator has not signed in.
granted=$(ssh -i "$key" -o BatchMode=yes "$host" \
  "docker exec -i $db psql -v ON_ERROR_STOP=1 -v uid=$user_id -v grole=$role -qtA -U capy -d capy" <<'SQL'
INSERT INTO operators (user_id, role, note)
  SELECT :'uid', :'grole', 'initial operator' FROM users WHERE id = :'uid'
  ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role;
SELECT count(*) FROM operators WHERE user_id = :'uid';
SQL
)
if [[ "$granted" != "1" ]]; then
  echo "no users row for $user_id; sign in to the product once, then re-run" >&2
  exit 1
fi
echo "operator $user_id granted role $role"
