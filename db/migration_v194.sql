-- ============================================================
-- Patron — Migration v194
-- Run in Supabase SQL Editor AFTER migration_v193
--
-- Fixes a real bug in migration_v192.sql's get_and_mark_debt_reminders(),
-- found live in production, not caught before it shipped: it marked every
-- due debt's sent_at column BEFORE send-debt-reminders ever attempted to
-- notify a single one of them. On this feature's actual first production
-- run (a one-time backlog of 488 real debts already past a threshold),
-- send-debt-reminders' own tight loop of `await fetch(dispatch-notification)`
-- tripped Supabase's platform-level outbound-fetch rate limit almost
-- immediately ("RateLimitError: Rate limit exceeded for function. Retry
-- after 54099ms") — which threw, uncaught, out of the whole function. Net
-- effect: all 488 debts were permanently marked "reminded" while zero
-- notifications were ever actually sent (confirmed via notification_log —
-- zero debt_aging_reminder rows). Since the RPC's own idempotency guard
-- (never re-check a debt whose sent_at is already set) is the mechanism
-- that's supposed to prevent double-notifying, this bug would have
-- permanently, silently starved every one of those 488 real debts of ever
-- being reminded. Manually reset back to NULL in production before this
-- migration was written — this fix is what stops it from recurring.
--
-- The real fix: marking-as-sent must be atomic with a CONFIRMED successful
-- send, never eager. Split the old single RPC into two:
--   1. get_due_debt_reminders(p_limit) — read-only, marks nothing, returns
--      up to p_limit oldest-first candidates (so a large backlog is worked
--      through gradually across several hourly runs instead of all at once,
--      which is also what keeps each run comfortably under both the
--      rate limit and any function execution-time budget).
--   2. mark_debt_reminder_sent(sale_order_id, threshold_days) — called by
--      the edge function ONLY after that specific dispatch-notification
--      call actually returned ok. A debt the edge function never got to, or
--      failed to send, simply stays unmarked and is picked up again next
--      hour — the same "isolated per-item, one failure can't poison the
--      batch" posture process-scheduled-account-deletions already uses.
-- ============================================================

DROP FUNCTION IF EXISTS get_and_mark_debt_reminders();

INSERT INTO app_config (key, value) VALUES
  ('debt_reminder_batch_size', 50)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION get_due_debt_reminders(p_limit int DEFAULT NULL)
RETURNS TABLE (
  business_id     uuid,
  sale_order_id   uuid,
  client_name     text,
  client_id       uuid,
  remaining_cents bigint,
  currency        text,
  threshold_days  int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hour  int := EXTRACT(HOUR FROM now())::int;
  v_t1    int;
  v_t2    int;
  v_limit int;
BEGIN
  IF v_hour < 8 OR v_hour >= 20 THEN
    RETURN;
  END IF;

  SELECT value INTO v_t1 FROM app_config WHERE key = 'debt_reminder_threshold_1_days';
  SELECT value INTO v_t2 FROM app_config WHERE key = 'debt_reminder_threshold_2_days';
  v_limit := COALESCE(p_limit, (SELECT value FROM app_config WHERE key = 'debt_reminder_batch_size'), 50);

  RETURN QUERY
  WITH candidates AS (
    SELECT
      so.business_id,
      so.id AS sale_order_id,
      so.customer_name AS client_name,
      so.client_id,
      (so.total_amount - COALESCE(so.discount_amount, 0)
        - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id = so.id), 0)
      )::bigint AS remaining_cents,
      b.currency,
      v_t2 AS threshold_days,
      COALESCE(so.sale_date, so.created_at::date) AS debt_date
    FROM sale_orders so
    JOIN businesses b ON b.id = so.business_id
    WHERE so.status = 'credit'
      AND so.customer_name IS NOT NULL
      AND so.debt_reminder_30d_sent_at IS NULL
      AND current_date - COALESCE(so.sale_date, so.created_at::date) >= v_t2

    UNION ALL

    SELECT
      so.business_id,
      so.id,
      so.customer_name,
      so.client_id,
      (so.total_amount - COALESCE(so.discount_amount, 0)
        - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id = so.id), 0)
      )::bigint,
      b.currency,
      v_t1,
      COALESCE(so.sale_date, so.created_at::date)
    FROM sale_orders so
    JOIN businesses b ON b.id = so.business_id
    WHERE so.status = 'credit'
      AND so.customer_name IS NOT NULL
      AND so.debt_reminder_7d_sent_at IS NULL
      AND current_date - COALESCE(so.sale_date, so.created_at::date) >= v_t1
      -- Deliberate, and different from migration_v192.sql's original
      -- (buggy) version: a debt already >= 30 days old only ever gets the
      -- 30d message, never a backdated 7d one too. Sending "depuis 7 jours"
      -- for a debt that's actually 40 days old would be factually wrong at
      -- the moment it's read, not just late — this upper bound is what
      -- keeps every message accurate at send time, backlog or not.
      AND current_date - COALESCE(so.sale_date, so.created_at::date) < v_t2
  )
  SELECT c.business_id, c.sale_order_id, c.client_name, c.client_id, c.remaining_cents, c.currency, c.threshold_days
  FROM candidates c
  ORDER BY c.debt_date ASC
  LIMIT v_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_due_debt_reminders(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_due_debt_reminders(int) TO service_role;

-- Deliberately no ownership/business check beyond "this exact (id,
-- threshold) pair" — the caller is always send-debt-reminders itself,
-- service-role-only, immediately after a confirmed-ok dispatch-notification
-- response for that exact row from get_due_debt_reminders above.
CREATE OR REPLACE FUNCTION mark_debt_reminder_sent(p_sale_order_id uuid, p_threshold_days int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_threshold_days >= 30 THEN
    UPDATE sale_orders SET debt_reminder_30d_sent_at = now() WHERE id = p_sale_order_id;
  ELSE
    UPDATE sale_orders SET debt_reminder_7d_sent_at = now() WHERE id = p_sale_order_id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION mark_debt_reminder_sent(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_debt_reminder_sent(uuid, int) TO service_role;

-- Re-schedule with the same job name (replaces the v193 command in place)
-- plus an explicit, generous timeout_milliseconds — pg_net's own default is
-- only 5000ms, which is what let the original bug's symptom look like a
-- plain timeout at first. A capped 50-item batch with per-item throttling
-- should finish in well under this, but there's no reason to leave the
-- default razor-thin margin in place now that it's known to matter.
SELECT cron.schedule(
  'patron-debt-reminders',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://jnxpujsyvbenqgjbvifh.supabase.co/functions/v1/send-debt-reminders',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'patron_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
