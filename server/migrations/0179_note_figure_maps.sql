-- Note figures held as the quiz figure map (Epo 2026-11-16, D15; client
-- protocol 30, raised by 0178's release; openwiki/deployment-runbook.md,
-- "Note figure maps reset"). A note's chart, plot or graph `block` is now the
-- figure map a quiz room holds: its fields, a graph's elements keyed by id, a
-- chart's series, labels, names and values as maps. A room stored before
-- holds a graph's elements and a chart's series as lists, which the new room
-- reads as no elements or series and admission refuses on the next write, so
-- the figure would be lost. There is no reader for the old layout (no legacy
-- data): the Yjs rows of every note, mindmap and diagram whose saved content
-- holds a chart, plot or graph go, and each seeds again from materials.content
-- (whose shape is unchanged: the plain block) on its next open, agent edit or
-- command (note_store.rs bootstrap). A document without a figure keeps its
-- room.
--
-- As 0178 does (AI edit Undo is live in the loaded room since 0106 and
-- stores nothing, so it goes with the room): trash_restores rises to the dropped room_schema, so the new room's name
-- (1 + trash_restores, store.MaterialRoom) is past the old one; old tokens and
-- browser drafts of the old lineage open copy-only recovery. The deploy stops
-- collaboration before migrate, so no room writes meanwhile. Refused while
-- such a document's projection is behind its stored Yjs state
-- (materials.content would miss those edits). A database with no note rooms
-- holding figures passes.
LOCK TABLE material_yjs_documents IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMPORARY TABLE note_figure_rooms ON COMMIT DROP AS
SELECT d.material_id, d.room_schema, d.projected_version < d.stored_version AS behind
FROM material_yjs_documents d JOIN materials m ON m.id = d.material_id
WHERE m.kind IN ('note', 'mindmap', 'diagram')
  AND jsonb_path_exists(m.content, 'strict $.value.** ? (@.type == "chart" || @.type == "plot" || @.type == "graph")');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM note_figure_rooms WHERE behind) THEN
    RAISE EXCEPTION 'Note figure maps reset refused: a note holding a figure has a projection behind its stored Yjs state; wait for the projection or fix its projection_error (openwiki/deployment-runbook.md, "Note figure maps reset")';
  END IF;
END $$;

UPDATE materials m SET trash_restores = GREATEST(m.trash_restores, r.room_schema)
FROM note_figure_rooms r
WHERE m.id = r.material_id;

-- The document's update log goes with it (ON DELETE CASCADE).
DELETE FROM material_yjs_documents d USING note_figure_rooms r
WHERE d.material_id = r.material_id;
