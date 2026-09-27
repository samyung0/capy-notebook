#!/bin/bash
# Nightly logical dumps, kept seven days locally. Bank edits also go to B2.
# Installed by the runbook as /etc/cron.d/capy-library-db after bank setup.
set -euo pipefail
dir=/opt/capy-library-db/backups
mkdir -p "$dir"
docker exec capy-library-db pg_dump -U capy_library -d library -Fc \
  > "$dir/library-$(date -u +%Y%m%dT%H%M%SZ).dump"
find "$dir" -name 'library-*.dump' -mtime +7 -delete

# Bank edits exist only in the shared database. Keep an off-host copy as well.
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="bank-$stamp.dump"
docker exec capy-library-db pg_dump -U capy_library -d bank -Fc > "$dir/$dump"
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
docker run --rm --network host -v "$dir:/backups:ro" \
  -e RCLONE_CONFIG_BANK_TYPE -e RCLONE_CONFIG_BANK_PROVIDER \
  -e RCLONE_CONFIG_BANK_ENDPOINT -e RCLONE_CONFIG_BANK_REGION \
  -e RCLONE_CONFIG_BANK_ACCESS_KEY_ID -e RCLONE_CONFIG_BANK_SECRET_ACCESS_KEY \
  rclone/rclone:1.70 copyto "/backups/$dump" "bank:$BANK_PRIVATE_B2_BUCKET/backups/$dump" \
  --no-check-dest --s3-no-check-bucket --s3-no-head
find "$dir" -name 'bank-*.dump' -mtime +7 -delete
