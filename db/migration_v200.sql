-- ============================================================
-- Patron — Migration v200
-- Run in Supabase SQL Editor AFTER migration_v199
--
-- Payment reminder notifications for aged debts — the v1 reminder earned by
-- the new "Ne ratez aucun paiement" permission-priming sheet (client-side).
-- Two thresholds, mirroring src/utils/clientReminder.ts's debtAgeTier()
-- exactly (7 days = the existing "attention"/amber tier, 30 days = the
-- existing "urgent"/red tier) — this feature does not invent a new age
-- scale, it just gives the already-established one a push notification.
--
-- Aging is anchored on the same (sale_date, falling back to created_at::date)
-- pair clients/index.tsx's own daysOldestDebt computation already uses, so a
-- debt's "age" can never read differently between the app and this reminder.
--
-- Tracking is two nullable timestamps directly on sale_orders (mirrors
-- businesses.activation_nudge_1_sent_at/_2_sent_at's own shape) rather than a
-- separate table — a "debt" here always is one sale_orders row (status =
-- 'credit'), never an aggregate across a client's several debts, so there's
-- nothing a join-table would buy.
-- ============================================================

ALTER TABLE sale_orders ADD COLUMN debt_reminder_7d_sent_at timestamptz;
ALTER TABLE sale_orders ADD COLUMN debt_reminder_30d_sent_at timestamptz;

INSERT INTO app_config (key, value) VALUES
  ('debt_reminder_threshold_1_days', 7),
  ('debt_reminder_threshold_2_days', 30)
ON CONFLICT (key) DO NOTHING;

-- Run hourly by the send-debt-reminders cron. Finds every still-outstanding
-- credit sale that just crossed either threshold and hasn't been reminded
-- for that threshold yet, marks it, and returns what's needed to build the
-- push (business, client, remaining balance, currency, which threshold).
--
-- Quiet hours (8h-20h UTC — Guinea has no DST, so UTC is local) are enforced
-- as a hard early-return, not a filter on individual rows: a threshold that
-- crosses overnight simply isn't eligible to be found-and-marked until the
-- first run inside the window the next morning, which is exactly the
-- "delivered at 8h" behavior wanted — no separate "pending" state needed.
--
-- Two independent thresholds on the same table are updated as two
-- SEQUENTIAL statements (capture the qualifying id arrays first, then two
-- plain UPDATEs), never as sibling data-modifying CTEs in one WITH clause —
-- a debt already past both thresholds with neither ever sent (e.g. this
-- feature's very first run against an already-45-day-old debt) is a target
-- row of both at once, and migration_v169.sql already found that
-- "unpredictable" in Postgres for concurrent CTEs sharing a target table.
CREATE OR REPLACE FUNCTION get_and_mark_debt_reminders()
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
  v_hour   int := EXTRACT(HOUR FROM now())::int;
  v_t1     int;
  v_t2     int;
  v_ids_30 uuid[];
  v_ids_7  uuid[];
BEGIN
  IF v_hour < 8 OR v_hour >= 20 THEN
    RETURN;
  END IF;

  SELECT value INTO v_t1 FROM app_config WHERE key = 'debt_reminder_threshold_1_days';
  SELECT value INTO v_t2 FROM app_config WHERE key = 'debt_reminder_threshold_2_days';

  SELECT array_agg(so.id) INTO v_ids_30
  FROM sale_orders so
  WHERE so.status = 'credit'
    AND so.customer_name IS NOT NULL
    AND so.debt_reminder_30d_sent_at IS NULL
    AND current_date - COALESCE(so.sale_date, so.created_at::date) >= v_t2;

  SELECT array_agg(so.id) INTO v_ids_7
  FROM sale_orders so
  WHERE so.status = 'credit'
    AND so.customer_name IS NOT NULL
    AND so.debt_reminder_7d_sent_at IS NULL
    AND current_date - COALESCE(so.sale_date, so.created_at::date) >= v_t1;

  IF v_ids_30 IS NOT NULL THEN
    UPDATE sale_orders SET debt_reminder_30d_sent_at = now() WHERE id = ANY(v_ids_30);
  END IF;

  IF v_ids_7 IS NOT NULL THEN
    UPDATE sale_orders SET debt_reminder_7d_sent_at = now() WHERE id = ANY(v_ids_7);
  END IF;

  RETURN QUERY
  SELECT
    so.business_id,
    so.id,
    so.customer_name,
    so.client_id,
    (so.total_amount - COALESCE(so.discount_amount, 0)
      - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id = so.id), 0)
    )::bigint,
    b.currency,
    v_t2
  FROM sale_orders so
  JOIN businesses b ON b.id = so.business_id
  WHERE v_ids_30 IS NOT NULL AND so.id = ANY(v_ids_30)

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
    v_t1
  FROM sale_orders so
  JOIN businesses b ON b.id = so.business_id
  WHERE v_ids_7 IS NOT NULL AND so.id = ANY(v_ids_7);
END;
$$;

-- REVOKE ... FROM PUBLIC alone is not enough — see migration_v137.sql for
-- why anon/authenticated need an explicit revoke too on this Supabase stack.
REVOKE EXECUTE ON FUNCTION get_and_mark_debt_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_debt_reminders() TO service_role;
