-- ============================================================
-- Patron — Migration v204
-- Run in Supabase SQL Editor AFTER migration_v203
--
-- §9 of the offline-first rewrite: two additive, founder/observability-only
-- pieces, "no UI" per the approved plan (the actual UI for these is
-- deliberately deferred to Phase 1.5).
--
-- §9a — staleness proxy. The server can never see an item still sitting
-- in a device's local SQLite outbox (that's the whole point of local-
-- first) — so "oldest pending item" isn't a thing the server can compute
-- directly. What IS computable, with zero client cooperation, is "how
-- long since we last heard from this business at all" — a real, useful
-- stuck-detector: get_business_sync_staleness() returns every real
-- (phone-verified, non-demo — same filter migration_v175.sql already
-- established for founder-facing metrics) business's most recent
-- sale_orders.created_at, oldest-first. A business that should be active
-- but hasn't produced a single synced sale in days is worth a founder's
-- attention regardless of whether that's a connectivity problem, a churn
-- signal, or something else — this doesn't try to distinguish those, it's
-- a proxy, not a diagnosis.
--
-- §9b — threaded queued_at, logged server-side on landing. Deliberately
-- NOT implemented by adding a p_queued_at parameter to the five already-
-- verified Phase-1 RPCs (submit_sale/submit_carnet_debt/submit_quick_sale/
-- cancel_sale/record_client_payment) — each was just individually
-- re-verified against the real live database (idempotency guards
-- confirmed intact, submit_sale in particular has documented history of
-- this exact class of regression across rewrites) and touching their
-- signatures again for a purely observational feature is unjustified risk
-- for zero business-logic benefit. Instead: one new, independent,
-- minimal RPC, log_sync_lag(), called by the client (lib/sync.ts) right
-- after each successful drain — same durable, Postgres-backed signal
-- (median/p99 sync lag per business, the "quantitative proof this project
-- worked" the approved plan asks for), zero risk to the money-handling
-- RPCs it's measuring.
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_lag_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  operation    text NOT NULL,
  queued_at    timestamptz NOT NULL,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  lag_seconds  numeric NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_lag_log_business_id_idx ON sync_lag_log (business_id, synced_at);

-- No client-facing RLS policy — this table is written only through
-- log_sync_lag() below and read only through the founder-facing RPCs
-- this migration would add in Phase 1.5's UI pass (not this migration —
-- "no UI" per the approved scope). Same posture as djomi_pending_payments/
-- support_ai_drafts/record_client_payment_idempotency_keys elsewhere in
-- this schema.
ALTER TABLE sync_lag_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sync_lag_log FROM PUBLIC, anon, authenticated;

-- p_queued_at is the client's own sync_queue.queued_at for the item that
-- just synced (lib/db.ts, §1) — a plain client-supplied timestamp, not
-- independently verified against anything server-side, since this is a
-- telemetry signal, not a security- or money-relevant one; a device with a
-- wrong clock just produces a wrong (and self-evidently implausible, if
-- negative) lag value, nothing more.
CREATE OR REPLACE FUNCTION log_sync_lag(
  p_business_id uuid,
  p_operation   text,
  p_queued_at   timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_member(p_business_id) THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO sync_lag_log (business_id, operation, queued_at, lag_seconds)
  VALUES (p_business_id, p_operation, p_queued_at, EXTRACT(EPOCH FROM (now() - p_queued_at)));
END;
$$;

REVOKE ALL ON FUNCTION log_sync_lag(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION log_sync_lag(uuid, text, timestamptz) TO authenticated;

-- §9a: staleness proxy, founder-gated (is_founder(), same as every other
-- founder-only RPC in this schema — see "Support chat"/"Founder Dashboard"
-- in CLAUDE.md for the established pattern). Excludes demo/anonymous
-- businesses the same way migration_v175.sql's growth_metrics view does
-- (a phone-verified creator), so seed-demo-business's fake sales never
-- pollute this list. Returns every real business ordered oldest-last-sale-
-- first — the ones most worth a founder's attention are at the top.
CREATE OR REPLACE FUNCTION get_business_sync_staleness()
RETURNS TABLE (
  business_id       uuid,
  business_name     text,
  last_sale_at      timestamptz,
  days_since_last_sale numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_founder() THEN
    RAISE EXCEPTION 'Accès refusé' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  SELECT
    b.id,
    b.name,
    MAX(so.created_at),
    EXTRACT(EPOCH FROM (now() - MAX(so.created_at))) / 86400
  FROM businesses b
  JOIN profiles p ON p.id = b.created_by
  LEFT JOIN sale_orders so ON so.business_id = b.id AND so.status <> 'annule'
  WHERE p.phone IS NOT NULL AND p.phone <> ''
  GROUP BY b.id, b.name
  ORDER BY MAX(so.created_at) ASC NULLS FIRST;
END;
$$;

REVOKE ALL ON FUNCTION get_business_sync_staleness() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_business_sync_staleness() TO authenticated;
