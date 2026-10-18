#!/bin/bash
# Nightly logical dumps of the library and the bank, uploaded to the private
# bank bucket (its backups/ lifecycle rule keeps 30 days); the host keeps the
# two newest of each for a quick restore.
# Installed by the runbook as /etc/cron.d/capy-library-db after bank setup.
set -euo pipefail
dir=/opt/capy-library-db/backups
mkdir -p "$dir"
set -a
source /opt/capy-library-db/.env
set +a
: "${BANK_PRIVATE_B2_ENDPOINT:?set BANK_PRIVATE_B2_ENDPOINT}"
: "${BANK_PRIVATE_B2_REGION:?set BANK_PRIVATE_B2_REGION}"
: "${BANK_PRIVATE_B2_BUCKET:?set BANK_PRIVATE_B2_BUCKET}"
: "${BANK_PRIVATE_B2_KEY_ID:?set BANK_PRIVATE_B2_KEY_ID}"
: "${BANK_PRIVATE_B2_APP_KEY:?set BANK_PRIVATE_B2_APP_KEY}"
export RCLONE_CONFIG_BANK_TYPE=s3 RCLONE_CONFIG_BANK_PROVIDER=Other
export RCLONE_CONFIG_BANK_ENDPOINT="$BANK_PRIVATE_B2_ENDPOINT"
export RCLONE_CONFIG_BANK_REGION="$BANK_PRIVATE_B2_REGION"
export RCLONE_CONFIG_BANK_ACCESS_KEY_ID="$BANK_PRIVATE_B2_KEY_ID"
export RCLONE_CONFIG_BANK_SECRET_ACCESS_KEY="$BANK_PRIVATE_B2_APP_KEY"

# backup <database>: dump it, upload the dump, keep the two newest locally.
backup() {
  local dump
  dump="$1-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # A dump that dies mid-write stays a hidden .tmp and never enters the rotation.
  docker exec capy-library-db pg_dump -U capy_library -d "$1" -Fc > "$dir/.$dump.tmp"
  mv "$dir/.$dump.tmp" "$dir/$dump"
  docker run --rm --network host -v "$dir:/backups:ro" \
    -e RCLONE_CONFIG_BANK_TYPE -e RCLONE_CONFIG_BANK_PROVIDER \
    -e RCLONE_CONFIG_BANK_ENDPOINT -e RCLONE_CONFIG_BANK_REGION \
    -e RCLONE_CONFIG_BANK_ACCESS_KEY_ID -e RCLONE_CONFIG_BANK_SECRET_ACCESS_KEY \
    rclone/rclone:1.70 copyto "/backups/$dump" "bank:$BANK_PRIVATE_B2_BUCKET/backups/$dump" \
    --no-check-dest --s3-no-check-bucket --s3-no-head
  ls -1t "$dir"/"$1"-*.dump | tail -n +3 | xargs -r rm -f
}

backup library
backup bank
