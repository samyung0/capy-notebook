-- The credits journey's one write (Q496): raise a generated journey account's
-- used credits to just under its limit, so one ghost-text call crosses it.
-- Apply manually as the UAT database administrator, after verifier-role.sql
-- (which marks the database capy.environment=uat), and again only if the
-- database is recreated: the body resolves its tables when called.
-- psql -X -d <uat-database> -v uat_database=<uat-database> -v operatorapply=true \
--   -f scripts/uat/journey-credits.sql
-- Both variables are required; an omitted variable causes a SQL error before
-- changes. Reapplying replaces the function in place. The administrator owns
-- the function, so it must be able to read users and update user_credits.

\set ON_ERROR_STOP on
BEGIN;

SELECT current_database() = :'uat_database'
       AND :'operatorapply' = 'true'
       AND coalesce(current_setting('capy.environment', true), '') = 'uat'
       AND has_table_privilege('public.users', 'SELECT')
       AND has_table_privilege('public.user_credits', 'SELECT')
       AND has_table_privilege('public.user_credits', 'UPDATE')
       AS journey_credits_target_confirmed
\gset

\if :journey_credits_target_confirmed
\else
DO $$ BEGIN
    RAISE EXCEPTION 'Refusing journey credits setup: require operatorapply=true, the exact connected uat_database marked capy.environment=uat, and SELECT on users plus SELECT and UPDATE on user_credits';
END $$;
\endif

CREATE OR REPLACE FUNCTION public.uat_journey_raise_credits_used(
    p_user_id text,
    p_used_micros bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
-- The database this was applied to, baked in by psql at apply time.
SET capy.journey_database = :'uat_database'
AS $$
BEGIN
    -- The marker is read from the database's own setting (verifier-role.sql's
    -- ALTER DATABASE), never the session's, which the caller can SET.
    IF current_database() IS DISTINCT FROM current_setting('capy.journey_database')
       OR NOT EXISTS (
           SELECT 1 FROM pg_db_role_setting s
           JOIN pg_database d ON d.oid = s.setdatabase
           WHERE d.datname = current_database() AND s.setrole = 0
             AND 'capy.environment=uat' = ANY (s.setconfig)
       ) THEN
        RAISE EXCEPTION 'Refusing: not the UAT database this function was applied to';
    END IF;
    -- Accounts the journeys generate (e2e/uat/journeys/accounts.ts uniqueEmail).
    IF NOT EXISTS (
        SELECT 1 FROM public.users
        WHERE id = p_user_id
          AND email ~ '^journeys\+uat-[0-9a-f]{12}-[^@]+\+clerk_test@inbox\.uat\.capynotebook\.com$'
    ) THEN
        RAISE EXCEPTION 'Refusing: not a generated journey account';
    END IF;
    -- Only ever raises used_micros; no other column changes.
    UPDATE public.user_credits
       SET used_micros = p_used_micros
     WHERE user_id = p_user_id AND used_micros < p_used_micros;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Refusing: the account has no credits row, or the value does not raise used credits';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.uat_journey_raise_credits_used(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.uat_journey_raise_credits_used(text, bigint) TO capy_uat_verifier;
COMMIT;
