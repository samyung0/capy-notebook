-- The saved auto-reload card's starter-grant key (Stripe's card fingerprint),
-- so Usage can say when that card already earned another account's starter
-- credits. NULL for a Link method or no saved method.
ALTER TABLE user_credits ADD COLUMN reload_pm_card_key text;
