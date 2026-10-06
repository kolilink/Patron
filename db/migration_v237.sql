-- ============================================================
-- Patron — Migration v237
-- Run in Supabase SQL Editor AFTER migration_v236
--
-- Debt-aging reminder rebuild. The push the app already promises
-- (PaymentReminderAsker, the "Rappels de paiement" switch) never actually
-- fired: dispatch-notification had `debt_aging_reminder` as built:false, and
-- send-debt-reminders marked every debt "reminded" on any HTTP 200 — so it
-- recorded reminders that were skipped (not_built / cap / quiet_hours / no
-- recipients). This migration is the data half of the fix:
--
--  * ONE pipeline. get_due_debt_reminders()/mark_debt_reminder_sent()
--    (v202, per-DEBT pushes, no timezone, no aggregation, no opt-out) are
--    dropped and replaced by a per-BUSINESS daily digest. Not a third
--    pipeline — the replacement of the second.
--  * Cadence: 7 days and 30 days, each fires ONCE EVER per debt
--    (debt_reminder_fired, PK (sale_order_id, threshold_days) — permanent).
--    Max ONE push per business per Conakry day (debt_reminder_days). A debt
--    can generate at most 2 pushes in its lifetime. A debt already >= 30 days
--    old only ever gets the 30-day message (never a backdated, wrong
--    "une semaine"). Paid/cancelled debts (status <> 'credit' or nothing left
--    to pay) never qualify. The legacy debt_reminder_7d/30d_sent_at columns
--    (v200/v202) are still honored as "already fired".
--  * Marking is atomic with a CONFIRMED send: get_due_debt_reminder_digests
--    is read-only; confirm_debt_reminder_digest is called by the edge
--    function only when dispatch-notification's response body says sent > 0.
--  * Time is Africa/Conakry, named explicitly (never the session/server
--    zone): the delivery window is 08:00-21:00 local — nothing before 08:00
--    (overnight triggers wait in the queue = simply stay un-confirmed and
--    due; the first hourly run at 08:xx picks them up, later hours are the
--    retry safety net) and nothing in 21:00-07:00 quiet hours. Debt age is a
--    Conakry-local calendar-day difference. p_now is injectable for tests.
--  * profiles.debt_reminders_enabled backs the "Rappels de paiement" switch;
--    a business with no enabled admin/manager recipient is skipped and
--    nothing is marked (so a re-enable later does not lose the reminder).
--
-- No cron change: patron-debt-reminders (v201/v202, hourly) already calls
-- send-debt-reminders; the window lives in the function, not the schedule.
-- ============================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS debt_reminders_enabled boolean NOT NULL DEFAULT true;

DROP FUNCTION IF EXISTS get_due_debt_reminders(int);
DROP FUNCTION IF EXISTS mark_debt_reminder_sent(uuid, int);

CREATE TABLE IF NOT EXISTS debt_reminder_fired (
  sale_order_id  uuid        NOT NULL REFERENCES sale_orders(id) ON DELETE CASCADE,
  threshold_days int         NOT NULL CHECK (threshold_days > 0),
  business_id    uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  local_date     date        NOT NULL,
  fired_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sale_order_id, threshold_days)
);
CREATE INDEX IF NOT EXISTS idx_debt_reminder_fired_business ON debt_reminder_fired (business_id);

CREATE TABLE IF NOT EXISTS debt_reminder_days (
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  local_date  date        NOT NULL,
  count_7d    int         NOT NULL DEFAULT 0,
  count_30d   int         NOT NULL DEFAULT 0,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, local_date)
);

-- Service-role only, like djomi_pending_payments: RLS on, no policy, no grants.
ALTER TABLE debt_reminder_fired ENABLE ROW LEVEL SECURITY;
ALTER TABLE debt_reminder_days  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON debt_reminder_fired, debt_reminder_days FROM PUBLIC, anon, authenticated;
GRANT ALL ON debt_reminder_fired, debt_reminder_days TO service_role;

