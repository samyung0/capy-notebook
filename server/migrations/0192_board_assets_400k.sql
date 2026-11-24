-- A board asset (a canvas block's board or a drawn sample answer's) is capped
-- as a drawing's board is, now 400 KiB (fieldlimits.DrawingBoardBytes, Epo
-- 2026-11-23: a student's canvas answer holds the teacher's canvas too).
ALTER TABLE editor_assets DROP CONSTRAINT editor_assets_size_check;
ALTER TABLE editor_assets ADD CONSTRAINT editor_assets_size_check CHECK (
  (purpose='image' AND size_bytes <= 20971520) OR
  (purpose='audio' AND size_bytes <= 104857600) OR
  (purpose='pdf' AND size_bytes <= 52428800) OR
  (purpose='file' AND size_bytes <= 104857600) OR
  (purpose='board' AND size_bytes <= 409600)
);
