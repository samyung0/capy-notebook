-- Several canvases per member per workspace (Epo 2026-11-12): a workspace's
-- Canvas tab lists, makes, renames and deletes its member's canvases as the
-- account's Canvas page does its own. Each stays personal to its owner.
DROP INDEX IF EXISTS materials_canvas_per_member;
