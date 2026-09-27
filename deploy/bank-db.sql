-- Run as capy_library against the library database before bank migrate, then again
-- after migrations to grant table permissions. Owner and editor passwords are required.
-- psql -d library -v bank_password=... -v bank_editor_password=... -f bank-db.sql
\set ON_ERROR_STOP on
\if :{?bank_password}
\else
\warn 'bank_password is required'
\quit 1
\endif
\if :{?bank_editor_password}
\else
\warn 'bank_editor_password is required'
\quit 1
\endif
DO $roles$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='capy_bank') THEN
    CREATE ROLE capy_bank LOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='capy_bank_editor') THEN
    CREATE ROLE capy_bank_editor LOGIN NOINHERIT;
  END IF;
END $roles$;
ALTER ROLE capy_bank WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'bank_password';
ALTER ROLE capy_bank_editor WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'bank_editor_password';
SELECT 'CREATE DATABASE bank OWNER capy_bank' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='bank') \gexec
\connect bank
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE bank TO capy_library_reader,capy_bank_editor;
GRANT USAGE ON SCHEMA public TO capy_library_reader,capy_bank_editor;
ALTER DEFAULT PRIVILEGES FOR ROLE capy_bank IN SCHEMA public GRANT SELECT ON TABLES TO capy_library_reader,capy_bank_editor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO capy_library_reader,capy_bank_editor;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON ALL TABLES IN SCHEMA public FROM capy_bank_editor;
DO $grants$ DECLARE tbl record; BEGIN
  -- Table-level REVOKE does not remove column grants left by an older script.
  FOR tbl IN SELECT table_name,string_agg(quote_ident(column_name),',') AS columns
    FROM information_schema.columns WHERE table_schema='public' GROUP BY table_name
  LOOP
    EXECUTE format('REVOKE INSERT (%s),UPDATE (%s),REFERENCES (%s) ON public.%I FROM capy_bank_editor',tbl.columns,tbl.columns,tbl.columns,tbl.table_name);
  END LOOP;
  IF to_regclass('public.questions') IS NOT NULL THEN
    GRANT UPDATE(content,updated_at,updated_by,reviewed_at,reviewed_by) ON questions TO capy_bank_editor;
  END IF;
END $grants$;
