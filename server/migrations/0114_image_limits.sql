-- Images (human/backend-storage-quota.md, 2026-10-24): the image cap is 2 MiB
-- on every plan, since every image is compressed; and a provider import
-- records how many EMF and WMF pictures the import worker removed from an
-- Office file, which the browser shows once the import lands.
UPDATE plan_limits SET image_max_bytes = 2097152 WHERE plan_tier = 'pro';

ALTER TABLE source_import_jobs
  ADD COLUMN removed_pictures integer NOT NULL DEFAULT 0
  CONSTRAINT source_import_jobs_removed_pictures_check CHECK (removed_pictures >= 0);
