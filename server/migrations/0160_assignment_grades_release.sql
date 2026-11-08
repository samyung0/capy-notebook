-- When members see their grades (Epo 2026-11-08, mock C4): automatically, as
-- marks are decided, or manually, once staff press Release grades. Until then a
-- member's results hold their answers alone, its quiz stays out of practice and
-- reviews, and its answers stay out of their topic labels.
ALTER TABLE assignments
  ADD COLUMN grades_shown text NOT NULL DEFAULT 'automatic'
    CHECK (grades_shown IN ('automatic', 'manual')),
  ADD COLUMN grades_released_at timestamptz;
