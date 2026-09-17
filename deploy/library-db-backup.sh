#!/bin/bash
# Nightly logical dump of the shared library database, kept for seven days on
# the ingest host. Installed by the runbook as /etc/cron.d/capy-library-db.
# ponytail: local disk only; add a B2 upload when the library is no longer
# cheap to rebuild from its PDFs and receipts.
set -euo pipefail
dir=/opt/capy-library-db/backups
mkdir -p "$dir"
docker exec capy-library-db pg_dump -U capy_library -d library -Fc \
  > "$dir/library-$(date -u +%Y%m%dT%H%M%SZ).dump"
find "$dir" -name 'library-*.dump' -mtime +7 -delete
