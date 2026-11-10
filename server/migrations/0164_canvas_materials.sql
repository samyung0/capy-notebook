-- The workspace canvas (Epo 2026-11-09, todo-workspace-canvas-storage.md): a
-- personal drawing board, one per member per workspace, seen by its owner
-- alone. It is a standalone material of kind `canvas` (no workspace_id, so
-- the owner-only rules of standalone materials apply) linked to its workspace
-- by canvas_workspace_id, and its saved board is the material's own `board`
-- editor asset, as a drawn sample answer's is.
ALTER TABLE materials DROP CONSTRAINT materials_kind_check;
ALTER TABLE materials ADD CONSTRAINT materials_kind_check
  CHECK (kind IN ('mindmap','diagram','quiz','flashcards','note','canvas'));

ALTER TABLE materials ADD COLUMN canvas_workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE;
-- A canvas names its workspace and sits in none; nothing else names one.
ALTER TABLE materials ADD CONSTRAINT materials_canvas_link_check
  CHECK ((kind = 'canvas') = (canvas_workspace_id IS NOT NULL));
ALTER TABLE materials ADD CONSTRAINT materials_canvas_standalone_check
  CHECK (kind <> 'canvas' OR workspace_id IS NULL);
-- One live canvas per member per workspace.
CREATE UNIQUE INDEX materials_canvas_per_member
  ON materials (owner_user_id, canvas_workspace_id)
  WHERE kind = 'canvas' AND trashed_at IS NULL;

-- A canvas's board is capped at fieldlimits.CanvasBoardBytes (2 MiB) before
-- gzip; a drawn sample answer's keeps the drawing's 250 KiB in the API
-- (planlimits.EditorAssetBytes by the material's kind). The row check is the
-- backstop at the larger of the two.
ALTER TABLE editor_assets DROP CONSTRAINT editor_assets_size_check;
ALTER TABLE editor_assets ADD CONSTRAINT editor_assets_size_check CHECK (
  (purpose='image' AND size_bytes <= 20971520) OR
  (purpose='audio' AND size_bytes <= 104857600) OR
  (purpose='pdf' AND size_bytes <= 52428800) OR
  (purpose='file' AND size_bytes <= 104857600) OR
  (purpose='board' AND size_bytes <= 2097152)
);
