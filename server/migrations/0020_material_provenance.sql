-- Attribution record of a material written from the shared knowledge library.
-- Null for workspace materials. Written at creation and appended by a curate
-- `edit_document` (books union by id, excerpt ids union per book, licence
-- recomputed) in the same transaction as the edit; the user-facing material
-- routes never touch it. The frontend renders it outside the editable
-- document so a user cannot delete the credit.
ALTER TABLE materials ADD COLUMN provenance jsonb;
