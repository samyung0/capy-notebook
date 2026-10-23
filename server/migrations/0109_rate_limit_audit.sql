-- Rate-limit audit (2026-10-24). Signed-out grading also counts per shared
-- link (the verified share token's item), so one link cannot take the global
-- daily pool. Signed-in grading counts open parts per user and UTC day before
-- any Jev call. Daily usage rows keep 30 days (PruneDailyUsage).
ALTER TABLE anonymous_grading_usage ADD COLUMN link_id text NOT NULL DEFAULT '';
ALTER TABLE anonymous_grading_usage DROP CONSTRAINT anonymous_grading_usage_pkey;
ALTER TABLE anonymous_grading_usage ADD PRIMARY KEY (day, ip_hash, local_id, link_id);

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
