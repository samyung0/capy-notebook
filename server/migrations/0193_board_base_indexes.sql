-- A canvas board's base keeps its state vector and delete set beside it (Epo
-- 2026-11-24, the board room on bytes, step 1): the collaboration server
-- writes both, v1-encoded, with the state at the board's first seed and at
-- each fold, so a later board room can load without decoding the base. They
-- hold ids only, no content; only the collaboration server reads and writes
-- them, and like the rest of a material's Yjs history they are not charged to
-- storage (0183 charges a canvas its state and log alone). Null for every
-- other kind. Canvases stored before this have none: there is no backfill
-- (the UAT canvases are dropped by hand instead).
ALTER TABLE material_yjs_documents
  ADD COLUMN base_state_vector bytea,
  ADD COLUMN base_delete_set bytea;
