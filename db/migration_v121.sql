-- ============================================================
-- Patron — Migration v121
-- Run in Supabase SQL Editor AFTER migration_v120
--
-- Security fix: get_reports_snapshot() only checked that the caller
-- is a member of p_business_id — it never verified that the caller
-- actually holds p_role, nor that p_user_id is the caller's own id.
-- Both are ordinary RPC parameters, so any member could call:
--
--   supabase.rpc('get_reports_snapshot', {
--     p_business_id, p_period_days: 30, p_role: 'administrateur', p_today
--   })
--
-- and receive full business financials (revenue, COGS, profit, cash
-- on hand, stock value, top sellers) regardless of their real role,
-- or pass a teammate's p_user_id to read that teammate's personal
-- sales/investor figures.
--
-- Fix: for any authenticated caller (auth.uid() IS NOT NULL), the
-- role and user id are now derived server-side via get_role() and
-- auth.uid() — the caller-supplied p_role/p_user_id are ignored.
-- The service-role internal-reconciliation path (auth.uid() IS NULL)
-- is unaffected and still trusts its own parameters, since it has no
-- membership/role of its own to derive from.
-- ============================================================

CREATE OR REPLACE FUNCTION get_reports_snapshot(
  p_business_id uuid,
  p_period_days int,
  p_role        text,
  p_user_id     uuid    DEFAULT NULL,
  p_today       date    DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period_start date := p_today - p_period_days;

  -- Server-derived role/identity — never trust p_role/p_user_id directly
  -- for an authenticated caller (see fix note above).
  v_role               text;
  v_user_id            uuid;

  -- Admin / manager / investisseur
  v_revenue            bigint := 0;
  v_cogs               bigint := 0;
  v_stock_losses       bigint := 0;
  v_gross_profit       bigint := 0;
  v_oper_expenses      bigint := 0;
  v_shipping_exp       bigint := 0;
  v_net_profit         bigint := 0;
  v_credit_outstanding bigint := 0;
  v_credit_count       int    := 0;
  v_order_count        int    := 0;
  v_cash_on_hand       bigint := 0;
  v_stock_value        bigint := 0;
  v_total_apports      bigint := 0;
  v_period_apports     bigint := 0;
  v_activity           jsonb  := '[]'::jsonb;
  v_top_sellers        jsonb  := '[]'::jsonb;

  -- Vendeur
  v_my_revenue         bigint := 0;
  v_my_sales_count     int    := 0;
  v_my_credit_pending  bigint := 0;
  v_my_credit_count    int    := 0;
  v_my_activity        jsonb  := '[]'::jsonb;

  -- Investisseur
  v_investor_balance   bigint := 0;
  v_my_total_invested  bigint := 0;
  v_my_period_apports  bigint := 0;
BEGIN
  -- Authenticated users must be members of the business.
  -- Service role (auth.uid() = NULL) may call this for internal reconciliation.
  IF auth.uid() IS NOT NULL AND NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    -- Real user session: derive role/identity server-side. p_role/p_user_id
    -- as supplied by the client are ignored from here on.
    v_role    := get_role(p_business_id);
    v_user_id := auth.uid();
  ELSE
    -- Service-role call (nightly reconciliation etc.) — no membership/role
    -- of its own to derive from, so trust its own parameters as before.
    v_role    := p_role;
    v_user_id := p_user_id;
  END IF;

  -- ── Admin / manager / investisseur shared metrics ──────────────────────────

  IF v_role IN ('administrateur', 'manager', 'investisseur') THEN

    -- Revenue: earned when the sale was made (sale_date), not when cash arrived.
    -- Includes cash sales (paye) and unpaid credit sales (credit).
    SELECT
      COALESCE(SUM(so.total_amount - COALESCE(so.discount_amount, 0)), 0),
      COUNT(DISTINCT so.id)::int
    INTO v_revenue, v_order_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= v_period_start
      AND so.sale_date <= p_today;

    -- COGS: snapshotted cost at sale time (shipping already baked in via AVCO).
    -- Pre-v81 rows with NULL cost_price_at_sale are excluded (approximation risk).
    SELECT COALESCE(SUM(sl.qty * sl.cost_price_at_sale), 0)
    INTO v_cogs
    FROM so_lines sl
    JOIN sale_orders so ON so.id = sl.order_id
    WHERE so.business_id = p_business_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= v_period_start
      AND so.sale_date <= p_today
      AND sl.cost_price_at_sale IS NOT NULL;

    -- Stock losses: cost of units marked perte in the period.
    -- Uses current cost_price (no historical snapshot for losses).
    -- stock_moves is always product-level (no variant_id column exists there).
    SELECT COALESCE(SUM(
      sm.qty * COALESCE(p.cost_price, 0)
    ), 0)
    INTO v_stock_losses
    FROM stock_moves sm
    JOIN products p ON p.id = sm.product_id
    WHERE sm.business_id = p_business_id
      AND sm.type = 'perte'
      AND sm.created_at::date >= v_period_start
      AND sm.created_at::date <= p_today;

    -- Operating expenses in period.
    -- transport_achat excluded: already absorbed into cost_price via AVCO.
    SELECT COALESCE(SUM(e.amount), 0)
    INTO v_oper_expenses
    FROM expenses e
    WHERE e.business_id = p_business_id
      AND e.status = 'approuve'
      AND (e.category IS NULL OR e.category <> 'transport_achat')
      AND e.date >= v_period_start
      AND e.date <= p_today;

    -- Shipping expenses shown as a separate informational line.
    -- NOT deducted from net_profit (already in COGS via AVCO).
    SELECT COALESCE(SUM(e.amount), 0)
    INTO v_shipping_exp
    FROM expenses e
    WHERE e.business_id = p_business_id
      AND e.status = 'approuve'
      AND e.category = 'transport_achat'
      AND e.date >= v_period_start
      AND e.date <= p_today;

    v_gross_profit := v_revenue - v_cogs - v_stock_losses;
    v_net_profit   := v_gross_profit - v_oper_expenses;

    -- Credit outstanding (all-time, not period-specific).
    WITH paid_per_order AS (
      SELECT p.order_id, SUM(p.amount) AS total_paid
      FROM payments p
      INNER JOIN sale_orders so ON so.id = p.order_id
      WHERE so.business_id = p_business_id AND so.status = 'credit'
      GROUP BY p.order_id
    )
    SELECT
      COALESCE(SUM(GREATEST(0,
        so.total_amount - COALESCE(so.discount_amount, 0)
        - COALESCE(ppo.total_paid, 0)
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

    -- Cash on hand: all-time position.
    -- = cash collected from sales (payments table)
    -- + capital injected by owners/investors
    -- − all approved expenses
    -- − supplier debt payments actually made
    -- − investor profit payouts confirmed
    SELECT
      COALESCE((SELECT SUM(amount)       FROM payments           WHERE business_id = p_business_id), 0)
      + COALESCE((SELECT SUM(amount)     FROM capital_injections WHERE business_id = p_business_id), 0)
      - COALESCE((SELECT SUM(amount)     FROM expenses WHERE business_id = p_business_id AND status = 'approuve'), 0)
      - COALESCE((SELECT SUM(amount_cents) FROM supplier_payments WHERE business_id = p_business_id), 0)
      - COALESCE((SELECT SUM(paid_amount)  FROM investor_payouts  WHERE business_id = p_business_id AND status = 'paye'), 0)
    INTO v_cash_on_hand;

    -- Current inventory value: cost_price × stock_qty across all active products.
    SELECT
      COALESCE(SUM(CASE WHEN NOT has_variants THEN cost_price * stock_qty ELSE 0 END), 0)
      + COALESCE((
          SELECT SUM(pv.cost_price * pv.stock_qty)
          FROM product_variants pv
          WHERE pv.business_id = p_business_id AND NOT pv.archived AND pv.stock_qty > 0
        ), 0)
    INTO v_stock_value
    FROM products
    WHERE business_id = p_business_id AND NOT archived;

    -- Capital injections: all-time and within period.
    SELECT COALESCE(SUM(amount), 0)
    INTO v_total_apports
    FROM capital_injections
    WHERE business_id = p_business_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_period_apports
    FROM capital_injections
    WHERE business_id = p_business_id
      AND injected_at::date >= v_period_start
      AND injected_at::date <= p_today;

    -- Activity chart: daily revenue by sale_date (for all periods).
    -- Frontend is responsible for bucketing daily data into weekly groups
    -- for the trimestre view — that is display logic, not financial math.
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('date', gs.day::date::text, 'amount', COALESCE(daily.day_amount, 0))
      ORDER BY gs.day
    ), '[]'::jsonb)
    INTO v_activity
    FROM generate_series(v_period_start, p_today, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT
        so.sale_date                                                     AS day,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))          AS day_amount
      FROM sale_orders so
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= v_period_start
        AND so.sale_date <= p_today
      GROUP BY so.sale_date
    ) daily ON daily.day = gs.day::date;

    -- Top sellers leaderboard: revenue by seller in period (max 5).
    -- Name resolution mirrors stores/ventes.ts: membership display_name
    -- override, then profile name, then a generic fallback label.
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('name', lb.seller_name, 'revenue', lb.seller_rev, 'count', lb.sale_count)
      ORDER BY lb.seller_rev DESC
    ), '[]'::jsonb)
    INTO v_top_sellers
    FROM (
      SELECT
        COALESCE(m.display_name, pr.name, 'Vendeur')            AS seller_name,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0)) AS seller_rev,
        COUNT(*)::int                                           AS sale_count
      FROM sale_orders so
      LEFT JOIN memberships m ON m.business_id = so.business_id AND m.user_id = so.seller_id
      LEFT JOIN profiles    pr ON pr.id = so.seller_id
      WHERE so.business_id = p_business_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= v_period_start
        AND so.sale_date <= p_today
      GROUP BY so.seller_id, COALESCE(m.display_name, pr.name, 'Vendeur')
      ORDER BY seller_rev DESC
      LIMIT 5
    ) lb;

  END IF;

  -- ── Vendeur personal stats ─────────────────────────────────────────────────

  IF v_role = 'vendeur' THEN

    SELECT
      COALESCE(SUM(so.total_amount - COALESCE(so.discount_amount, 0)), 0),
      COUNT(*)::int
    INTO v_my_revenue, v_my_sales_count
    FROM sale_orders so
    WHERE so.business_id = p_business_id
      AND so.seller_id   = v_user_id
      AND so.status IN ('paye', 'credit')
      AND so.sale_date >= v_period_start
      AND so.sale_date <= p_today;

    -- Personal credit outstanding (active credit sales by this seller).
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

    -- Personal activity chart (daily, by sale_date).
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object('date', gs.day::date::text, 'amount', COALESCE(daily.day_amount, 0))
      ORDER BY gs.day
    ), '[]'::jsonb)
    INTO v_my_activity
    FROM generate_series(v_period_start, p_today, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT
        so.sale_date                                                     AS day,
        SUM(so.total_amount - COALESCE(so.discount_amount, 0))          AS day_amount
      FROM sale_orders so
      WHERE so.business_id = p_business_id
        AND so.seller_id   = v_user_id
        AND so.status IN ('paye', 'credit')
        AND so.sale_date >= v_period_start
        AND so.sale_date <= p_today
      GROUP BY so.sale_date
    ) daily ON daily.day = gs.day::date;

  END IF;

  -- ── Investisseur personal stats ────────────────────────────────────────────

  IF v_role = 'investisseur' THEN

    SELECT COALESCE(balance, 0)
    INTO v_investor_balance
    FROM investor_balance
    WHERE business_id = p_business_id AND investor_id = v_user_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_my_total_invested
    FROM capital_injections
    WHERE business_id  = p_business_id
      AND injected_by_id = v_user_id;

    SELECT COALESCE(SUM(amount), 0)
    INTO v_my_period_apports
    FROM capital_injections
    WHERE business_id  = p_business_id
      AND injected_by_id = v_user_id
      AND injected_at::date >= v_period_start
      AND injected_at::date <= p_today;

  END IF;

  RETURN jsonb_build_object(
    'role',               v_role,
    'period_days',        p_period_days,
    'period_start',       v_period_start::text,
    -- Shared (admin/manager/investisseur)
    'revenue',            v_revenue,
    'cogs',               v_cogs,
    'stock_losses',       v_stock_losses,
    'gross_profit',       v_gross_profit,
    'operating_expenses', v_oper_expenses,
    'shipping_expenses',  v_shipping_exp,
    'net_profit',         v_net_profit,
    'credit_outstanding', v_credit_outstanding,
    'credit_count',       v_credit_count,
    'period_order_count', v_order_count,
    'cash_on_hand',       v_cash_on_hand,
    'stock_value',        v_stock_value,
    'total_apports',      v_total_apports,
    'period_apports',     v_period_apports,
    'activity',           v_activity,
    'top_sellers',        v_top_sellers,
    -- Vendeur
    'my_revenue',         v_my_revenue,
    'my_sales_count',     v_my_sales_count,
    'my_credit_pending',  v_my_credit_pending,
    'my_credit_count',    v_my_credit_count,
    'my_activity',        v_my_activity,
    -- Investisseur
    'investor_balance',   v_investor_balance,
    'my_total_invested',  v_my_total_invested,
    'my_period_apports',  v_my_period_apports
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_reports_snapshot(uuid, int, text, uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_reports_snapshot(uuid, int, text, uuid, date) TO service_role;
