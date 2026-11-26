-- A canvas board's base keeps its projection beside it (Epo 2026-11-26, the
-- board projection rides on the fold): the collaboration server writes the
-- Plate value a projection of the base sends Go (the one `canvas_board`
-- block, its `version` the base's stored version and `images` the asset ids
-- the base's blocks name) with the state at the board's first seed and at
-- each fold, from the document the fold builds anyway. Between folds the
-- server projects a board from this value and the log rows since, without
-- the base or a replay. Asset ids only, no content; only the collaboration
-- server reads and writes it, and like 0193's and 0195's columns it is not
-- charged to storage (0183 charges a canvas its state and log alone). Null for
-- every other kind. A board stored before this has none and projects by a
-- full replay until its next fold writes it: there is no backfill.
ALTER TABLE material_yjs_documents
  ADD COLUMN base_projection jsonb;
