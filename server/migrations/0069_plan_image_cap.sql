-- Per-image upload cap by plan (human/backend-storage-quota.md, 2026-10-09):
-- the browser shrinks a larger image to fit before uploading.
ALTER TABLE plan_limits ADD COLUMN image_max_bytes bigint;
UPDATE plan_limits SET image_max_bytes = CASE plan_tier
  WHEN 'free' THEN 2097152
  WHEN 'pro' THEN 5242880
END;
ALTER TABLE plan_limits
  ALTER COLUMN image_max_bytes SET NOT NULL,
  ADD CONSTRAINT plan_limits_image_max_bytes_check CHECK (image_max_bytes > 0);

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capy_ops') THEN
    GRANT SELECT (image_max_bytes) ON plan_limits TO capy_ops;
  END IF;
END
$grant$;
