-- A tick on To do that is not the work itself (Epo 2026-11-10): a member's on
-- a marked assignment or one handed in with files, which submitting or handing
-- in ticks on its own, and staff's on the answers waiting for them
-- (`approvals`), which a later submission unticks. Only To do reads it.
CREATE TABLE assignment_todo_checks (
  assignment_id text NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approvals     boolean NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, user_id, approvals)
);
CREATE INDEX assignment_todo_checks_user_idx ON assignment_todo_checks(user_id);

-- Rows taken off the caller's Done tab (Epo 2026-11-10: Delete there removes
-- it from their own To do only). It hides what was finished up to hidden_at: a
-- later submission or tick shows the row on Done again.
CREATE TABLE assignment_todo_hidden (
  assignment_id text NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (assignment_id, user_id)
);
CREATE INDEX assignment_todo_hidden_user_idx ON assignment_todo_hidden(user_id);
