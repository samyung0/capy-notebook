-- How an assignment's AI-marked parts (written and drawn) are marked (Epo
-- 2026-11-06, mock A4): the AI, with an owner's approval before members see the
-- marks (today's default), the AI alone, or staff by hand, with no model called
-- and no marking image made. It replaces the approval switch.
ALTER TABLE assignments
  ADD COLUMN marking text NOT NULL DEFAULT 'ai_approve'
    CHECK (marking IN ('ai_approve', 'ai', 'manual'));
UPDATE assignments SET marking = CASE WHEN approve_ai_marks THEN 'ai_approve' ELSE 'ai' END;
ALTER TABLE assignments DROP COLUMN approve_ai_marks;
