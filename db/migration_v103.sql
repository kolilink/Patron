-- ============================================================
-- Patron — Migration v103
-- Run in Supabase SQL Editor AFTER migration_v102
--
-- Adds get_financial_snapshot(): an independent, ground-truth
-- recompute of revenue / COGS / expenses / net profit, straight
-- from the ledger tables (sale_orders, so_lines, expenses) —
-- bypassing every app-side formula entirely. Used by the nightly
-- send-reconciliation-report Edge Function to include a trustworthy
-- reference snapshot in the email, separate from the 68 structural
-- integrity checks in run_reconciliation().
--
-- Grouped by business currency (NOT a single blended total) —
-- the platform has businesses in GNF, USD, XOF, EUR, MAD and CNY;
-- summing across currencies would itself be a miscalculation.
-- Currencies with zero activity in both windows are omitted to
-- keep the email short.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_financial_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today       date := CURRENT_DATE;
  v_month_start date := date_trunc('month', v_today)::date;
  v_result      jsonb;
BEGIN
  WITH currencies AS (
    SELECT DISTINCT currency FROM businesses
  ),
  today_rev AS (
    SELECT b.currency, SUM(so.total_amount - so.discount_amount) AS revenue
    FROM sale_orders so JOIN businesses b ON b.id = so.business_id
    WHERE so.status IN ('paye','credit') AND so.created_at >= v_today
    GROUP BY b.currency
  ),
  today_cogs AS (
    SELECT b.currency, SUM(sl.qty * COALESCE(sl.cost_price_at_sale,0)) AS cogs
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    JOIN businesses b   ON b.id  = so.business_id
    WHERE so.status IN ('paye','credit') AND so.created_at >= v_today
    GROUP BY b.currency
  ),
  today_exp AS (
    SELECT b.currency, SUM(e.amount) AS expenses
    FROM expenses e JOIN businesses b ON b.id = e.business_id
    WHERE e.status = 'approuve' AND e.date >= v_today
    GROUP BY b.currency
  ),
  month_rev AS (
    SELECT b.currency, SUM(so.total_amount - so.discount_amount) AS revenue
    FROM sale_orders so JOIN businesses b ON b.id = so.business_id
    WHERE so.status IN ('paye','credit') AND so.created_at >= v_month_start
    GROUP BY b.currency
  ),
  month_cogs AS (
    SELECT b.currency, SUM(sl.qty * COALESCE(sl.cost_price_at_sale,0)) AS cogs
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    JOIN businesses b   ON b.id  = so.business_id
    WHERE so.status IN ('paye','credit') AND so.created_at >= v_month_start
    GROUP BY b.currency
  ),
  month_exp AS (
    SELECT b.currency, SUM(e.amount) AS expenses
    FROM expenses e JOIN businesses b ON b.id = e.business_id
    WHERE e.status = 'approuve' AND e.date >= v_month_start
    GROUP BY b.currency
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'currency', c.currency,
      'today', jsonb_build_object(
        'revenue',    COALESCE(tr.revenue, 0),
        'cogs',       COALESCE(tc.cogs, 0),
        'expenses',   COALESCE(te.expenses, 0),
        'net_profit', COALESCE(tr.revenue, 0) - COALESCE(tc.cogs, 0) - COALESCE(te.expenses, 0)
      ),
      'month_to_date', jsonb_build_object(
        'revenue',    COALESCE(mr.revenue, 0),
        'cogs',       COALESCE(mc.cogs, 0),
        'expenses',   COALESCE(me.expenses, 0),
        'net_profit', COALESCE(mr.revenue, 0) - COALESCE(mc.cogs, 0) - COALESCE(me.expenses, 0)
      )
    )
    ORDER BY COALESCE(mr.revenue, 0) DESC
  )
  INTO v_result
  FROM currencies c
  LEFT JOIN today_rev  tr ON tr.currency = c.currency
  LEFT JOIN today_cogs tc ON tc.currency = c.currency
  LEFT JOIN today_exp  te ON te.currency = c.currency
  LEFT JOIN month_rev  mr ON mr.currency = c.currency
  LEFT JOIN month_cogs mc ON mc.currency = c.currency
  LEFT JOIN month_exp  me ON me.currency = c.currency
  WHERE COALESCE(mr.revenue, 0) != 0 OR COALESCE(tr.revenue, 0) != 0;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_financial_snapshot() TO service_role;
