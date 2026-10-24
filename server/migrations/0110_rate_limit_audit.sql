-- Rate-limit audit (2026-10-24). Signed-in grading counts open parts per user
-- and UTC day before any Jev call. Daily usage rows keep 30 days
-- (PruneDailyUsage).
CREATE TABLE grading_usage (
  day     date NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parts   integer NOT NULL CHECK (parts >= 0),
  PRIMARY KEY (day, user_id)
);

-- Invites (and resends) one owner sends per UTC day, counted as they are made.
CREATE TABLE invite_usage (
  day     date NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invites integer NOT NULL CHECK (invites >= 0),
  PRIMARY KEY (day, user_id)
);

-- A user's open top-up and card Checkout pages, reused instead of a new
-- Stripe session per click; a completed one is dropped by its webhook.
CREATE TABLE credit_checkouts (
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('topup','reload_method')),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  session_id   text NOT NULL UNIQUE,
  url          text NOT NULL,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- A question-bank comment is stored as a notice; a job every 4 hours sends
-- each recipient one email holding its unsent notices and marks them sent
-- (Epo 2026-10-24, Q243). Temporary until a shared pipeline for content
-- notices exists. The account purge deletes an author's notices.
CREATE TABLE bank_comment_notices (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient  text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

-- The thinking canvas is removed whole (Epo 2026-10-24, Q242): no data
-- exists, and a replacement is planned.
DROP TABLE canvases;
