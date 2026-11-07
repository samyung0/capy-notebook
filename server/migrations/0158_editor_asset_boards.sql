-- A drawing part's drawn sample answer (Epo 2026-11-06, Q3) keeps its board as
-- one of the quiz's editor assets, gzipped, beside its image; the board is
-- what the author opens to edit it again.
ALTER TABLE editor_assets DROP CONSTRAINT editor_assets_purpose_check;
ALTER TABLE editor_assets ADD CONSTRAINT editor_assets_purpose_check
  CHECK (purpose IN ('image','audio','pdf','file','board'));
-- A board asset is capped as a drawing's board is (fieldlimits.DrawingBoardBytes,
-- 250 KiB); the size check named every purpose but this one.
ALTER TABLE editor_assets DROP CONSTRAINT editor_assets_check;
ALTER TABLE editor_assets ADD CONSTRAINT editor_assets_size_check CHECK (
  (purpose='image' AND size_bytes <= 20971520) OR
  (purpose='audio' AND size_bytes <= 104857600) OR
  (purpose='pdf' AND size_bytes <= 52428800) OR
  (purpose='file' AND size_bytes <= 104857600) OR
  (purpose='board' AND size_bytes <= 256000)
);
