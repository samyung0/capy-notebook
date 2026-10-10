-- Recorded review sessions (human/study-progress.md, 2026-10-10). A session's
-- row is written with its first answer, so a session opened and left
-- unanswered leaves nothing. Per user, never copied by clone or charged to
-- storage.

-- group_kind names what the session drew from: a chapter, the workspace's
-- items outside chapters (others) or the whole workspace. mode is the
-- suggestion's leading mode, NULL for a review started from the workspace
-- list. items is every item served, in order, so Continue can resume.
CREATE TABLE review_sessions (
  id             uuid PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id),
  workspace_id   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chapter_id     text,
  group_kind     text NOT NULL CHECK (group_kind IN ('chapter','others','workspace')),
  mode           text CHECK (mode IN ('tricky','fading','learned')),
  evidence       jsonb,
  items          jsonb NOT NULL,
  started_at     timestamptz NOT NULL,
  last_answer_at timestamptz NOT NULL,
  finished_at    timestamptz,
  -- A deleted chapter leaves the session without one; it keeps its answers.
  FOREIGN KEY (chapter_id, workspace_id)
    REFERENCES chapters(id, workspace_id) ON DELETE SET NULL (chapter_id)
);
CREATE INDEX review_sessions_user_idx ON review_sessions(user_id, started_at DESC);
CREATE INDEX review_sessions_workspace_idx ON review_sessions(workspace_id);

-- One answered item. A card has its rating; a question its score (correct of
-- total marks), the answers and the graded question with its key.
CREATE TABLE review_answers (
  session_id  uuid NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  item_id     text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('card','question')),
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 4),
  correct     double precision,
  total       double precision,
  answers     jsonb,
  graded      jsonb,
  answered_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, material_id, item_id)
);
CREATE INDEX review_answers_material_idx ON review_answers(material_id);

-- Suggestions read each item's latest ratings.
CREATE INDEX review_log_item_idx ON review_log(user_id, material_id, item_id, reviewed_at DESC);
