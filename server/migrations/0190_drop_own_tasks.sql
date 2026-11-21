-- Tasks one sets oneself are gone (Epo 2026-11-21: "remove those, so the
-- teacher self task also gone"): personal study is practice, and a class's
-- To do is what its staff gave out. Every assignment is a class's again, made
-- by its staff. No production data (no-legacy-data): each task goes with its
-- attempts, ticks, hand-ins, frozen images and owned quiz, all of which cascade.
DELETE FROM assignments WHERE own;

DROP INDEX assignments_own_idx;
ALTER TABLE assignments DROP CONSTRAINT assignments_workspace_check;
ALTER TABLE assignments DROP CONSTRAINT assignments_points_kind;
ALTER TABLE assignments DROP COLUMN own;
ALTER TABLE assignments ALTER COLUMN workspace_id SET NOT NULL;

-- Points grade what members hand in (Epo 2026-11-21): an Assignment taking
-- no uploads is only ticked done, so it has no points, grades or late penalty.
DELETE FROM assignment_grades g USING assignments a
WHERE a.id=g.assignment_id AND a.points IS NOT NULL AND NOT a.allow_uploads;
UPDATE assignments SET points=NULL, late_penalty_pct=0
WHERE points IS NOT NULL AND NOT allow_uploads;
ALTER TABLE assignments ADD CONSTRAINT assignments_points_kind
  CHECK (points IS NULL OR (kind = 'unmarked' AND allow_uploads));
