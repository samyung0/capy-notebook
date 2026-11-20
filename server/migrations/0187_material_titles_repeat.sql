-- Materials may share a name in a workspace (Epo 2026-11-20), as files do. The
-- index left serves the next free number for a name the app makes up, counted
-- against what Files lists (materialTitleTaken).
DROP INDEX IF EXISTS materials_workspace_title_uidx;
CREATE INDEX materials_workspace_title_idx ON materials (workspace_id, lower(btrim(title)))
  WHERE workspace_id IS NOT NULL AND trashed_at IS NULL AND parent_material_id IS NULL
    AND assignment_id IS NULL AND kind IN ('note','quiz','flashcards');
