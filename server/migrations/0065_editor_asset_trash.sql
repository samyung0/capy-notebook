-- A note's editor asset that a save stops using goes to a hidden trash for one
-- day instead of being deleted, like the note's embedded quizzes and sets
-- (human/authorization-permissions-lifecycles.md, 2026-10-06): undo, cut and
-- paste or a replayed draft brings it back, a paste elsewhere copies it, and it
-- stays charged until the trash sweep deletes the row.
ALTER TABLE editor_assets ADD COLUMN trashed_at timestamptz;
CREATE INDEX editor_assets_trashed_idx ON editor_assets (trashed_at)
  WHERE trashed_at IS NOT NULL;
