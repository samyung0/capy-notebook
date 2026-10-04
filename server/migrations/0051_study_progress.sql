-- Per-user study progress and review state (todo-learning.md, part 1).
-- No progress data is kept: shared card scheduling, mistakes and the
-- card-state undo restores are dropped. card_stats keeps its card -> set rows
-- as flashcard_cards, the lookup card edits and deletes still need.

ALTER TABLE users ADD COLUMN study_progress boolean NOT NULL DEFAULT true;

-- A workspace row overrides the user's global default.
CREATE TABLE workspace_study (
  user_id      text NOT NULL REFERENCES users(id),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

-- One row per touched file or material; no row means never touched.
CREATE TABLE study_progress (
  user_id      text NOT NULL REFERENCES users(id),
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id      text REFERENCES files(id) ON DELETE CASCADE,
  material_id  text REFERENCES materials(id) ON DELETE CASCADE,
  state        text NOT NULL CHECK (state IN ('started','done','removed')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((file_id IS NULL) <> (material_id IS NULL))
);
CREATE UNIQUE INDEX study_progress_file_idx ON study_progress(user_id, file_id) WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX study_progress_material_idx ON study_progress(user_id, material_id) WHERE material_id IS NOT NULL;
CREATE INDEX study_progress_workspace_idx ON study_progress(workspace_id, user_id);

-- FSRS memory state per quiz question or flashcard, per user. item_hash is
-- the item's prompt and answer key; a mismatch means the item is new.
CREATE TABLE review_states (
  user_id     text NOT NULL REFERENCES users(id),
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  item_id     text NOT NULL,
  item_hash   text NOT NULL,
  stability   double precision NOT NULL,
  difficulty  double precision NOT NULL,
  reps        int NOT NULL,
  lapses      int NOT NULL,
  fsrs_state  smallint NOT NULL,
  last_review timestamptz NOT NULL,
  PRIMARY KEY (user_id, material_id, item_id)
);
CREATE INDEX review_states_material_idx ON review_states(material_id);

-- Append-only, for offline merge and parameter fitting later.
CREATE TABLE review_log (
  user_id     text NOT NULL REFERENCES users(id),
  material_id text NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  item_id     text NOT NULL,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 4),
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_log_user_idx ON review_log(user_id, reviewed_at);
CREATE INDEX review_log_material_idx ON review_log(material_id);

DROP INDEX card_stats_due_idx;
ALTER TABLE card_stats DROP COLUMN srs, DROP COLUMN known;
ALTER TABLE card_stats RENAME TO flashcard_cards;
ALTER INDEX card_stats_material_idx RENAME TO flashcard_cards_material_idx;
ALTER INDEX card_stats_pkey RENAME TO flashcard_cards_pkey;

DROP TABLE agent_card_state_restores;
DROP TABLE mistakes;
