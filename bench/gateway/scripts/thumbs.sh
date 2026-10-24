#!/usr/bin/env bash
# Gives the seeded PDFs the thumbnail keys ingest would (openwiki/thumbnails.md,
# Ingest render). The bench runs no ingest, so this does the worker's last
# step, the UPDATE of files.thumbnail_key, for every live PDF without one; the
# Office files have theirs from real captures. The objects are not written:
# list rows only sign their keys, and the browser fetches them from B2. Each
# key takes a blob reference lock (account_blob_refs), so the rows go 2,000
# to a transaction.
set -euo pipefail
cd "$(dirname "$0")"
sha=$(sha256sum ../fixtures/thumbnail.webp | cut -d' ' -f1)
while :; do
	done=$(docker exec capy-gwbench-db-1 psql -U capy -d capy -v ON_ERROR_STOP=1 -qAt -c \
		"WITH next AS (SELECT id FROM files WHERE kind = 'pdf' AND thumbnail_key IS NULL AND trashed_at IS NULL LIMIT 2000)
		 UPDATE files f SET thumbnail_key = 'thumbs/' || f.id || '/$sha.webp' FROM next WHERE f.id = next.id
		 RETURNING 1" | wc -l)
	[ "$done" -eq 0 ] && break
done
