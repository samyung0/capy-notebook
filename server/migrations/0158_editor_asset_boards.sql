-- A drawing part's drawn sample answer (Epo 2026-11-06, Q3) keeps its board as
-- one of the quiz's editor assets, gzipped, beside its image; the board is
-- what the author opens to edit it again.
ALTER TABLE editor_assets DROP CONSTRAINT editor_assets_purpose_check;
ALTER TABLE editor_assets ADD CONSTRAINT editor_assets_purpose_check
  CHECK (purpose IN ('image','audio','pdf','file','board'));
