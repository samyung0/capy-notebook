-- The note merge view's unexpected failures (human/frontend/error-handling.md,
-- 2026-10-24, Q261): a choice on a piece that throws, reported by the browser
-- with the piece's source as its reason. What the user resolves (pieces
-- entering the view, hidden typing) is never recorded.
ALTER TABLE edit_incidents DROP CONSTRAINT edit_incidents_kind_check;
ALTER TABLE edit_incidents ADD CONSTRAINT edit_incidents_kind_check CHECK (kind IN (
  -- Collaboration service.
  'save_refused', 'discard_unsaved', 'epoch_reset', 'over_limit',
  'slow_save_limit', 'step2_unplaced',
  -- Browser.
  'other_epoch_draft', 'draft_unrestorable', 'draft_storage_failed',
  'unconfirmed_edit', 'offline_episode', 'merge_view'
));
