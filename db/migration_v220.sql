-- ============================================================
-- Patron — Migration v220
-- Run in Supabase SQL Editor AFTER migration_v219
--
-- SWEEP FIX — Phase 1.2: "Bénéfice cumulé" fiction with missing
-- costs (app/(app)/rapports/index.tsx:552).
--
-- Problem
-- -------
-- get_period_report (v162, the latest version) computes profit as
--     v_net_profit := v_revenue - v_cogs - v_stock_losses - v_oper_expenses
-- where v_revenue counts EVERY paye/credit order's full total, while
-- v_cogs only sums lines whose cost_price_at_sale IS NOT NULL.
-- A sale recorded without a purchase cost (quick-sale "Vente rapide",
-- the "Solde reporté" carnet placeholder, or a product that had no
-- cost at sale time) therefore contributes its FULL revenue to profit
-- with zero cost offset — the hero number is overstated, silently.
--
-- Fix
-- ---
-- 1. Count the distinct orders in the period that contain at least one
--    line with cost_price_at_sale IS NULL, exposed as `sales_without_cost`.
-- 2. Subtract the line-level revenue of those unknown-cost lines from
--    v_net_profit, so profit only ever reflects lines with a real cost.
--    (Line-level revenue is SUM(qty * unit_price) — the same unit_price
--    v107 guarantees is always the real price charged.)
--
-- Superset rule: this carries the FULL latest get_period_report body
-- from v162 (verified to be the only/latest definition) and only adds
-- the new field + the profit adjustment. The v162 index on
-- sale_orders(business_id, sale_date) already exists and is untouched.
-- ============================================================

