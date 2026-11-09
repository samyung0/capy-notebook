-- A flat cap on one text file, every plan (txt, md, json, source code, CSV and
-- TSV; Epo 2026-11-05, Q629, Q630): 30 MiB of text is too much to send to a
-- model. Excel files keep source_file_max_bytes.
ALTER TABLE plan_limits ADD COLUMN text_file_max_bytes bigint;
UPDATE plan_limits SET text_file_max_bytes = 2097152;
ALTER TABLE plan_limits
  ALTER COLUMN text_file_max_bytes SET NOT NULL,
  ADD CONSTRAINT plan_limits_text_file_max_bytes_check CHECK (text_file_max_bytes > 0);

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capy_ops') THEN
    GRANT SELECT (text_file_max_bytes) ON plan_limits TO capy_ops;
  END IF;
END
$grant$;
