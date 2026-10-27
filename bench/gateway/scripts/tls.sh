#!/usr/bin/env bash
# The fake B2's throwaway certificate (docker-compose.yml): the gateway only
# takes https://*.backblazeb2.com endpoints and trusts it through
# SSL_CERT_FILE. Writes ../.tls/{cert,key}.pem once.
set -euo pipefail
cd "$(dirname "$0")"
dir=../.tls
[ -f "$dir/cert.pem" ] && exit 0
mkdir -p "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
	-subj /CN=s3.bench.backblazeb2.com \
	-addext subjectAltName=DNS:s3.bench.backblazeb2.com \
	-addext basicConstraints=critical,CA:FALSE \
	-keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
# Readable by the images' non-root users.
chmod 644 "$dir/key.pem" "$dir/cert.pem"
