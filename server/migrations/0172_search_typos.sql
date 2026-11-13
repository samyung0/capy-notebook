-- Global search tolerates typos as search engines do (Epo 2026-11-13;
-- Elasticsearch AUTO, Meilisearch, Typesense): word by word, a query word
-- matches a name word within an edit distance its length allows, 0 under five
-- characters, 1 from five, 2 from nine. fuzzystrmatch ships with Postgres's
-- contrib, as pgvector's image includes.
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- search_typos is how many edits the name needs to hold every word of the
-- query: per query word 0 when the name holds it, else the fewest edits to one
-- of the name's words or to its start (a word still being typed), at most 2
-- (levenshtein_less_equal stops counting past the bound). NULL when a word is
-- further off than its length allows, or the query has no words.
CREATE FUNCTION search_typos(name text, query text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN bool_and(d <= allowed) THEN sum(d)::integer END
  FROM (
    SELECT
      CASE WHEN char_length(q) >= 9 THEN 2 WHEN char_length(q) >= 5 THEN 1 ELSE 0 END AS allowed,
      CASE WHEN strpos(lower(name), q) > 0 THEN 0 ELSE (
        SELECT min(least(
          public.levenshtein_less_equal(w, q, 2),
          public.levenshtein_less_equal(left(w, char_length(q)), q, 2)))
        FROM regexp_split_to_table(lower(name), '[^[:alnum:]]+') w
        WHERE w <> ''
      ) END AS d
    FROM regexp_split_to_table(lower(query), '[^[:alnum:]]+') q
    WHERE q <> ''
  ) per_word
$$;

-- Keep these off PUBLIC, as 0001 does for every function in public (vector's
-- included): the app role that made them still runs them; the operational
-- roles stay deny-by-default.
REVOKE EXECUTE ON FUNCTION search_typos(text, text) FROM PUBLIC;
DO $$
DECLARE
  fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      JOIN pg_extension e ON e.oid = d.refobjid
     WHERE e.extname = 'fuzzystrmatch'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
  END LOOP;
END $$;
