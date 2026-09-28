-- ============================================================
-- Patron — Migration v161
-- Run in Supabase SQL Editor AFTER migration_v160
--
-- First-24h activation reminders. ActivationForkOverlay (app/(app)/_layout.tsx)
-- already forces a choice — "Un produit" / "Une vente" / "Une dette" — on
-- every screen for any business under 24h old with nothing recorded yet, and
-- that overlay is the real conversion mechanism: once someone is looking at
-- the phone, the fork does the persuading. The one thing it can't do is get
-- someone BACK to the phone if they close the app before finishing. That's
-- the only job these two push notifications have.
--
-- Two nudges, not a drip campaign — mirrors Duolingo's "practice reminder"
-- + "streak saver" shape (a mid-window nudge naming the task, a late-window
-- urgency push), which is the most-cited proven pattern for exactly this
-- kind of forced-choice/time-boxed activation window. Timing is read from
-- app_config (migration_v147.sql's generic key/value table), not hardcoded,
-- so it can be tuned the same way Alpha's quota limits already are — no new
-- migration needed to shift either hour.
--
-- Note on the fork's own completion logic: "Une vente" and "Une dette" both
-- write a sale_orders row (submit_carnet_debt() is just a credit sale under
-- the hood) — so there are really only two independent activation signals,
-- not three: has_product and has_sale_or_debt. The query below checks
-- exactly those two, same as ActivationForkOverlay's own showFork condition.
-- ============================================================

ALTER TABLE businesses ADD COLUMN activation_nudge_1_sent_at timestamptz;
ALTER TABLE businesses ADD COLUMN activation_nudge_2_sent_at timestamptz;

INSERT INTO app_config (key, value) VALUES
  ('activation_nudge_1_hours', 2),
  ('activation_nudge_2_hours', 20)
ON CONFLICT (key) DO NOTHING;

-- Run hourly by the send-activation-reminders cron (migration_v162.sql).
-- Finds every business that is (a) still within its first 24h, (b) has
-- neither a product nor a non-cancelled sale, and (c) has just crossed the
-- nudge-1 or nudge-2 threshold without having been sent that nudge yet —
-- then marks it sent so an overlapping cron run can't double-send. The 24h
-- upper bound matters on its own: without it, a business that's been dead
-- for days would still be "due" for nudge_2 the first time the cron catches
-- up, and that push explicitly claims the fork is about to close — which
-- would be false once it already has.
--
-- Deliberately NOT two data-modifying CTEs in one WITH clause updating the
-- same businesses row (one per nudge) — tried first, and caught only by a
-- live integration test: Postgres's own docs call the outcome of two
-- sibling WITH sub-statements both touching the same row "unpredictable",
-- and in practice a business due for both nudges at once only ever got
-- nudge_1 marked, silently dropping nudge_2. Fixed by computing both id
-- arrays up front, then running the two UPDATEs as ordinary sequential
-- statements (not concurrent CTEs) before returning.
--
-- Column names are deliberately never bare "business_id"/"nudge" (the
-- implicit PL/pgSQL variables RETURNS TABLE creates) anywhere in the body —
-- see migration_v149.sql for the exact ambiguous-column bug this avoids.
CREATE OR REPLACE FUNCTION get_and_mark_activation_reminders()
RETURNS TABLE (business_id uuid, nudge smallint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_nudge1_hours int;
  v_nudge2_hours int;
  v_due1_ids uuid[];
  v_due2_ids uuid[];
BEGIN
  SELECT value INTO v_nudge1_hours FROM app_config WHERE key = 'activation_nudge_1_hours';
  SELECT value INTO v_nudge2_hours FROM app_config WHERE key = 'activation_nudge_2_hours';

  SELECT array_agg(b.id) INTO v_due1_ids
  FROM businesses b
  WHERE now() - b.created_at < interval '24 hours'
    AND b.activation_nudge_1_sent_at IS NULL
    AND now() - b.created_at >= (v_nudge1_hours || ' hours')::interval
    AND NOT EXISTS (SELECT 1 FROM products p WHERE p.business_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.business_id = b.id AND so.status <> 'annule');

  SELECT array_agg(b.id) INTO v_due2_ids
  FROM businesses b
  WHERE now() - b.created_at < interval '24 hours'
    AND b.activation_nudge_2_sent_at IS NULL
    AND now() - b.created_at >= (v_nudge2_hours || ' hours')::interval
    AND NOT EXISTS (SELECT 1 FROM products p WHERE p.business_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM sale_orders so WHERE so.business_id = b.id AND so.status <> 'annule');

  IF v_due1_ids IS NOT NULL THEN
    UPDATE businesses SET activation_nudge_1_sent_at = now() WHERE id = ANY(v_due1_ids);
  END IF;

  IF v_due2_ids IS NOT NULL THEN
    UPDATE businesses SET activation_nudge_2_sent_at = now() WHERE id = ANY(v_due2_ids);
  END IF;

  RETURN QUERY
    SELECT unnest(v_due1_ids), 1::smallint WHERE v_due1_ids IS NOT NULL
  UNION ALL
    SELECT unnest(v_due2_ids), 2::smallint WHERE v_due2_ids IS NOT NULL;
END;
$$;

-- Only the send-activation-reminders cron job (service role) should ever
-- call this — it silently marks rows as sent, so a regular caller could
-- make a real business miss its own reminder.
-- REVOKE ... FROM PUBLIC alone is not enough — see migration_v137.sql for
-- why anon/authenticated need an explicit revoke too on this Supabase stack.
REVOKE EXECUTE ON FUNCTION get_and_mark_activation_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_and_mark_activation_reminders() TO service_role;
