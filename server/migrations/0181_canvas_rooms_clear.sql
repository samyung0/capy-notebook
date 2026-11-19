-- Canvas rooms (Epo 2026-11-18): a canvas's board moves from a `board` editor
-- asset to a collaboration room. Nothing is converted (no production data and
-- hardly any on UAT, "no backward-compatibility code"): every canvas goes, its
-- assets with it (the cascade), each row's triggers releasing its charge and
-- queuing its blob.
DELETE FROM materials WHERE kind = 'canvas';

-- No canvas board asset is left or can be made, so a board asset is a drawn
-- sample answer's alone again, capped as 0158 had it
-- (fieldlimits.DrawingBoardBytes, 250 KiB).
ALTER TABLE editor_assets DROP CONSTRAINT editor_assets_size_check;
ALTER TABLE editor_assets ADD CONSTRAINT editor_assets_size_check CHECK (
  (purpose='image' AND size_bytes <= 20971520) OR
  (purpose='audio' AND size_bytes <= 104857600) OR
  (purpose='pdf' AND size_bytes <= 52428800) OR
  (purpose='file' AND size_bytes <= 104857600) OR
  (purpose='board' AND size_bytes <= 256000)
);
