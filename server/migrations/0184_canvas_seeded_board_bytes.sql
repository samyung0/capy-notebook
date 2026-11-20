-- A canvas is charged its seeded board once its room first seeds it, at its
-- first open (Epo 2026-11-20, "sure 1", via the Mac coordinator, option 1 of
-- three). A canvas is made with no Yjs row, its room seeds that row on the
-- first open, and the seed is stored and projected at once (version 1 = 1),
-- so no projection follows: an untouched board's
-- size_bytes (0183) stayed its content alone until the first edit. The seed's
-- insert rewrites the canvas's content unchanged, which reruns
-- prepare_material_storage_fields with the row in place; the storage trigger
-- moves the difference into its creator's storage. Nothing else on materials
-- fires on such a write (no revision, updated_at, tree or index change). Every
-- other kind is left alone.
CREATE FUNCTION charge_seeded_canvas_board()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE materials SET content = content WHERE id = NEW.material_id AND kind = 'canvas';
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION charge_seeded_canvas_board() FROM PUBLIC;

CREATE TRIGGER material_yjs_documents_charge_canvas_seed
AFTER INSERT ON material_yjs_documents
FOR EACH ROW EXECUTE FUNCTION charge_seeded_canvas_board();
