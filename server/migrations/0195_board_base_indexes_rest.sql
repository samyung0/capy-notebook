-- A canvas board's base keeps the rest of its indexes beside it (Epo
-- 2026-11-24, the board room on bytes, step 2), so the board room loads
-- without decoding the base: the collaboration server writes them with the
-- state at the board's first seed and at each fold, in the same row as 0193's
-- state vector and delete set. One versioned binary value
-- (`board::Indexes::stored` in collaboration-rs/crates/server/src/board.rs
-- documents version 1): the origins the one-held-side rule reads (named and
-- continued units, place hashes, sequence heads and firsts), each type's
-- depth below its root and the clients that wrote contributor markers. Ids
-- and hashes only, no content; only the collaboration server reads and
-- writes it, and like 0193's columns it is not charged to storage (0183
-- charges a canvas its state and log alone). Null for every other kind. A
-- canvas stored before this has none, and the board room on bytes refuses to
-- load it: there is no backfill (the UAT canvases are dropped by hand
-- instead).
ALTER TABLE material_yjs_documents
  ADD COLUMN base_indexes bytea;
