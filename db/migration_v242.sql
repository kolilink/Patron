-- ============================================================
-- migration_v242 — get_dashboard_kpis: revenue windows in the merchant's timezone
--
-- v241 fixed sale_date for the quick paths; sales_today/revenue_today already
-- followed the client's local date (p_today). But revenue_yesterday,
-- revenue_month and revenue_last_month still filtered paid_at against UTC
-- midnight boundaries (v_today::timestamptz in a UTC session), so for a
-- non-UTC business a late-evening sale was credited to the wrong day/month.
--
-- FIX: new trailing param p_tz (IANA name from the device); the four window
-- boundaries become `local_midnight AT TIME ZONE p_tz`. Semantics are
-- unchanged — still paid_at-based (a credit sale counts when it is paid, in
-- the day it was paid) — only the boundary moves. NULL / unknown p_tz -> UTC,
-- i.e. exactly the old behaviour, so old clients and Guinea (UTC+0) are
-- unchanged. SUPERSET of v240's body: every query/key identical.
--
-- Signature change (uuid,date) -> (uuid,date,text): old overload dropped
-- (see migration_v132/v186). search_path pinned public, pg_temp (v233).
-- _resolve_tz is an internal helper: never callable by an API role.
-- ============================================================

CREATE OR REPLACE FUNCTION public._resolve_tz(p_tz text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  IF p_tz IS NULL OR btrim(p_tz) = '' THEN RETURN 'UTC'; END IF;
  PERFORM now() AT TIME ZONE p_tz;   -- raises on an unknown zone
  RETURN p_tz;
EXCEPTION WHEN OTHERS THEN
  RETURN 'UTC';
END;
$$;
REVOKE EXECUTE ON FUNCTION public._resolve_tz(text) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.get_dashboard_kpis(uuid, date);

CREATE OR REPLACE FUNCTION public.get_dashboard_kpis(p_business_id uuid, p_today date DEFAULT NULL::date, p_tz text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today          date        := COALESCE(p_today, CURRENT_DATE);
  v_yesterday      date        := v_today - 1;
  v_month_start    date        := date_trunc('month', v_today)::date;
  -- [v242] the merchant's IANA timezone (device-reported; unknown/invalid -> UTC,
  -- the previous behaviour). Every paid_at window below is the LOCAL day/month
  -- boundary expressed as timestamptz, so a late-evening sale lands on the day
  -- the merchant actually lived it. Still a plain range on paid_at (index-friendly).
  v_today_ts       timestamptz := v_today::timestamp AT TIME ZONE public._resolve_tz(p_tz);
  v_yest_ts        timestamptz := v_yesterday::timestamp AT TIME ZONE public._resolve_tz(p_tz);
  v_month_ts       timestamptz := v_month_start::timestamp AT TIME ZONE public._resolve_tz(p_tz);
  v_prev_month_ts  timestamptz := (v_month_start - interval '1 month')::date::timestamp AT TIME ZONE public._resolve_tz(p_tz);

  v_revenue_today     bigint := 0;
  v_revenue_yesterday bigint := 0;
  v_revenue_month     bigint := 0;
  v_revenue_last_month bigint := 0;
  v_sales_today       int    := 0;
  v_credit_total      bigint := 0;
  v_credit_count      int    := 0;
  v_expenses_month    bigint := 0;
  v_low_stock         int    := 0;
  v_first_sale_at     timestamptz;
  -- [v232] a vendeur's Accueil is THEIR numbers: every sale/expense aggregate
  -- below is narrowed to their own rows (NULL = no narrowing: admin/manager/
  -- investisseur). Mirrors RLS (sale_orders: seller_id = auth.uid();
  -- expenses: created_by = auth.uid()), which this SECURITY DEFINER bypasses.
  v_seller            uuid;
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF get_role(p_business_id) = 'vendeur' THEN
    v_seller := auth.uid();
  END IF;

  -- Count today — every non-annulée sale dated today (matches
  -- computeLocalKpis: status !== 'annule' AND COALESCE(sale_date,
  -- created_at::date) === today). Credit sales count; they are sales.
  SELECT COUNT(*)::int
  INTO v_sales_today
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status <> 'annule'
    AND COALESCE(sale_date, created_at::date) = v_today;

  -- Revenue today — only cash (non-credit) sales, same local formula
  -- (todaySales.filter(s => !s.is_credit)).
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_today
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status <> 'annule'
    AND COALESCE(sale_date, created_at::date) = v_today
    AND NOT is_credit;

  -- Revenue yesterday
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_yesterday
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status      = 'paye'
    AND paid_at    >= v_yest_ts
    AND paid_at     < v_today_ts;

  -- Revenue this month
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_month
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status      = 'paye'
    AND paid_at    >= v_month_ts;

  -- [v240] Revenue LAST calendar month — same formula and same vendeur
  -- narrowing as revenue_month, over [start of previous month, start of this
  -- month). The home shows a "Ce mois" line only when this month is strictly
  -- ahead of it.
  SELECT COALESCE(SUM(total_amount - COALESCE(discount_amount, 0)), 0)
  INTO v_revenue_last_month
  FROM sale_orders
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR seller_id = v_seller)
    AND status      = 'paye'
    AND paid_at    >= v_prev_month_ts
    AND paid_at     < v_month_ts;

  -- Lifetime — the business's very first real sale ever, regardless of
  -- month/today. NULL if it has never made one.
  SELECT MIN(paid_at) INTO v_first_sale_at
  FROM sale_orders
  WHERE business_id = p_business_id
    AND status      = 'paye';

  -- Credit total (remaining owed) + distinct debtor count
  WITH paid_per_order AS (
    SELECT p.order_id, SUM(p.amount) AS total_paid
    FROM payments p
    WHERE p.order_id IN (
      SELECT id FROM sale_orders
      WHERE business_id = p_business_id AND status = 'credit'
        AND (v_seller IS NULL OR seller_id = v_seller)
    )
    GROUP BY p.order_id
  ),
  credit_remaining AS (
    SELECT
      so.customer_name,
      (so.total_amount
        - COALESCE(so.discount_amount, 0)
        - COALESCE(ppo.total_paid, 0)) AS remaining
    FROM sale_orders so
    LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
    WHERE so.business_id = p_business_id
      AND so.status      = 'credit'
      AND (v_seller IS NULL OR so.seller_id = v_seller)
  )
  SELECT
    COALESCE(SUM(GREATEST(0, remaining)), 0),
    COUNT(DISTINCT customer_name) FILTER (WHERE customer_name IS NOT NULL AND remaining > 1)
    + COUNT(*)                    FILTER (WHERE customer_name IS NULL     AND remaining > 1)
  INTO v_credit_total, v_credit_count
  FROM credit_remaining;

  -- Approved expenses this month
  SELECT COALESCE(SUM(amount), 0)
  INTO v_expenses_month
  FROM expenses_visible
  WHERE business_id = p_business_id
    AND (v_seller IS NULL OR created_by = v_seller)
    AND status      = 'approuve'
    AND date       >= v_month_start;

  -- Low-stock count
  SELECT COUNT(*) INTO v_low_stock FROM (
    SELECT id FROM products
    WHERE business_id  = p_business_id
      AND NOT archived
      AND NOT has_variants
      AND reorder_level > 0
      AND stock_qty    <= reorder_level
    UNION ALL
    SELECT pv.id FROM product_variants pv
    WHERE pv.business_id = p_business_id
      AND NOT pv.archived
      AND pv.reorder_level > 0
      AND pv.stock_qty    <= pv.reorder_level
  ) sub;

  RETURN jsonb_build_object(
    'revenue_today',     v_revenue_today,
    'revenue_yesterday', v_revenue_yesterday,
    'revenue_month',     v_revenue_month,
    'revenue_last_month', v_revenue_last_month,
    'sales_today',       v_sales_today,
    'credit_total',      v_credit_total,
    'credit_count',      v_credit_count,
    'expenses_month',    v_expenses_month,
    'low_stock',         v_low_stock,
    'first_sale_at',     v_first_sale_at
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_kpis(uuid, date, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_dashboard_kpis(uuid, date, text) FROM PUBLIC, anon;
