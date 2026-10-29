#!/usr/bin/env bash
# Clear every starter_grants row on UAT so test cards (which share one Stripe
# fingerprint across customers) can earn the 800 starter credits again. Credits
# already granted stay; an account gets the grant by saving a card again.
# Refuses any database without capy.environment=uat.
#
#   scripts/uat/clear-starter-grants.sh
set -euo pipefail

key="${UAT_SSH_KEY:-$HOME/.ssh/id_ed25519_capy_uat}"
host="${UAT_APP_HOST:-root@159.195.250.206}"
project="${UAT_COMPOSE_PROJECT:-capy}"
db=$(ssh -i "$key" -o BatchMode=yes "$host" \
  "docker ps --format '{{.Names}}' --filter label=com.docker.compose.service=db --filter label=com.docker.compose.project=$project | head -1")
[ -n "$db" ] || { echo "no UAT db container running" >&2; exit 1; }

cleared=$(ssh -i "$key" -o BatchMode=yes "$host" \
  "docker exec -i $db psql -v ON_ERROR_STOP=1 -qtA -U capy -d capy" <<'SQL'
DO $$
BEGIN
  IF current_setting('capy.environment', true) IS DISTINCT FROM 'uat' THEN
    RAISE EXCEPTION 'not a UAT database';
  END IF;
END $$;
WITH gone AS (DELETE FROM starter_grants RETURNING 1) SELECT count(*) FROM gone;
SQL
)
echo "cleared $cleared starter grants"
