-- Purchased credits: top-ups, auto-reload and the monthly spending limit.
--
-- purchased_micros never expires and spends after the monthly allowance. It is
-- signed: overrun from already-admitted work leaves it negative (credits owed),
-- carried across months until credits come in. Its default is the one-off
-- 800-credit starter grant every new account gets.
ALTER TABLE user_credits
  ADD COLUMN IF NOT EXISTS purchased_micros bigint NOT NULL DEFAULT 800000000,
  -- Owed credits the monthly rollover moved into this period's used_micros,
  -- shown on the Usage tab as owed from the previous month.
  ADD COLUMN IF NOT EXISTS carried_micros bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_reload_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reload_amount_cents int NOT NULL DEFAULT 1000
    CHECK (reload_amount_cents BETWEEN 800 AND 10000),
  ADD COLUMN IF NOT EXISTS reload_threshold_micros bigint NOT NULL DEFAULT 0
    CHECK (reload_threshold_micros >= 0),
  -- The saved off-session payment method auto-reload charges. Only card and
  -- link are instant; anything else is shown and refused.
  ADD COLUMN IF NOT EXISTS reload_pm_id text,
  ADD COLUMN IF NOT EXISTS reload_pm_type text,
  ADD COLUMN IF NOT EXISTS reload_pm_brand text,
  ADD COLUMN IF NOT EXISTS reload_pm_last4 text,
  ADD COLUMN IF NOT EXISTS reload_pm_exp_month int,
  ADD COLUMN IF NOT EXISTS reload_pm_exp_year int,
  -- NULL means no limit. Counts pre-tax dollars per UTC calendar month.
  ADD COLUMN IF NOT EXISTS spending_limit_cents int
    CHECK (spending_limit_cents > 0),
  -- Set when a reload starts (the worker at the threshold, or the first
  -- request that finds credits at zero); work is admitted at zero for 60
  -- seconds after it.
  ADD COLUMN IF NOT EXISTS reload_started_at timestamptz,
  -- One reload per arming: starting a reload disarms it; turning auto-reload
  -- on, a paid top-up, a new card, or a paid reload that leaves credits above
  -- the threshold re-arms it. The monthly allowance never does.
  ADD COLUMN IF NOT EXISTS reload_armed boolean NOT NULL DEFAULT true,
  -- Set when a reload was skipped because it would pass the spending limit.
  ADD COLUMN IF NOT EXISTS reload_skipped_at timestamptz;

-- One row per top-up or auto-reload, keyed by its Stripe objects so webhook
-- grants and reversals are idempotent.
CREATE TABLE IF NOT EXISTS credit_purchases (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('topup', 'reload')),
  -- charging: the reload worker is calling Stripe. retrying: the charge failed
  -- and Stripe retries it. failed: Stripe stopped retrying, the invoice stays
  -- open with its Pay link. void: cancelled by a manual top-up.
  status             text NOT NULL
    CHECK (status IN ('charging', 'retrying', 'failed', 'paid', 'void')),
  amount_cents       int NOT NULL CHECK (amount_cents > 0),
  -- The card a reload charges, fixed at claim so a resumed charge reuses it.
  reload_pm_id       text,
  credits_micros     bigint NOT NULL CHECK (credits_micros > 0),
  stripe_checkout_session_id text UNIQUE,
  stripe_invoice_id  text UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  next_attempt_at    timestamptz,
  decline_reason     text,
  -- Credits taken back by refunds (cumulative) and held by an open or lost
  -- dispute.
  refunded_micros    bigint NOT NULL DEFAULT 0,
  disputed_micros    bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz
);
CREATE INDEX IF NOT EXISTS credit_purchases_user_idx
  ON credit_purchases(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_purchases_charging_idx
  ON credit_purchases(created_at) WHERE status = 'charging';

-- Rolls the counter into the current UTC month. Owed credits come off the new
-- monthly allowance first; whatever the allowance cannot cover stays owed.
CREATE OR REPLACE FUNCTION roll_user_credits(p_user_id text, p_limit bigint)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  this_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
BEGIN
  INSERT INTO user_credits (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;
  UPDATE user_credits
  SET period_start = this_month,
      used_micros = LEAST(GREATEST(-purchased_micros, 0), p_limit),
      carried_micros = LEAST(GREATEST(-purchased_micros, 0), p_limit),
      purchased_micros = purchased_micros + LEAST(GREATEST(-purchased_micros, 0), p_limit),
      updated_at = now()
  WHERE user_id = p_user_id AND period_start < this_month;
END;
$$;

-- Applies settled spend: the monthly allowance first, the rest from the
-- purchased balance, which may go negative.
CREATE OR REPLACE FUNCTION spend_user_credits(p_user_id text, p_micros bigint, p_limit bigint)
RETURNS TABLE (used_micros bigint, purchased_micros bigint)
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM roll_user_credits(p_user_id, p_limit);
  RETURN QUERY
  UPDATE user_credits c
  SET used_micros = c.used_micros + LEAST(p_micros, GREATEST(p_limit - c.used_micros, 0)),
      purchased_micros = c.purchased_micros
        - (p_micros - LEAST(p_micros, GREATEST(p_limit - c.used_micros, 0))),
      updated_at = now()
  WHERE c.user_id = p_user_id
  RETURNING c.used_micros, c.purchased_micros;
END;
$$;

-- True while a started reload's 60-second window admits new work at zero.
CREATE OR REPLACE FUNCTION credit_reload_pending(p_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_credits c
    WHERE c.user_id = p_user_id
      AND c.reload_started_at > now() - interval '60 seconds'
  );
$$;

-- Starts an armed auto-reload for a request that found credits at zero, which
-- opens the 60-second window; the worker charges it. False when none can start.
CREATE OR REPLACE FUNCTION claim_credit_reload(p_user_id text)
RETURNS boolean
LANGUAGE sql
AS $$
  WITH claimed AS (
    UPDATE user_credits c
    SET reload_started_at = now(), reload_armed = false, updated_at = now()
    WHERE c.user_id = p_user_id
      AND c.reload_armed
      AND c.auto_reload_enabled
      AND c.reload_started_at IS NULL
      AND c.reload_pm_type IN ('card', 'link')
      AND (c.reload_skipped_at IS NULL
        OR c.reload_skipped_at < date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      AND NOT EXISTS (
        SELECT 1 FROM credit_purchases p
        WHERE p.user_id = c.user_id AND p.kind = 'reload'
          AND p.status IN ('charging', 'retrying')
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

-- The application roles own these; the ops roles must not run them.
REVOKE EXECUTE ON FUNCTION roll_user_credits(text, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION spend_user_credits(text, bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION credit_reload_pending(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_credit_reload(text) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capy_ops') THEN
    GRANT SELECT (purchased_micros, carried_micros) ON user_credits TO capy_ops;
  END IF;
END
$grant$;
