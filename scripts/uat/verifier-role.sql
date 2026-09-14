-- Apply manually as the UAT role/database administrator after migrations:
-- psql -X -d <uat-database> -v uat_database=<uat-database> -v operatorapply=true \
--   -f scripts/uat/verifier-role.sql
-- Both variables are required; an omitted variable causes a SQL error before changes.
-- This creates a new dedicated role. An existing role causes the transaction to
-- roll back; inspect its privileges rather than silently reusing it.
-- Afterwards, run \password capy_uat_verifier interactively in psql and store
-- the resulting connection string in UAT_DATABASE_URL. Never put a password here
-- or in command arguments. New connections receive the database UAT marker.

\set ON_ERROR_STOP on
BEGIN;

SELECT current_database() = :'uat_database'
       AND :'operatorapply' = 'true'
       AND coalesce(current_setting('capy.environment', true), '') IN ('', 'uat')
       AS verifier_target_confirmed
\gset

\if :verifier_target_confirmed
\else
DO $$ BEGIN
    RAISE EXCEPTION 'Refusing verifier setup: require operatorapply=true, the exact connected uat_database, and no conflicting environment marker';
END $$;
\endif

CREATE ROLE capy_uat_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE capy_uat_verifier SET default_transaction_read_only = on;
ALTER ROLE capy_uat_verifier SET statement_timeout = '10s';
GRANT CONNECT ON DATABASE :"uat_database" TO capy_uat_verifier;
GRANT USAGE ON SCHEMA public TO capy_uat_verifier;

-- Explicit current journey/preflight/cleanup reads. New tables need review.
GRANT SELECT ON TABLE
    public.schema_migrations,
    public.users,
    public.workspaces,
    public.workspace_members,
    public.workspace_invites,
    public.materials,
    public.files,
    public.upload_sessions,
    public.source_documents,
    public.source_refresh_candidates,
    public.editor_assets,
    public.image_caption_associations,
    public.pdf_annotations,
    public.jobs,
    public.ingest_job_attempts,
    public.rag_contents,
    public.rag_file_contents,
    public.rag_chunks,
    public.rag_chunk_vectors_2560,
    public.rag_content_summaries,
    public.artifact_cache,
    public.blobs,
    public.pending_blob_deletions,
    public.user_storage,
    public.user_storage_deltas,
    public.provider_calls,
    public.usage_events,
    public.provider_sessions,
    public.webhook_events,
    public.email_outbox,
    public.user_subscriptions,
    public.stripe_checkout_sessions
TO capy_uat_verifier;

-- Refuse ambient PUBLIC write grants; do not change other roles' permissions.
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege('capy_uat_verifier', c.oid,
              'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    ) THEN
        RAISE EXCEPTION 'Verifier inherits PUBLIC write access; inspect database grants before setup';
    END IF;
END $$;

ALTER DATABASE :"uat_database" SET capy.environment = 'uat';
COMMIT;
