#!/bin/bash
# First-boot init for the shared library database. Runs once, on an empty
# volume, as the docker-entrypoint initdb hook. The owner role (POSTGRES_USER)
# belongs to the library loader; app environments use the read-only role.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v reader_password="$LIBRARY_DB_READER_PASSWORD" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;

CREATE ROLE capy_library_reader LOGIN PASSWORD :'reader_password';
GRANT CONNECT ON DATABASE library TO capy_library_reader;
GRANT USAGE ON SCHEMA public TO capy_library_reader;
-- Tables the loader creates later are readable without a second grant step.
ALTER DEFAULT PRIVILEGES FOR ROLE capy_library IN SCHEMA public
  GRANT SELECT ON TABLES TO capy_library_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE capy_library IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO capy_library_reader;
SQL
