-- Only practice records progress (Epo 2026-11-03), and with the chat agent's
-- read_study_progress gone (Epo 2026-11-04) nothing reads what Mark as read and
-- Stop tracking left behind: file rows and removed rows go, and the table holds
-- one row per practised quiz or set.
DELETE FROM study_progress WHERE file_id IS NOT NULL OR state = 'removed';
ALTER TABLE study_progress DROP COLUMN file_id;
ALTER TABLE study_progress ALTER COLUMN material_id SET NOT NULL;
ALTER TABLE study_progress DROP CONSTRAINT study_progress_state_check;
ALTER TABLE study_progress ADD CONSTRAINT study_progress_state_check
  CHECK (state IN ('started','done'));
DROP INDEX study_progress_material_idx;
ALTER TABLE study_progress ADD PRIMARY KEY (user_id, material_id);