CREATE OR REPLACE FUNCTION get_due_debt_reminder_digests(
  p_now   timestamptz DEFAULT now(),
  p_limit int         DEFAULT NULL
)
RETURNS TABLE (
  business_id        uuid,
  local_date         date,
  count_7d           int,
  count_30d          int,
  single_client_id   uuid,
  recipient_user_ids uuid[],
  items              jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- The zone is NAMED, never inherited from the session or the server.
  c_tz    CONSTANT text := 'Africa/Conakry';
  v_local timestamp := p_now AT TIME ZONE c_tz;
  v_hour  int       := EXTRACT(HOUR FROM v_local)::int;
  v_today date      := v_local::date;
  v_t1    int;
  v_t2    int;
  v_limit int;
BEGIN
  -- Quiet hours 21:00-07:00, and nothing before 08:00: overnight triggers
  -- stay due (un-confirmed) and are delivered by the first run at >= 08:00.
  IF v_hour < 8 OR v_hour >= 21 THEN
    RETURN;
  END IF;

  v_t1 := COALESCE((SELECT value FROM app_config WHERE key = 'debt_reminder_threshold_1_days'), 7);
  v_t2 := COALESCE((SELECT value FROM app_config WHERE key = 'debt_reminder_threshold_2_days'), 30);
  v_limit := COALESCE(p_limit, (SELECT value FROM app_config WHERE key = 'debt_reminder_batch_size'), 50);

  RETURN QUERY
  WITH debts AS (
    SELECT
      so.business_id,
      so.id AS sale_order_id,
      so.client_id,
      v_today - COALESCE(so.sale_date, (so.created_at AT TIME ZONE c_tz)::date) AS age,
      so.debt_reminder_7d_sent_at,
      so.debt_reminder_30d_sent_at
    FROM sale_orders so
    WHERE so.status = 'credit'
      AND NULLIF(btrim(so.customer_name), '') IS NOT NULL
      AND (so.total_amount - COALESCE(so.discount_amount, 0)
            - COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id = so.id), 0)) > 0
  ),
  due AS (
    SELECT d.*,
           CASE WHEN d.age >= v_t2 THEN v_t2 ELSE v_t1 END AS threshold
    FROM debts d
    WHERE d.age >= v_t1
  ),
  open_due AS (
    SELECT du.*
    FROM due du
    WHERE NOT EXISTS (
            SELECT 1 FROM debt_reminder_fired f
            WHERE f.sale_order_id = du.sale_order_id AND f.threshold_days = du.threshold)
      AND (CASE WHEN du.threshold = v_t2 THEN du.debt_reminder_30d_sent_at
                ELSE du.debt_reminder_7d_sent_at END) IS NULL
  ),
  grouped AS (
    SELECT
      o.business_id,
      (count(*) FILTER (WHERE o.threshold = v_t1))::int AS c7,
      (count(*) FILTER (WHERE o.threshold = v_t2))::int AS c30,
      CASE WHEN count(*) = count(o.client_id) AND count(DISTINCT o.client_id) = 1
           THEN (array_agg(o.client_id))[1] END AS single_client,
      jsonb_agg(jsonb_build_object('sale_order_id', o.sale_order_id, 'threshold_days', o.threshold)
                ORDER BY o.age DESC) AS items,
      min(o.age) AS min_age
    FROM open_due o
    WHERE NOT EXISTS (
      SELECT 1 FROM debt_reminder_days dd
      WHERE dd.business_id = o.business_id AND dd.local_date = v_today)
    GROUP BY o.business_id
  )
  SELECT g.business_id, v_today, g.c7, g.c30, g.single_client, r.recipients, g.items
  FROM grouped g
  CROSS JOIN LATERAL (
    SELECT COALESCE(array_agg(m.user_id ORDER BY m.user_id), ARRAY[]::uuid[]) AS recipients
    FROM memberships m
    JOIN profiles p ON p.id = m.user_id
    WHERE m.business_id = g.business_id
      AND m.role IN ('administrateur', 'manager')
      AND p.debt_reminders_enabled
  ) r
  WHERE cardinality(r.recipients) > 0
  ORDER BY g.min_age DESC, g.business_id
  LIMIT v_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_due_debt_reminder_digests(timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_due_debt_reminder_digests(timestamptz, int) TO service_role;

-- Called by send-debt-reminders ONLY after dispatch-notification confirmed
-- sent > 0 for this digest. Idempotent. Returns false (and marks nothing)
-- when this business already has a push recorded for the day — the
-- one-per-day cap is enforced here, not just by the caller's good behavior.
CREATE OR REPLACE FUNCTION confirm_debt_reminder_digest(
  p_business_id uuid,
  p_local_date  date,
  p_items       jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_t2   int := COALESCE((SELECT value FROM app_config WHERE key = 'debt_reminder_threshold_2_days'), 30);
  v_rows int;
BEGIN
  INSERT INTO debt_reminder_days (business_id, local_date)
  VALUES (p_business_id, p_local_date)
  ON CONFLICT (business_id, local_date) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO debt_reminder_fired (sale_order_id, threshold_days, business_id, local_date)
  SELECT so.id, i.threshold_days, p_business_id, p_local_date
  FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb)) AS i(sale_order_id uuid, threshold_days int)
  JOIN sale_orders so ON so.id = i.sale_order_id AND so.business_id = p_business_id
  ON CONFLICT (sale_order_id, threshold_days) DO NOTHING;

  UPDATE debt_reminder_days d SET
    count_7d  = (SELECT count(*) FROM debt_reminder_fired f
                 WHERE f.business_id = p_business_id AND f.local_date = p_local_date AND f.threshold_days < v_t2),
    count_30d = (SELECT count(*) FROM debt_reminder_fired f
                 WHERE f.business_id = p_business_id AND f.local_date = p_local_date AND f.threshold_days >= v_t2)
  WHERE d.business_id = p_business_id AND d.local_date = p_local_date;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION confirm_debt_reminder_digest(uuid, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION confirm_debt_reminder_digest(uuid, date, jsonb) TO service_role;