CREATE OR REPLACE FUNCTION get_period_report(
  p_business_id   uuid,
  p_period_start  date,
  p_period_end    date,
  p_role          text,
  p_user_id       uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role    text;
  v_user_id uuid;

  -- Admin / manager / investisseur
  v_revenue             bigint  := 0;
  v_cogs                bigint  := 0;
  v_unknown_cost_revenue bigint := 0;  -- v220: revenue of lines without a purchase cost
  v_sales_without_cost  int     := 0;  -- v220: distinct orders with ≥1 unknown-cost line
  v_stock_losses        bigint  := 0;
  v_oper_expenses       bigint  := 0;
  v_net_profit          bigint  := 0;
  v_sales_count         int     := 0;
  v_units_sold          numeric := 0;
  v_credit_outstanding  bigint  := 0;
  v_credit_count        int     := 0;
  v_cash_on_hand        bigint  := 0;
  v_daily               jsonb   := '[]'::jsonb;

  -- Vendeur
  v_my_sales_count    int     := 0;
  v_my_units_sold     numeric := 0;
  v_my_credit_pending bigint  := 0;
  v_my_credit_count   int     := 0;
  v_my_daily          jsonb   := '[]'::jsonb;

  -- Investisseur
  v_investor_balance  bigint := 0;
  v_my_total_invested bigint := 0;
BEGIN
  IF p_period_end < p_period_start THEN
    RAISE EXCEPTION 'Période invalide' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_role    := get_role(p_business_id);
    v_user_id := auth.uid();
  ELSE
    v_role    := p_role;
    v_user_id := p_user_id;
  END IF;

  -- ── Admin / manager / investisseur ──────────────────────────────────────

  IF v_role IN ('administrateur', 'manager', 'investisseur') THEN

    SELECT
      COALESCE(SUM(so.total_amount - COALESCE(so.discount_amount, 0)), 0),
      COUNT(*)::int
    INTO v_revenue, v_sales_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end;

    SELECT COALESCE(SUM(sl.qty), 0)
    INTO v_units_sold
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end;

    SELECT COALESCE(SUM(sl.qty * sl.cost_price_at_sale), 0)
    INTO v_cogs
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end
      AND sl.cost_price_at_sale IS NOT NULL;

    -- v220 — unknown-cost lines: their revenue currently lands fully in
    -- profit (v_cogs skips them), which overstates Bénéfice cumulé. Compute
    -- both their line-level revenue (to subtract from profit) and the number
    -- of distinct orders affected (to show the caveat on screen).
    SELECT
      COALESCE(SUM(sl.qty * sl.unit_price), 0),
      COUNT(DISTINCT so.id)::int
    INTO v_unknown_cost_revenue, v_sales_without_cost
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end
      AND sl.cost_price_at_sale IS NULL;

    SELECT COALESCE(SUM(sm.qty * COALESCE(p.cost_price, 0)), 0)
    INTO v_stock_losses
    FROM stock_moves sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.business_id = p_business_id
      AND sm.type = 'perte'
      AND sm.created_at::date >= p_period_start
      AND sm.created_at::date <= p_period_end;

    SELECT COALESCE(SUM(e.amount), 0)
    INTO v_oper_expenses
    FROM expenses e
    WHERE e.business_id = p_business_id
      AND e.status = 'approuve'
      AND (e.category IS NULL OR e.category <> 'transport_achat')
      AND e.date >= p_period_start
      AND e.date <= p_period_end;

    -- v220: exclude unknown-cost revenue so profit only reflects lines with
    -- a real purchase cost.
    v_net_profit := v_revenue - v_cogs - v_unknown_cost_revenue - v_stock_losses - v_oper_expenses;

    -- Credit outstanding ("dettes clients") — all-time live balance, not
    -- period-bound, same semantics as get_reports_snapshot.
    WITH paid_per_order AS (
      SELECT p.order_id, SUM(p.amount) AS total_paid
      FROM payments p
      INNER JOIN sale_orders so ON so.id = p.order_id
      WHERE so.business_id = p_business_id AND so.status = 'credit'
      GROUP BY p.order_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0,
        so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
      )), 0),
      COUNT(*) FILTER (WHERE
        GREATEST(0,
          so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
        ) > 100
      )::int
    INTO v_credit_outstanding, v_credit_count
    FROM sale_orders so
    LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
    WHERE so.business_id = p_business_id AND so.status = 'credit';

    -- Cash on hand — all-time position, identical formula to get_reports_snapshot.
    SELECT
      COALESCE((SELECT SUM(amount)         FROM payments             WHERE business_id = p_business_id), 0)
      + COALESCE((SELECT SUM(amount)       FROM capital_injections   WHERE business_id = p_business_id), 0)
      - COALESCE((SELECT SUM(amount)       FROM expenses WHERE business_id = p_business_id AND status = 'approuve'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM supplier_payments    WHERE business_id = p_business_id), 0)
      - COALESCE((SELECT SUM(paid_amount)  FROM investor_payouts     WHERE business_id = p_business_id AND status = 'paye'), 0)
    INTO v_cash_on_hand;

    -- Daily heatmap series — amount/sales_count from sale_orders alone
    -- (no line join, so no fan-out risk), units_sold from a *separate*
    -- so_lines-joined subquery, merged back on the date. See header note.
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'date',        gs.day::date::text,
        'amount',      COALESCE(rev.day_amount, 0),
        'sales_count', COALESCE(rev.day_sales, 0),
        'units_sold',  COALESCE(units.day_units, 0)
      ) ORDER BY gs.day
    ), '[]'::jsonb)
    INTO v_daily
    FROM generate_series(p_period_start, p_period_end, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT
        so.sale_date                                            AS day,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))  AS day_amount,
        COUNT(*)                                                 AS day_sales
      FROM sale_orders so
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_period_start
        AND so.sale_date <= p_period_end
      GROUP BY so.sale_date
    ) rev ON rev.day = gs.day::date
    LEFT JOIN (
      SELECT so.sale_date AS day, SUM(sl.qty) AS day_units
      FROM so_lines sl
      JOIN sale_orders so ON so.id = sl.order_id
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_period_start
        AND so.sale_date <= p_period_end
      GROUP BY so.sale_date
    ) units ON units.day = gs.day::date;

  END IF;

  -- ── Vendeur personal stats ─────────────────────────────────────────────

  IF v_role = 'vendeur' THEN

    SELECT COUNT(*)::int
    INTO v_my_sales_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end;

    SELECT COALESCE(SUM(sl.qty), 0)
    INTO v_my_units_sold
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= p_period_start
      AND so.sale_date <= p_period_end;

    WITH paid_per_order AS (
      SELECT p.order_id, SUM(p.amount) AS total_paid
      FROM payments p
      INNER JOIN sale_orders so ON so.id = p.order_id
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status = 'credit'
      GROUP BY p.order_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0,
        so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
      )), 0),
      COUNT(*) FILTER (WHERE
        GREATEST(0,
          so.total_amount - COALESCE(so.discount_amount, 0) - COALESCE(ppo.total_paid, 0)
        ) > 100
      )::int
    INTO v_my_credit_pending, v_my_credit_count
    FROM sale_orders so
    LEFT JOIN paid_per_order ppo ON ppo.order_id = so.id
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status = 'credit';

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'date',        gs.day::date::text,
        'amount',      COALESCE(rev.day_amount, 0),
        'sales_count', COALESCE(rev.day_sales, 0),
        'units_sold',  COALESCE(units.day_units, 0)
      ) ORDER BY gs.day
    ), '[]'::jsonb)
    INTO v_my_daily
    FROM generate_series(p_period_start, p_period_end, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT
        so.sale_date                                            AS day,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))  AS day_amount,
        COUNT(*)                                                 AS day_sales
      FROM sale_orders so
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_period_start
        AND so.sale_date <= p_period_end
      GROUP BY so.sale_date
    ) rev ON rev.day = gs.day::date
    LEFT JOIN (
      SELECT so.sale_date AS day, SUM(sl.qty) AS day_units
      FROM so_lines sl
      JOIN sale_orders so ON so.id = sl.order_id
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= p_period_start
        AND so.sale_date <= p_period_end
      GROUP BY so.sale_date
    ) units ON units.day = gs.day::date;

  END IF;

  -- ── Investisseur personal stats ─────────────────────────────────────────

  IF v_role = 'investisseur' THEN

    SELECT COALESCE(balance, 0)
    INTO v_investor_balance
    FROM investor_balance
    WHERE business_id = p_business_id AND investor_id = v_user_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_my_total_invested
    FROM capital_injections
    WHERE business_id    = p_business_id
      AND injected_by_id = v_user_id;

  END IF;

  RETURN jsonb_build_object(
    'role',               v_role,
    'period_start',       p_period_start::text,
    'period_end',         p_period_end::text,
    -- Shared (admin/manager/investisseur)
    'cash_on_hand',       v_cash_on_hand,
    'net_profit',         v_net_profit,
    'sales_count',        v_sales_count,
    'units_sold',         v_units_sold,
    'sales_without_cost', v_sales_without_cost,   -- v220
    'credit_outstanding', v_credit_outstanding,
    'credit_count',       v_credit_count,
    'daily',              v_daily,
    -- Vendeur
    'my_sales_count',     v_my_sales_count,
    'my_units_sold',      v_my_units_sold,
    'my_credit_pending',  v_my_credit_pending,
    'my_credit_count',    v_my_credit_count,
    'my_daily',           v_my_daily,
    -- Investisseur
    'investor_balance',   v_investor_balance,
    'my_total_invested',  v_my_total_invested
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_period_report(uuid, date, date, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_period_report(uuid, date, date, text, uuid) TO service_role;
