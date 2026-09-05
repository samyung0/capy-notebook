#!/usr/bin/env bash
# One configuration path for local UAT tooling and GitHub deployments.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="$root/deploy/.env.uat"
if [[ ! -f "$config" ]]; then
  install -m 600 "$root/deploy/.env.uat.example" "$config"
  printf 'Created deploy/.env.uat. Fill its UAT values before uploading.\n'
fi
chmod 600 "$config"
python3 "$root/scripts/env/config.py" check --file "$config"
printf '\nUpload the completed file using the manifest-backed uploader:\n'
printf '  pnpm env:push --file deploy/.env.uat --environment uat --repo OWNER/REPO\n'
printf 'Keep UAT_DEPLOYMENT_ENABLED=false until the first manual deployment passes.\n'
