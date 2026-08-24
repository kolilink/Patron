-- ============================================================
-- Patron — Migration v165
-- Run in Supabase SQL Editor AFTER migration_v164
--
-- Revenue milestone reminder — the "part of something extraordinary" touch.
-- Deliberately achievement-based, not calendar-based: celebrating "you've
-- been registered for 30 days" celebrates something that just happened to
-- a merchant; celebrating "you've sold 10,000,000 GNF on Patron" celebrates
-- something they actually did. Fires once per threshold, ever, the first
-- time a business's real lifetime revenue crosses it.
--
-- Ladder spacing is deliberately widening, not a flat +10M step: 1M, 5M,
-- 10M, 25M, 50M, 100M, 250M, 500M, 1B GNF. Early milestones land close
-- together (a new, active shop can hit the first one or two within weeks —
-- hooking the habit early), later ones space out (so hitting one stays
-- meaningful once a business is established, instead of firing routinely
-- every time revenue ticks up another flat increment).
--
-- Scoped to GNF only, deliberately, not silently: Patron supports other
-- currencies (XOF, XAF, ...), but a flat numeric ladder tuned for GNF's
-- denomination would be wildly wrong for currencies with a very different
-- real value per unit — 1,000,000 XOF is roughly 14x the real value of
-- 1,000,000 GNF. Rather than guess at per-currency thresholds with zero
-- real usage data on those currencies yet, this ships GNF-only and widens
-- later once there's real data to tune against.
--
-- Revenue formula matches get_reports_snapshot's lifetime block exactly
-- (total_amount - discount_amount, status IN ('paye','credit')) — never a
-- new, slightly-different formula; this codebase has already been burned
-- by drifting profit/revenue formulas across screens (see CLAUDE.md's
-- nightly reconciliation notes).

ALTER TABLE businesses ADD COLUMN highest_revenue_milestone_cents bigint NOT NULL DEFAULT 0;

-- Loop-based, not a single set-based query: each business needs its own
-- lifetime SUM compared against its own ratchet, which a per-row loop
-- expresses far more clearly than an array-unnest join for what's a low
-- cardinality of businesses. RETURN NEXT after directly assigning the
-- RETURNS TABLE's own out-parameters (business_id, milestone_cents) — the
-- standard, correct plpgsql idiom, not the same shape as the ambiguous-
-- column risk from migration_v149.sql (there's no SQL query anywhere in
-- this body that references those two names inside a WHERE/SELECT clause).
CREATE OR REPLACE FUNCTION get_and_mark_revenue_milestones()
RETURNS TABLE (business_id uuid, milestone_cents bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ladder bigint[] := ARRAY[
    100000000::bigint,    -- 1,000,000 GNF
    500000000::bigint,    -- 5,000,000 GNF
    1000000000::bigint,   -- 10,000,000 GNF
    2500000000::bigint,   -- 25,000,000 GNF
    5000000000::bigint,   -- 50,000,000 GNF
    10000000000::bigint,  -- 100,000,000 GNF
    25000000000::bigint,  -- 250,000,000 GNF
    50000000000::bigint,  -- 500,000,000 GNF
    100000000000::bigint  -- 1,000,000,000 GNF
  ];
  v_biz record;
  v_revenue bigint;
  v_next bigint;
BEGIN
  FOR v_biz IN
    SELECT b.id, b.highest_revenue_milestone_cents AS ratchet
    FROM businesses b
    WHERE b.currency = 'GNF'
  LOOP
    SELECT COALESCE(SUM(so.total_amount - so.discount_amount), 0)::bigint INTO v_revenue
    FROM sale_orders so
    WHERE so.business_id = v_biz.id AND so.status IN ('paye', 'credit');

    -- Highest threshold crossed since last notified — if revenue jumped
    -- past several thresholds between cron runs, only the highest one
    -- fires (congratulating on 10M implicitly subsumes 1M and 5M; stacking
    -- several congratulation pushes for one moment would just be noise).
    SELECT max(t) INTO v_next
    FROM unnest(v_ladder) AS t
    WHERE t <= v_revenue AND t > v_biz.ratchet;

    IF v_next IS NOT NULL THEN
      UPDATE businesses SET highest_revenue_milestone_cents = v_next WHERE id = v_biz.id;
      business_id := v_biz.id;
      milestone_cents := v_next;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

-- REVOKE ... FROM PUBLIC alone is not enough — see migration_v137.sql for
-- why anon/authenticated need an explicit revoke too on this Supabase stack.
REVOKE EXECUTE ON FUNCTION get_and_mark_revenue_milestones() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_revenue_milestones() TO service_role;
