-- When the saved auto-reload card was saved: a reload card's save event is
-- skipped when the saved card is another one saved after that event's card
-- setup was created, so a late Stripe redelivery never brings back a replaced
-- card (Q783 A). NULL for a card saved before this column (no backfill: no
-- production data).
ALTER TABLE user_credits ADD COLUMN reload_pm_saved_at timestamptz;
