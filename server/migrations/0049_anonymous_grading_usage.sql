-- Signed-out visitors' Jev grading of shared standalone quizzes
-- (anonymous-study-plan.md, 2026-10-02). usage_events needs an actor, so
-- anonymous use is kept here per UTC day, salted client-IP hash and the random
-- id the browser keeps in IndexedDB. The IP hash enforces the daily caps; the
-- local id is reporting only because the client chooses it. Rows older than 30
-- days are deleted by the API's maintenance loop.
CREATE TABLE anonymous_grading_usage (
  day            date NOT NULL,
  ip_hash        text NOT NULL,
  local_id       text NOT NULL DEFAULT '' CHECK (char_length(local_id) <= 64),
  parts          integer NOT NULL DEFAULT 0 CHECK (parts >= 0),
  input_tokens   bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, ip_hash, local_id)
);
