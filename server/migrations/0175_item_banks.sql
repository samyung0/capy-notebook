-- Item banks (Epo 2026-11-14, todo-graded-quizzes.md): questions kept for
-- reuse, in the shared question format with free-text tags. A person's own
-- bank (user_id) is theirs alone; a class workspace's (workspace_id) is its
-- owner's and editors'. A question is copied in (Add to bank, New question)
-- and copied out into a quiz, never linked. Deleting the workspace deletes
-- its bank; an account purge deletes the personal one (account_purge.go).
CREATE TABLE item_bank_questions (
  id           text PRIMARY KEY,
  user_id      text REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  question     jsonb NOT NULL,
  tags         text[] NOT NULL DEFAULT '{}',
  -- Lowercased stem, part and answer text for Search (questions.SearchText).
  search_text  text NOT NULL DEFAULT '',
  created_by   text REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_bank_questions_bank_check CHECK ((user_id IS NULL) <> (workspace_id IS NULL))
);
CREATE INDEX item_bank_questions_user_idx ON item_bank_questions(user_id, created_at DESC, id DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX item_bank_questions_workspace_idx ON item_bank_questions(workspace_id, created_at DESC, id DESC)
  WHERE workspace_id IS NOT NULL;

-- A bank question's images and drawn samples: copies charged to whoever put
-- them there (uploader pays), deleted with the question.
ALTER TABLE editor_assets ADD COLUMN bank_question_id text REFERENCES item_bank_questions(id) ON DELETE CASCADE;
CREATE INDEX editor_assets_bank_question_idx ON editor_assets(bank_question_id) WHERE bank_question_id IS NOT NULL;
ALTER TABLE editor_assets
  DROP CONSTRAINT editor_assets_owner_check,
  ADD CONSTRAINT editor_assets_owner_check CHECK (
    workspace_id IS NOT NULL OR material_id IS NOT NULL OR assignment_id IS NOT NULL OR bank_question_id IS NOT NULL
  );
