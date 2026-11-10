-- Canvases of one's own (Epo 2026-11-10): the account's Canvas page holds
-- canvases that belong to no workspace, saved as a workspace canvas is. Such a
-- canvas is a standalone material of kind `canvas` with no canvas_workspace_id;
-- a person may have several, where a workspace has one per member (the
-- materials_canvas_per_member index leaves NULLs apart). Only a canvas names
-- a workspace this way.
ALTER TABLE materials DROP CONSTRAINT materials_canvas_link_check;
ALTER TABLE materials ADD CONSTRAINT materials_canvas_link_check
  CHECK (kind = 'canvas' OR canvas_workspace_id IS NULL);
