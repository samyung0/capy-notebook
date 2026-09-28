-- The local parser-to-ingest bundle is deleted once its ingest finishes
-- (human/agentic-retrieval.md, 2026-09-28), so these references were always
-- stale. In-flight bundles are named by their job payload's parseArtifact.
ALTER TABLE files
  DROP COLUMN parsed_blob_path,
  DROP COLUMN parsed_fingerprint,
  DROP COLUMN parsed_parser_version;
ALTER TABLE source_refresh_candidates
  DROP COLUMN parse_artifact_key,
  DROP COLUMN parse_artifact_fingerprint,
  DROP COLUMN parse_artifact_version;
