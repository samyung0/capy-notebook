CREATE TABLE bank_editors (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
