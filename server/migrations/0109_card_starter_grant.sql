-- The one-off 800-credit starter grant comes with the first saved card instead
-- of with the account: purchased_micros starts at zero.
ALTER TABLE user_credits ALTER COLUMN purchased_micros SET DEFAULT 0;

-- One starter grant per account and per card. card_key is Stripe's card
-- fingerprint; nothing else about the card is kept here. Rows outlive an account purge, so the same card cannot
-- claim the grant again on a new account.
CREATE TABLE starter_grants (
  user_id    text PRIMARY KEY REFERENCES users(id),
  card_key   text NOT NULL UNIQUE,
  granted_at timestamptz NOT NULL DEFAULT now()
);
