-- Provisioned once when the data directory is initialized. LightRAG also runs
-- these on initialize_storages(), so this is a fail-fast check that the image
-- really ships both extensions rather than the only place they are created.
--
-- AGE needs `shared_preload_libraries=age`, which the compose files pass as a
-- postgres arg; the entrypoint forwards it to the temporary bootstrap server
-- that executes this script.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS age;
