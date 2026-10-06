-- The sha256 of the canonical content the last projection wrote or found
-- already stored (ProjectMaterialContent). Once a material has this row, only
-- the projection writes materials.content (UpdateMaterial writes it directly
-- only while there is none), so a projection whose content hashes the same
-- leaves the material and its revision alone without asking PostgreSQL to
-- parse 2 MiB of JSON and compare it with the stored jsonb. NULL until the
-- row's first projection, which compares the jsonb once.
ALTER TABLE material_yjs_documents ADD COLUMN projected_sha256 bytea;
